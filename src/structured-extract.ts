import fs from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";
import type { AgentTool } from "./types.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 60_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_VALUE_CHARACTERS = 2_000;
const MAX_VALUE_CHARACTERS = 10_000;
const DEFAULT_MAX_DEPTH = 5;
const MAX_FIELDS = 20;
const MAX_NESTED_ITEMS = 25;
const MAX_CSV_COLUMNS = 500;
const MAX_REPORTED_COLUMNS = 100;

interface DecodedFile {
  text: string;
  encoding: string;
  bytes: number;
}

interface SanitizeStats {
  valuesTruncated: number;
  containersTruncated: number;
}

interface BuiltPage<T> {
  items: T;
  valuesTruncated: number;
  containersTruncated: number;
}

function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.length) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalInteger(input: Record<string, unknown>, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = input[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

async function readStructuredFile(cwd: string, requested: string, requestedEncoding?: unknown): Promise<DecodedFile> {
  const target = resolveWorkspacePath(cwd, requested);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(`Path is not a regular file: ${requested}`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`Structured extraction is limited to ${MAX_INPUT_BYTES} bytes; ${requested} is ${stat.size} bytes`);
  const buffer = await fs.readFile(target);
  if (requestedEncoding !== undefined && (typeof requestedEncoding !== "string" || !requestedEncoding.length || requestedEncoding.length > 100)) {
    throw new Error("encoding must be a non-empty string no longer than 100 characters");
  }
  if (typeof requestedEncoding === "string") {
    if (!iconv.encodingExists(requestedEncoding)) throw new Error(`Unsupported encoding: ${requestedEncoding}`);
    return { text: iconv.decode(buffer, requestedEncoding).replace(/^\uFEFF/, ""), encoding: requestedEncoding, bytes: buffer.length };
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf8-bom", bytes: buffer.length };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xFF, 0xFE]))) {
    return { text: iconv.decode(buffer.subarray(2), "utf16le"), encoding: "utf16le-bom", bytes: buffer.length };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xFE, 0xFF]))) {
    return { text: iconv.decode(buffer.subarray(2), "utf16-be"), encoding: "utf16be-bom", bytes: buffer.length };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf8", bytes: buffer.length };
  } catch {
    return { text: iconv.decode(buffer, "gb18030"), encoding: "gb18030-fallback", bytes: buffer.length };
  }
}

function pageOptions(input: Record<string, unknown>): { offset: number; limit: number; maxValueCharacters: number } {
  return {
    offset: optionalInteger(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: optionalInteger(input, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
    maxValueCharacters: optionalInteger(input, "max_value_characters", DEFAULT_VALUE_CHARACTERS, 1, MAX_VALUE_CHARACTERS),
  };
}

function truncateValue(value: string, maximum: number, stats: SanitizeStats): string {
  if (value.length <= maximum) return value;
  stats.valuesTruncated++;
  const marker = `… [${value.length - maximum} more characters]`;
  return value.slice(0, Math.max(0, maximum - marker.length)) + marker;
}

function sanitizeValue(value: unknown, maximum: number, maximumDepth: number, stats: SanitizeStats, depth = 0): unknown {
  if (typeof value === "string") return truncateValue(value, maximum, stats);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maximumDepth) {
    stats.containersTruncated++;
    if (Array.isArray(value)) return `[Array with ${value.length} items]`;
    if (typeof value === "object") return `[Object with ${Object.keys(value as object).length} keys]`;
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_NESTED_ITEMS) stats.containersTruncated++;
    return value.slice(0, MAX_NESTED_ITEMS).map((item) => sanitizeValue(item, maximum, maximumDepth, stats, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_NESTED_ITEMS) stats.containersTruncated++;
    return Object.fromEntries(entries.slice(0, MAX_NESTED_ITEMS).map(([key, item]) => [key, sanitizeValue(item, maximum, maximumDepth, stats, depth + 1)]));
  }
  return String(value);
}

function boundedPage<T>(
  base: Record<string, unknown>,
  total: number,
  offset: number,
  requestedLimit: number,
  resultKey: string,
  build: (count: number) => BuiltPage<T>,
): string {
  if (offset > total) throw new Error(`offset ${offset} exceeds matched item count ${total}`);
  const requestedCount = Math.min(requestedLimit, Math.max(0, total - offset));
  let count = requestedCount;
  while (true) {
    const page = build(count);
    const nextOffset = offset + count < total ? offset + count : null;
    const result = {
      ...base,
      offset,
      returned_count: count,
      next_offset: nextOffset,
      output_truncated: count < requestedCount || page.valuesTruncated > 0 || page.containersTruncated > 0,
      truncated_values: page.valuesTruncated,
      truncated_containers: page.containersTruncated,
      [resultKey]: page.items,
    };
    const serialized = JSON.stringify(result, null, 2);
    if (serialized.length <= MAX_OUTPUT_CHARACTERS) return serialized;
    if (count <= 1) throw new Error("A single structured record exceeds the output limit; select fewer fields or lower max_value_characters");
    count = Math.max(1, Math.floor(count / 2));
  }
}

type HtmlExtraction = "text" | "html" | "outer_html" | "attribute";

interface HtmlField {
  name: string;
  selector?: string;
  extract: HtmlExtraction;
  attribute?: string;
}

function htmlFields(input: Record<string, unknown>): HtmlField[] {
  if (input.fields === undefined) return [{ name: "text", extract: "text" }];
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > MAX_FIELDS) {
    throw new Error(`fields must contain between 1 and ${MAX_FIELDS} field definitions`);
  }
  const names = new Set<string>();
  return input.fields.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`fields[${index}] must be an object`);
    const field = item as Record<string, unknown>;
    const name = stringArg(field, "name");
    if (names.has(name)) throw new Error(`Duplicate HTML field name: ${name}`);
    names.add(name);
    if (field.selector !== undefined && (typeof field.selector !== "string" || !field.selector.length)) throw new Error(`fields[${index}].selector must be a non-empty string`);
    const extract = (field.extract ?? "text") as HtmlExtraction;
    if (!["text", "html", "outer_html", "attribute"].includes(extract)) throw new Error(`fields[${index}].extract is invalid`);
    if (extract === "attribute" && (typeof field.attribute !== "string" || !field.attribute.length)) throw new Error(`fields[${index}].attribute is required for attribute extraction`);
    return { name, selector: field.selector as string | undefined, extract, attribute: field.attribute as string | undefined };
  });
}

function htmlTool(): AgentTool {
  return {
    name: "extract_html",
    risk: "read",
    description: "Extract bounded structured records from an HTML file with a CSS root selector and optional relative text, HTML, outer-HTML, or attribute fields. Prefer this over repeatedly reading or scripting HTML parsing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative HTML file." },
        selector: { type: "string", description: "CSS selector for each result record, such as table tbody tr or .hop-card." },
        fields: {
          type: "array", minItems: 1, maxItems: MAX_FIELDS,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              selector: { type: "string", description: "Optional selector relative to each root match." },
              extract: { type: "string", enum: ["text", "html", "outer_html", "attribute"] },
              attribute: { type: "string", description: "Required when extract is attribute." },
            },
            required: ["name"], additionalProperties: false,
          },
        },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        max_value_characters: { type: "integer", minimum: 1, maximum: MAX_VALUE_CHARACTERS },
        encoding: { type: "string", description: "Optional iconv-lite encoding override." },
      },
      required: ["path", "selector"], additionalProperties: false,
    },
    describe: (input) => `extract HTML ${String(input.selector)} from ${String(input.path)}`,
    validate(input) { stringArg(input, "path"); stringArg(input, "selector"); htmlFields(input); pageOptions(input); },
    async execute(input, context) {
      const requestedPath = stringArg(input, "path");
      const selector = stringArg(input, "selector");
      const fields = htmlFields(input);
      const { offset, limit, maxValueCharacters } = pageOptions(input);
      const file = await readStructuredFile(context.cwd, requestedPath, input.encoding);
      const { load: loadHtml } = await import("cheerio");
      const $ = loadHtml(file.text);
      let roots;
      try { roots = $(selector).toArray(); }
      catch (error) { throw new Error(`Invalid CSS selector ${JSON.stringify(selector)}: ${error instanceof Error ? error.message : String(error)}`); }
      const build = (count: number): BuiltPage<Array<Record<string, string | null>>> => {
        const stats: SanitizeStats = { valuesTruncated: 0, containersTruncated: 0 };
        const rows = roots.slice(offset, offset + count).map((root) => Object.fromEntries(fields.map((field) => {
          let selection;
          try { selection = field.selector ? $(root).find(field.selector).first() : $(root); }
          catch (error) { throw new Error(`Invalid CSS selector ${JSON.stringify(field.selector)} for field ${JSON.stringify(field.name)}: ${error instanceof Error ? error.message : String(error)}`); }
          let value: string | null;
          if (!selection.length) value = null;
          else if (field.extract === "attribute") value = selection.attr(field.attribute!) ?? null;
          else if (field.extract === "html") value = selection.html();
          else if (field.extract === "outer_html") value = selection.prop("outerHTML") ?? null;
          else value = selection.text().trim();
          return [field.name, value === null ? null : truncateValue(value, maxValueCharacters, stats)];
        })));
        return { items: rows, valuesTruncated: stats.valuesTruncated, containersTruncated: 0 };
      };
      return boundedPage({ tool: "extract_html", path: requestedPath, encoding: file.encoding, bytes: file.bytes, selector, matched_count: roots.length }, roots.length, offset, limit, "rows", build);
    },
  };
}

function decodePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) throw new Error(`Invalid JSON Pointer escape in segment ${JSON.stringify(token)}`);
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function selectJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) throw new Error("JSON Pointer must be empty or start with /");
  let current = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = decodePointerToken(rawToken);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) throw new Error(`JSON Pointer segment ${JSON.stringify(token)} is not a valid array index`);
      const index = Number(token);
      if (index >= current.length) throw new Error(`JSON Pointer array index ${index} exceeds length ${current.length}`);
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, token)) throw new Error(`JSON Pointer segment ${JSON.stringify(token)} was not found`);
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`JSON Pointer cannot descend through ${current === null ? "null" : typeof current} at segment ${JSON.stringify(token)}`);
    }
  }
  return current;
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function jsonTool(): AgentTool {
  return {
    name: "extract_json",
    risk: "read",
    description: "Extract a bounded value or page from a JSON file using an RFC 6901 JSON Pointer. Prefer this over reading large JSON files or writing one-off parsing scripts.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative JSON file." },
        pointer: { type: "string", description: "RFC 6901 JSON Pointer, for example /orders/0/items. Empty selects the root." },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        max_value_characters: { type: "integer", minimum: 1, maximum: MAX_VALUE_CHARACTERS },
        max_depth: { type: "integer", minimum: 1, maximum: 10 },
        encoding: { type: "string", description: "Optional iconv-lite encoding override." },
      },
      required: ["path"], additionalProperties: false,
    },
    describe: (input) => `extract JSON ${String(input.pointer ?? "root")} from ${String(input.path)}`,
    validate(input) { stringArg(input, "path"); if (input.pointer !== undefined && typeof input.pointer !== "string") throw new Error("pointer must be a string"); pageOptions(input); optionalInteger(input, "max_depth", DEFAULT_MAX_DEPTH, 1, 10); },
    async execute(input, context) {
      const requestedPath = stringArg(input, "path");
      const pointer = typeof input.pointer === "string" ? input.pointer : "";
      const { offset, limit, maxValueCharacters } = pageOptions(input);
      const maximumDepth = optionalInteger(input, "max_depth", DEFAULT_MAX_DEPTH, 1, 10);
      const file = await readStructuredFile(context.cwd, requestedPath, input.encoding);
      let root: unknown;
      try { root = JSON.parse(file.text); }
      catch (error) { throw new Error(`Invalid JSON in ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`); }
      const selected = selectJsonPointer(root, pointer);
      const selectedType = valueType(selected);
      const base = { tool: "extract_json", path: requestedPath, encoding: file.encoding, bytes: file.bytes, pointer, selected_type: selectedType };
      if (Array.isArray(selected)) {
        return boundedPage({ ...base, total_count: selected.length }, selected.length, offset, limit, "value", (count) => {
          const stats: SanitizeStats = { valuesTruncated: 0, containersTruncated: 0 };
          const items = selected.slice(offset, offset + count).map((item) => sanitizeValue(item, maxValueCharacters, maximumDepth, stats));
          return { items, valuesTruncated: stats.valuesTruncated, containersTruncated: stats.containersTruncated };
        });
      }
      if (selected !== null && typeof selected === "object") {
        const entries = Object.entries(selected as Record<string, unknown>);
        return boundedPage({ ...base, total_count: entries.length }, entries.length, offset, limit, "value", (count) => {
          const stats: SanitizeStats = { valuesTruncated: 0, containersTruncated: 0 };
          const items = Object.fromEntries(entries.slice(offset, offset + count).map(([key, value]) => [key, sanitizeValue(value, maxValueCharacters, maximumDepth, stats)]));
          return { items, valuesTruncated: stats.valuesTruncated, containersTruncated: stats.containersTruncated };
        });
      }
      if (offset !== 0) throw new Error("offset must be 0 when the selected JSON value is scalar");
      const stats: SanitizeStats = { valuesTruncated: 0, containersTruncated: 0 };
      const value = sanitizeValue(selected, maxValueCharacters, maximumDepth, stats);
      return JSON.stringify({ ...base, total_count: 1, offset: 0, returned_count: 1, next_offset: null, output_truncated: stats.valuesTruncated > 0, truncated_values: stats.valuesTruncated, truncated_containers: stats.containersTruncated, value }, null, 2);
    },
  };
}

function firstLogicalCsvRecord(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      return text.slice(0, index);
    }
  }
  return text;
}

function detectDelimiter(text: string, requested: unknown, requestedPath: string): string {
  if (requested !== undefined) {
    if (typeof requested !== "string" || [...requested].length !== 1) throw new Error("delimiter must be exactly one character");
    return requested;
  }
  if (/\.tsv$/i.test(requestedPath)) return "\t";
  const record = firstLogicalCsvRecord(text);
  const candidates = [",", "\t", ";", "|"];
  let quoted = false;
  const counts = new Map(candidates.map((candidate) => [candidate, 0]));
  for (let index = 0; index < record.length; index++) {
    const character = record[index]!;
    if (character === '"') {
      if (quoted && record[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && counts.has(character)) counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return candidates.sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))[0] ?? ",";
}

function uniqueColumns(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = value.trim() || `column_${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function selectedColumns(input: Record<string, unknown>, available: string[]): string[] {
  if (input.columns === undefined) return available.slice(0, MAX_FIELDS);
  if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > MAX_FIELDS || input.columns.some((item) => typeof item !== "string" || !item.length)) {
    throw new Error(`columns must contain between 1 and ${MAX_FIELDS} non-empty names`);
  }
  for (const column of input.columns as string[]) if (!available.includes(column)) throw new Error(`Unknown CSV column ${JSON.stringify(column)}; available columns: ${available.join(", ")}`);
  return input.columns as string[];
}

function csvWhere(input: Record<string, unknown>, available: string[]): Record<string, string> {
  if (input.where === undefined) return {};
  if (!input.where || typeof input.where !== "object" || Array.isArray(input.where)) throw new Error("where must be an object of exact string matches");
  const entries = Object.entries(input.where as Record<string, unknown>);
  if (entries.length > 10 || entries.some(([, value]) => typeof value !== "string")) throw new Error("where supports at most 10 string equality conditions");
  for (const [column] of entries) if (!available.includes(column)) throw new Error(`Unknown CSV filter column ${JSON.stringify(column)}; available columns: ${available.join(", ")}`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function csvTool(): AgentTool {
  return {
    name: "extract_csv",
    risk: "read",
    description: "Extract a bounded, filtered page from CSV or TSV with correct quoted fields and optional column selection. Prefer this over reading large tables or writing one-off parsing scripts.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative CSV or TSV file." },
        header: { type: "boolean", description: "Whether the first record contains column names; defaults to true." },
        delimiter: { type: "string", minLength: 1, maxLength: 1, description: "Optional one-character delimiter; otherwise inferred from the first record or .tsv extension." },
        columns: { type: "array", minItems: 1, maxItems: MAX_FIELDS, items: { type: "string" } },
        where: { type: "object", description: "Up to 10 exact string equality filters keyed by column name.", additionalProperties: { type: "string" } },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        max_value_characters: { type: "integer", minimum: 1, maximum: MAX_VALUE_CHARACTERS },
        encoding: { type: "string", description: "Optional iconv-lite encoding override." },
      },
      required: ["path"], additionalProperties: false,
    },
    describe: (input) => `extract CSV rows from ${String(input.path)}`,
    validate(input) { stringArg(input, "path"); pageOptions(input); if (input.header !== undefined && typeof input.header !== "boolean") throw new Error("header must be a boolean"); detectDelimiter("", input.delimiter, String(input.path)); },
    async execute(input, context) {
      const requestedPath = stringArg(input, "path");
      const { offset, limit, maxValueCharacters } = pageOptions(input);
      const file = await readStructuredFile(context.cwd, requestedPath, input.encoding);
      const delimiter = detectDelimiter(file.text, input.delimiter, requestedPath);
      let records: string[][];
      try {
        const { parse: parseCsv } = await import("csv-parse/sync");
        records = parseCsv(file.text, { delimiter, bom: true, skip_empty_lines: true, relax_column_count: true }) as string[][];
      } catch (error) {
        throw new Error(`Invalid delimited file ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const header = input.header !== false;
      const width = records.reduce((maximum, record) => Math.max(maximum, record.length), 0);
      if (!width) return JSON.stringify({ tool: "extract_csv", path: requestedPath, encoding: file.encoding, bytes: file.bytes, delimiter, columns: [], row_count: 0, matched_count: 0, offset: 0, returned_count: 0, next_offset: null, output_truncated: false, truncated_values: 0, truncated_containers: 0, rows: [] }, null, 2);
      if (width > MAX_CSV_COLUMNS) throw new Error(`CSV column count ${width} exceeds the limit ${MAX_CSV_COLUMNS}`);
      const headerValues = header ? (records.shift() ?? []) : Array.from({ length: width }, (_, index) => `column_${index + 1}`);
      while (headerValues.length < width) headerValues.push("");
      const available = uniqueColumns(headerValues);
      const rows = records.map((record) => Object.fromEntries(available.map((column, index) => [column, record[index] ?? ""])));
      const columns = selectedColumns(input, available);
      const where = csvWhere(input, available);
      const filtered = rows.filter((row) => Object.entries(where).every(([column, expected]) => row[column] === expected));
      const reportedColumns = available.slice(0, MAX_REPORTED_COLUMNS).map((column) => column.length > 200 ? `${column.slice(0, 180)}…` : column);
      return boundedPage({ tool: "extract_csv", path: requestedPath, encoding: file.encoding, bytes: file.bytes, delimiter: delimiter === "\t" ? "\\t" : delimiter, header, available_column_count: available.length, available_columns: reportedColumns, available_columns_truncated: available.length > reportedColumns.length, columns, row_count: rows.length, matched_count: filtered.length }, filtered.length, offset, limit, "rows", (count) => {
        const stats: SanitizeStats = { valuesTruncated: 0, containersTruncated: 0 };
        const items = filtered.slice(offset, offset + count).map((row) => Object.fromEntries(columns.map((column) => [column, truncateValue(row[column] ?? "", maxValueCharacters, stats)])));
        return { items, valuesTruncated: stats.valuesTruncated, containersTruncated: 0 };
      });
    },
  };
}

export const structuredExtractTools: AgentTool[] = [htmlTool(), jsonTool(), csvTool()];
