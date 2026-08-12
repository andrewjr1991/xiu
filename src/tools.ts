import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import iconv from "iconv-lite";
import { listBackgroundProcesses, readBackgroundProcessOutput, startBackgroundProcess, stopBackgroundProcess } from "./background.js";
import { structuredExtractTools } from "./structured-extract.js";
import type { AgentTool, ToolContext, ToolRisk } from "./types.js";
import { retryDecision, retryDelay } from "./retry-policy.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 60_000;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;
const DEFAULT_READ_CHARACTERS = 20_000;

function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.length) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalStringArray(input: Record<string, unknown>, name: string): string[] {
  const value = input[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string" || !item.length || item.length > 1_000)) {
    throw new Error(`${name} must be an array of at most 50 non-empty strings, each no longer than 1000 characters`);
  }
  return value as string[];
}

function processArgs(input: Record<string, unknown>): string[] {
  const value = input.args;
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length > 20_000)) {
    throw new Error("args must be an array of at most 100 strings, each no longer than 20000 characters");
  }
  const args = value as string[];
  if (args.reduce((total, item) => total + item.length, 0) > 100_000) throw new Error("combined args must not exceed 100000 characters");
  return args;
}

function processProgram(input: Record<string, unknown>): string {
  const program = stringArg(input, "program");
  if (program !== program.trim() || program.length > 1_000 || /[\0\r\n]/.test(program)) throw new Error("program must be a single executable name or workspace-relative path");
  return program;
}

function processTimeout(input: Record<string, unknown>): number {
  if (input.timeout_ms === undefined) return 120_000;
  if (!Number.isInteger(input.timeout_ms) || (input.timeout_ms as number) < 1_000 || (input.timeout_ms as number) > 300_000) {
    throw new Error("timeout_ms must be an integer between 1000 and 300000");
  }
  return input.timeout_ms as number;
}

const SHELL_PROGRAMS = new Set(["powershell", "pwsh", "cmd", "command", "bash", "sh", "zsh", "fish", "wsl"]);

function programName(program: string): string {
  return path.basename(program).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function validateDirectProcess(input: Record<string, unknown>): void {
  const program = processProgram(input);
  processArgs(input);
  processTimeout(input);
  if (SHELL_PROGRAMS.has(programName(program))) {
    throw new Error("run_process does not accept a shell wrapper. Use run_command for PowerShell or shell syntax; otherwise pass the target program and each argument directly.");
  }
}

function quoteProcessArgument(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./\\:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatProcessInvocation(program: string, args: string[]): string {
  return [quoteProcessArgument(program), ...args.map(quoteProcessArgument)].join(" ");
}

export function classifyProcess(program: string, args: string[]): ToolRisk {
  const name = programName(program);
  const lowered = args.map((item) => item.toLowerCase());
  if (["rm", "rmdir", "del", "erase", "format", "shutdown", "taskkill"].includes(name)) return "dangerous";
  if (name === "git") {
    if ((lowered[0] === "reset" && lowered.includes("--hard")) || (lowered[0] === "clean" && lowered.some((item) => /^-[a-z]*f/i.test(item)))) return "dangerous";
    if (["status", "log", "diff", "show", "rev-parse"].includes(lowered[0] ?? "") || (lowered[0] === "branch" && lowered.includes("--list"))) return "read";
  }
  if (lowered.length === 1 && ["--version", "-v"].includes(lowered[0]!)) return "read";
  return "execute";
}

function resolveProcessProgram(program: string, cwd: string): string {
  if (program.includes("/") || program.includes("\\")) return resolveWorkspacePath(cwd, program);
  if (process.platform === "win32" && ["npm", "npx", "pnpm", "yarn", "corepack"].includes(program.toLowerCase())) return `${program}.cmd`;
  return program;
}

async function resolveWindowsNodePackageCli(program: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const name = programName(program);
  if (name !== "npm" && name !== "npx") return undefined;
  const script = name === "npm" ? "npm-cli.js" : "npx-cli.js";
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : []),
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* try the next standard Node/npm layout */ }
  }
  return undefined;
}

function directProcessFailureHint(program: string, errorCode: string | number | undefined): string {
  if (errorCode === "ENOENT") return `\nHint: program '${program}' was not found. Check PATH or pass a workspace-relative executable path.`;
  if (errorCode === "EINVAL" && ["npm", "npx"].includes(programName(program))) return "\nHint: Windows could not launch the npm command directly. Use validate_project for typecheck, lint, test, or build; do not add cmd, /c, /p, or shell-wrapper arguments.";
  return "";
}

function shellFailureHint(command: string, output: string): string {
  const inlineInterpreter = /\b(?:python|py)\s+-c\b|\bnode\s+-e\b/i.test(command);
  const parserFailure = /ParserError|Unexpected token|The string is missing the terminator|字符串缺少终止符|意外的标记/i.test(output);
  return inlineInterpreter || parserFailure
    ? "\nHint: avoid PowerShell quoting for this command. Retry with run_process using program and args so every argument is passed directly."
    : "";
}

export function resolveWorkspacePath(cwd: string, requested: string): string {
  const root = path.resolve(cwd);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return target;
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  const marker = `\n... [output truncated; ${value.length.toLocaleString()} characters total; middle omitted] ...\n`;
  const available = MAX_OUTPUT - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

async function windowsConsoleEncoding(): Promise<string> {
  try {
    const result = await execFileAsync("chcp.com", [], { encoding: "utf8", windowsHide: true });
    const codePage = result.stdout.match(/\d+/)?.[0];
    const encoding = codePage === "65001" ? "utf8" : codePage ? `cp${codePage}` : "utf8";
    return iconv.encodingExists(encoding) ? encoding : "utf8";
  } catch {
    return "utf8";
  }
}

function decodeOutput(value: string | Buffer | undefined, encoding: string): string {
  if (value === undefined) return "";
  if (!Buffer.isBuffer(value)) return value;
  const utf8 = value.toString("utf8");
  if (!utf8.includes("\uFFFD") && Buffer.from(utf8, "utf8").equals(value)) return utf8;
  return iconv.decode(value, encoding);
}

function unquotedText(value: string): string {
  let quote: "'" | '"' | undefined;
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === "`" && index + 1 < value.length) index++;
      else if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else {
      result += character;
    }
  }
  return result;
}

export function classifyCommand(command: string): ToolRisk {
  const shell = unquotedText(command).trim();
  const dangerous = /(^|[;|]\s*)(remove-item\b|del\s+|erase\s+|rd\s+|rmdir\s+|rm\s+)|git\s+(reset\s+--hard|clean\s+-[^\r\n]*f)|\b(format|shutdown|restart-computer|stop-computer)\b/i;
  if (dangerous.test(shell)) return "dangerous";
  const readOnly = [
    /^git\s+(status|log|diff|show|rev-parse|branch\s+--list)\b/i,
    /^(node|npm|python|py|git)\s+--version\b/i,
    /^(get-content|get-childitem|test-path|select-string|get-filehash|measure-object)\b/i,
  ];
  return readOnly.some((pattern) => pattern.test(shell)) ? "read" : "execute";
}

export function looksLikeVerification(command: string): boolean {
  const namedCheck = /(^|\s)(test|tests|lint|check|typecheck|build|verify|validate)(\s|$|:)/i.test(command)
    || /\b(tsc\b|pytest\b|vitest\b|jest\b|eslint\b|cargo\s+test\b|go\s+test\b)/i.test(command)
    || /验证|校验/.test(command);
  const verifierScript = /(?:^|[\\/\s])(?:test|tests|check|verify|validate)(?:[_-][^\\/\s]+)?\.(?:py|mjs|cjs|js|ts|ps1|sh|bat|cmd)\b/i.test(command)
    || /(?:^|[\\/\s])[^\\/\s]+[_-](?:test|tests|check|verify|validate)\.(?:py|mjs|cjs|js|ts|ps1|sh|bat|cmd)\b/i.test(command);
  return namedCheck || verifierScript;
}

export function verificationCommandPassed(result: string): boolean {
  if (!/^Exit code: 0\b/.test(result)) return false;
  const negativeEvidence = [
    /(?:验证|校验)(?:失败|未通过|错误)/i,
    /\b(?:verification|validation|check)\s*(?::|result\s*:?)?\s*(?:false|failed|failure|error)\b/im,
    /^\s*(?:false|failed|failure|error)\s*$/im,
    /\b[1-9]\d*\s+(?:failed|failures|errors)\b/i,
  ];
  return !negativeEvidence.some((pattern) => pattern.test(result));
}

function patchArray(input: Record<string, unknown>): Array<{ old_text: string; new_text: string }> {
  if (!Array.isArray(input.patches) || input.patches.length === 0) throw new Error("patches must be a non-empty array");
  return input.patches.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`patches[${index}] must be an object`);
    const patch = item as Record<string, unknown>;
    if (typeof patch.old_text !== "string" || patch.old_text.length === 0) throw new Error(`patches[${index}].old_text must be non-empty`);
    if (typeof patch.new_text !== "string") throw new Error(`patches[${index}].new_text must be a string`);
    return { old_text: patch.old_text, new_text: patch.new_text };
  });
}

function applyExactPatches(content: string, patches: Array<{ old_text: string; new_text: string }>): string {
  let updated = content;
  for (const [index, patch] of patches.entries()) {
    const first = updated.indexOf(patch.old_text);
    if (first < 0) throw new Error(`patches[${index}].old_text was not found`);
    if (updated.indexOf(patch.old_text, first + patch.old_text.length) >= 0) {
      throw new Error(`patches[${index}].old_text is not unique; provide more context`);
    }
    updated = updated.slice(0, first) + patch.new_text + updated.slice(first + patch.old_text.length);
  }
  return updated;
}

function patchPreview(file: string, patches: Array<{ old_text: string; new_text: string }>): string {
  const sections = patches.map((patch, index) => {
    const removed = patch.old_text.split(/\r?\n/).map((line) => `- ${line}`).join("\n");
    const added = patch.new_text.split(/\r?\n/).map((line) => `+ ${line}`).join("\n");
    return `@@ change ${index + 1} @@\n${removed}\n${added}`;
  });
  return truncate(`--- ${file}\n+++ ${file}\n${sections.join("\n")}`);
}

export const builtinTools: AgentTool[] = [
  {
    name: "list_files",
    risk: "read",
    description: "List workspace files matching a glob. Ignores common generated directories.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob such as **/*.ts" } },
      required: ["pattern"], additionalProperties: false,
    },
    describe: (input) => `list files matching ${String(input.pattern)}`,
    async execute(input, context) {
      const pattern = stringArg(input, "pattern");
      if (path.isAbsolute(pattern) || pattern.includes("..")) throw new Error("Glob must stay inside workspace");
      const files = await fg(pattern, {
        cwd: context.cwd,
        onlyFiles: true,
        dot: true,
        unique: true,
        ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/.xiu/**"],
      });
      return files.sort().slice(0, 1000).join("\n") || "No matching files.";
    },
  },
  {
    name: "read_file",
    risk: "read",
    description: "Read a bounded UTF-8 text-file window. Defaults to 200 lines. Use line paging for normal files or character paging for minified and giant single-line files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
        start_character: { type: "integer", minimum: 0, description: "Zero-based character offset for minified or giant single-line files." },
        max_characters: { type: "integer", minimum: 1, maximum: 20000, description: "Character window size; defaults to and cannot exceed 20000." },
      },
      required: ["path"], additionalProperties: false,
    },
    describe: (input) => `read ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      const content = await fs.readFile(target, "utf8");
      const characterMode = typeof input.start_character === "number" || typeof input.max_characters === "number";
      if (characterMode) {
        const start = typeof input.start_character === "number" ? Math.max(0, Math.floor(input.start_character)) : 0;
        const requested = typeof input.max_characters === "number" ? Math.floor(input.max_characters) : DEFAULT_READ_CHARACTERS;
        const size = Math.max(1, Math.min(DEFAULT_READ_CHARACTERS, requested));
        if (start >= content.length && content.length > 0) throw new Error(`start_character ${start} exceeds file length ${content.length}`);
        const endExclusive = Math.min(content.length, start + size);
        const body = content.slice(start, endExclusive);
        const notice = endExclusive < content.length
          ? `\n[PARTIAL view: characters ${start}-${endExclusive - 1} of ${content.length}; continue with start_character=${endExclusive}]`
          : "";
        return `Characters ${start}-${Math.max(start, endExclusive - 1)} of ${content.length}\n${body}${notice}`;
      }
      const lines = content.split(/\r?\n/);
      const start = typeof input.start_line === "number" ? Math.max(1, input.start_line) : 1;
      if (start > lines.length) throw new Error(`start_line ${start} exceeds file length ${lines.length} lines`);
      const requestedEnd = typeof input.end_line === "number" ? Math.max(start, input.end_line) : start + DEFAULT_READ_LINES - 1;
      const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
      const body = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
      const notices: string[] = [];
      if (end < lines.length) notices.push(`[PARTIAL view: lines ${start}-${end} of ${lines.length}; continue with start_line=${end + 1}]`);
      if (body.length > MAX_OUTPUT - 500) notices.push("[This line window is very large. For minified or giant single-line files, use start_character and max_characters to page precisely.]");
      return truncate(`Lines ${start}-${end} of ${lines.length}\n${body}${notices.length ? `\n${notices.join("\n")}` : ""}`);
    },
  },
  ...structuredExtractTools,
  {
    name: "verify_output",
    risk: "read",
    description: "Deterministically verify a generated UTF-8 text artifact. Declare required and forbidden substrings and optional byte-size bounds. Any unmet condition returns Verification failed, so use this for HTML, JSON, Markdown, CSV, and other deliverables without a project test suite.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        required_substrings: { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 50 },
        forbidden_substrings: { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 50 },
        min_bytes: { type: "integer", minimum: 0 },
        max_bytes: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    describe: (input) => `verify generated output ${String(input.path)}`,
    validate(input) {
      const required = optionalStringArray(input, "required_substrings");
      const forbidden = optionalStringArray(input, "forbidden_substrings");
      const hasMinimum = typeof input.min_bytes === "number";
      const hasMaximum = typeof input.max_bytes === "number";
      if (!required.length && !forbidden.length && !hasMinimum && !hasMaximum) {
        throw new Error("verify_output requires at least one substring or byte-size expectation");
      }
      if (hasMinimum && (!Number.isInteger(input.min_bytes) || Number(input.min_bytes) < 0)) throw new Error("min_bytes must be a non-negative integer");
      if (hasMaximum && (!Number.isInteger(input.max_bytes) || Number(input.max_bytes) < 1)) throw new Error("max_bytes must be a positive integer");
      if (hasMinimum && hasMaximum && Number(input.min_bytes) > Number(input.max_bytes)) throw new Error("min_bytes must not exceed max_bytes");
    },
    isVerification: (_input, result) => result.startsWith("Verification passed:"),
    async execute(input, context) {
      const requested = stringArg(input, "path");
      const target = resolveWorkspacePath(context.cwd, requested);
      const content = await fs.readFile(target, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      const required = optionalStringArray(input, "required_substrings");
      const forbidden = optionalStringArray(input, "forbidden_substrings");
      const missing = required.filter((value) => !content.includes(value));
      const present = forbidden.filter((value) => content.includes(value));
      const failures: string[] = [];
      if (missing.length) failures.push(`missing required substring(s): ${missing.map((value) => JSON.stringify(value)).join(", ")}`);
      if (present.length) failures.push(`found forbidden substring(s): ${present.map((value) => JSON.stringify(value)).join(", ")}`);
      if (typeof input.min_bytes === "number" && bytes < input.min_bytes) failures.push(`size ${bytes} bytes is below minimum ${input.min_bytes}`);
      if (typeof input.max_bytes === "number" && bytes > input.max_bytes) failures.push(`size ${bytes} bytes exceeds maximum ${input.max_bytes}`);
      if (failures.length) return `Verification failed: ${requested}\n- ${failures.join("\n- ")}`;
      return `Verification passed: ${requested}\n- size: ${bytes} bytes\n- required substrings: ${required.length}/${required.length}\n- forbidden substrings absent: ${forbidden.length}/${forbidden.length}`;
    },
  },
  {
    name: "search_text",
    risk: "read",
    description: "Search text in workspace files with a regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pattern: { type: "string", description: "Optional file glob, defaults to **/*" },
      },
      required: ["query"], additionalProperties: false,
    },
    describe: (input) => `search for ${String(input.query)}`,
    async execute(input, context) {
      const query = stringArg(input, "query");
      const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
      let regex: RegExp;
      try { regex = new RegExp(query, "i"); } catch { throw new Error("query must be a valid regular expression"); }
      const files = await fg(pattern, { cwd: context.cwd, onlyFiles: true, dot: true, ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/.xiu/**"] });
      const matches: string[] = [];
      for (const file of files.slice(0, 3000)) {
        let content: string;
        try { content = await fs.readFile(path.join(context.cwd, file), "utf8"); } catch { continue; }
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (regex.test(line)) matches.push(`${file}:${index + 1}:${line}`);
          regex.lastIndex = 0;
          if (matches.length >= 500) return truncate(matches.join("\n") + "\n... [match limit reached]");
        }
      }
      return matches.join("\n") || "No matches.";
    },
  },
  {
    name: "write_file",
    approvalScope: "workspace-files:write",
    risk: "write",
    changesWorkspace: true,
    description: "Create or fully overwrite a UTF-8 file. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"], additionalProperties: false,
    },
    describe: (input) => `write ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      if (typeof input.content !== "string") throw new Error("content must be a string");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, "utf8");
      return `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "replace_text",
    approvalScope: "workspace-files:edit",
    risk: "write",
    changesWorkspace: true,
    description: "Replace one exact, unique text block in a UTF-8 file. Safer than overwriting an existing file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"], additionalProperties: false,
    },
    describe: (input) => `edit ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      const oldText = stringArg(input, "old_text");
      if (typeof input.new_text !== "string") throw new Error("new_text must be a string");
      const content = await fs.readFile(target, "utf8");
      const first = content.indexOf(oldText);
      if (first < 0) throw new Error("old_text was not found");
      if (content.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_text is not unique; provide more context");
      await fs.writeFile(target, content.slice(0, first) + input.new_text + content.slice(first + oldText.length), "utf8");
      return `Updated ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "apply_patch",
    approvalScope: "workspace-files:edit",
    description: "Apply one or more exact, unique replacements to a file atomically. A structured diff preview is shown before approval.",
    risk: "write",
    changesWorkspace: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        patches: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { old_text: { type: "string" }, new_text: { type: "string" } },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "patches"],
      additionalProperties: false,
    },
    describe: (input) => `patch ${String(input.path)}`,
    validate(input) { patchArray(input); },
    async preview(input, context) {
      const file = stringArg(input, "path");
      const content = await fs.readFile(resolveWorkspacePath(context.cwd, file), "utf8");
      const patches = patchArray(input);
      applyExactPatches(content, patches);
      return patchPreview(file, patches);
    },
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      const content = await fs.readFile(target, "utf8");
      const updated = applyExactPatches(content, patchArray(input));
      await fs.writeFile(target, updated, "utf8");
      return `Applied ${patchArray(input).length} change(s) to ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "run_process",
    approvalScope: (input) => classifyProcess(processProgram(input), processArgs(input)) === "dangerous" ? undefined : `run-process:${programName(processProgram(input))}`,
    risk: (input) => classifyProcess(processProgram(input), processArgs(input)),
    changesWorkspace: (input) => classifyProcess(processProgram(input), processArgs(input)) !== "read",
    description: "Run a program directly with an argument array, without PowerShell or shell parsing. Prefer this for Node, Python, Git, npm, test runners, paths with spaces, JSON, regex, and inline code. Use run_command only when PowerShell or shell syntax is required.",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "Executable name from PATH or a workspace-relative executable path. Do not include arguments here." },
        args: { type: "array", items: { type: "string" }, maxItems: 100, description: "Exact argument values. They are passed directly and are never parsed by PowerShell." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["program", "args"],
      additionalProperties: false,
    },
    describe: (input) => `run directly: ${formatProcessInvocation(processProgram(input), processArgs(input))}`,
    isVerification: (input, result) => looksLikeVerification(formatProcessInvocation(processProgram(input), processArgs(input))) && verificationCommandPassed(result),
    validate: validateDirectProcess,
    async preview(input, context) {
      const program = processProgram(input);
      const resolved = resolveProcessProgram(program, context.cwd);
      return `Direct process (no shell parsing):\n${formatProcessInvocation(resolved, processArgs(input))}`;
    },
    async execute(input, context) {
      const requestedProgram = processProgram(input);
      const requestedArgs = processArgs(input);
      const nodePackageCli = await resolveWindowsNodePackageCli(requestedProgram);
      const program = nodePackageCli ? process.execPath : resolveProcessProgram(requestedProgram, context.cwd);
      const args = nodePackageCli ? [nodePackageCli, ...requestedArgs] : requestedArgs;
      const timeout = processTimeout(input);
      const outputEncoding = process.platform === "win32" ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(program, args, { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        const stdout = decodeOutput(result.stdout, outputEncoding);
        const stderr = decodeOutput(result.stderr, outputEncoding);
        return truncate(`Exit code: 0\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        const stdout = decodeOutput(failure.stdout, outputEncoding);
        const stderr = decodeOutput(failure.stderr, outputEncoding);
        if (context.signal?.aborted) return "Process cancelled by user.";
        if (failure.killed) return truncate(`Process timed out after ${timeout}ms.\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
        const output = `Exit code: ${failure.code ?? "failed"}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
        return truncate(`${output}${directProcessFailureHint(requestedProgram, failure.code)}`);
      }
    },
  },
  {
    name: "run_command",
    risk: (input) => classifyCommand(stringArg(input, "command")),
    changesWorkspace: (input) => classifyCommand(stringArg(input, "command")) !== "read",
    description: process.platform === "win32"
      ? "Run Windows PowerShell 5.1 syntax in the workspace. Use only for cmdlets, variables, pipelines, redirection, or command composition. Prefer run_process for programs and complex arguments. Requires approval unless --yes is active."
      : "Run POSIX shell syntax in the workspace. Use only for pipelines, redirection, variables, or command composition. Prefer run_process for programs and complex arguments. Requires approval unless --yes is active.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["command"], additionalProperties: false,
    },
    describe: (input) => `run: ${String(input.command)}`,
    isVerification: (input, result) => looksLikeVerification(String(input.command)) && verificationCommandPassed(result),
    validate(input) {
      const command = stringArg(input, "command");
      if (process.platform === "win32" && (/&&|\|\||\/dev\/null/.test(unquotedText(command)))) {
        throw new Error("This runtime uses Windows PowerShell 5.1. Retry without Bash operators (&& or ||) and /dev/null; the command already starts in the workspace.");
      }
    },
    async execute(input, context) {
      const command = stringArg(input, "command");
      const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
      const isWindows = process.platform === "win32";
      const executable = isWindows ? "powershell.exe" : "/bin/sh";
      const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
      const outputEncoding = isWindows ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(executable, args, { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        const stdout = decodeOutput(result.stdout, outputEncoding);
        const stderr = decodeOutput(result.stderr, outputEncoding);
        return truncate(`Exit code: 0\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        const stdout = decodeOutput(failure.stdout, outputEncoding);
        const stderr = decodeOutput(failure.stderr, outputEncoding);
        if (context.signal?.aborted) return "Command cancelled by user.";
        if (failure.killed) return truncate(`Command timed out after ${timeout}ms.\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
        const output = `Exit code: ${failure.code ?? "failed"}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
        return truncate(`${output}${shellFailureHint(command, output)}`);
      }
    },
  },
  {
    name: "project_info",
    description: "Detect the project type, package scripts, and common verification commands without executing project code.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "detect project type and checks",
    async execute(_input, context) {
      const markers = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];
      const present: string[] = [];
      for (const marker of markers) {
        try { await fs.access(path.join(context.cwd, marker)); present.push(marker); } catch { /* absent */ }
      }
      const info: Record<string, unknown> = { markers: present, suggested_checks: [] as string[] };
      if (present.includes("package.json")) {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(context.cwd, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
          info.name = pkg.name;
          info.scripts = pkg.scripts ?? {};
          info.suggested_checks = ["typecheck", "lint", "test", "build"].filter((name) => Boolean(pkg.scripts?.[name]));
        } catch (error) {
          info.package_error = (error as Error).message;
        }
      }
      return JSON.stringify(info, null, 2);
    },
  },
  {
    name: "start_background_command",
    description: "Start a long-running command such as a development server under Xiu session management. It is stopped when Xiu exits.",
    risk: (input) => classifyCommand(stringArg(input, "command")) === "dangerous" ? "dangerous" : "execute",
    changesWorkspace: (input) => classifyCommand(stringArg(input, "command")) !== "read",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    describe: (input) => `start in background: ${String(input.command)}`,
    async execute(input, context) {
      const started = startBackgroundProcess(stringArg(input, "command"), context.cwd);
      return `Background process ${started.id} started (PID ${started.pid ?? "unknown"}).`;
    },
  },
  {
    name: "list_background_commands",
    description: "List commands running in the background during this Xiu session.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "list background commands",
    async execute() {
      const running = listBackgroundProcesses();
      return running.length ? JSON.stringify(running, null, 2) : "No background commands.";
    },
  },
  {
    name: "read_background_output",
    description: "Read persisted output from a managed background command. Pass the returned nextCursor to fetch only new output later.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, cursor: { type: "integer", minimum: 0 } },
      required: ["id"],
      additionalProperties: false,
    },
    describe: (input) => `read background output ${String(input.id)}`,
    async execute(input) {
      const page = readBackgroundProcessOutput(stringArg(input, "id"), typeof input.cursor === "number" ? input.cursor : 0);
      return truncate(JSON.stringify(page, null, 2));
    },
  },
  {
    name: "stop_background_command",
    description: "Stop a command previously started and tracked by Xiu.",
    risk: "execute",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    describe: (input) => `stop background command ${String(input.id)}`,
    async execute(input) {
      const id = stringArg(input, "id");
      await stopBackgroundProcess(id);
      return `Background process ${id} stopped.`;
    },
  },
  {
    name: "git_status",
    description: "Show concise Git repository and working-tree status without invoking a shell.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "inspect git status",
    async execute(_input, context) {
      try {
        const result = await execFileAsync("git", ["status", "--short", "--branch"], { cwd: context.cwd, timeout: 30_000, windowsHide: true, encoding: "utf8", signal: context.signal });
        return result.stdout.trim() || "Git working tree is clean.";
      } catch {
        return "Not a Git repository or Git is unavailable.";
      }
    },
  },
  {
    name: "git_log",
    description: "Read recent Git commit history without invoking a shell.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    describe: () => "read recent git history",
    async execute(input, context) {
      const count = typeof input.count === "number" ? Math.min(50, Math.max(1, input.count)) : 10;
      try {
        const result = await execFileAsync("git", ["log", `-${count}`, "--oneline", "--decorate"], { cwd: context.cwd, timeout: 30_000, windowsHide: true, encoding: "utf8", signal: context.signal });
        return result.stdout.trim() || "No commits.";
      } catch {
        return "No Git history is available.";
      }
    },
  },
  {
    name: "validate_project",
    approvalScope: "project-verification",
    description: "Run a named npm verification script (typecheck, lint, test, or build) directly, without shell composition.",
    risk: "execute",
    inputSchema: {
      type: "object",
      properties: {
        check: { type: "string", enum: ["typecheck", "lint", "test", "build"] },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["check"],
      additionalProperties: false,
    },
    describe: (input) => `run project ${String(input.check)}`,
    isVerification: (_input, result) => /^Exit code: 0\b/.test(result),
    async execute(input, context) {
      const check = stringArg(input, "check");
      const packageFile = path.join(context.cwd, "package.json");
      const pkg = JSON.parse(await fs.readFile(packageFile, "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.[check]) return `Verification unavailable: package.json has no ${check} script.`;
      const executable = process.platform === "win32" ? "npm.cmd" : "npm";
      const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
      const outputEncoding = process.platform === "win32" ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(executable, ["run", check], { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        return truncate(`Exit code: 0\n${decodeOutput(result.stdout, outputEncoding)}${result.stderr.length ? `\nSTDERR:\n${decodeOutput(result.stderr, outputEncoding)}` : ""}`.trim());
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        if (context.signal?.aborted) return "Verification cancelled by user.";
        if (failure.killed) return `Verification timed out after ${timeout}ms.`;
        return truncate(`Exit code: ${failure.code ?? "failed"}\n${decodeOutput(failure.stdout, outputEncoding)}${failure.stderr ? `\nSTDERR:\n${decodeOutput(failure.stderr, outputEncoding)}` : ""}`.trim());
      }
    },
  },
  {
    name: "git_diff",
    risk: "read",
    description: "Show the current Git working-tree diff. This is read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "inspect git diff",
    async execute(_input, context) {
      try {
        const result = await execFileAsync("git", ["diff", "--", "."], { cwd: context.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal: context.signal });
        return truncate(result.stdout || "No tracked changes. Note: untracked files are not shown.");
      } catch (error) {
        return `Unable to read Git diff: ${(error as Error).message}`;
      }
    },
  },
];

export async function executeTool(tool: AgentTool, input: Record<string, unknown>, context: ToolContext): Promise<string> {
  try { tool.validate?.(input); }
  catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
  const risk = typeof tool.risk === "function" ? tool.risk(input) : tool.risk;
  if (risk !== "read") {
    let preview: string | undefined;
    try { preview = await tool.preview?.(input, context); }
    catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
    const sessionScope = typeof tool.approvalScope === "function" ? tool.approvalScope(input) : tool.approvalScope;
    if (!(await context.approve({ description: tool.describe(input), risk, preview, sessionScope }))) return "Tool execution denied by user.";
  }
  const replaySafety = typeof tool.replaySafety === "function"
    ? tool.replaySafety(input)
    : tool.replaySafety ?? (risk === "read" ? "safe" : "side-effecting");
  const maxAttempts = Math.max(1, Math.min(5, tool.maxAttempts ?? (replaySafety === "safe" || replaySafety === "idempotent" ? 3 : 1)));
  for (let attempt = 1; ; attempt += 1) {
    try { return await tool.execute(input, context); }
    catch (error) {
      const decision = retryDecision({
        operation: tool.name.startsWith("mcp__") ? "mcp" : "tool",
        error,
        attempt,
        maxAttempts,
        replaySafety,
        commitState: replaySafety === "safe" || replaySafety === "idempotent" ? "not-committed" : "unknown",
      });
      if (!decision.retry) return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      context.reportProgress?.(`${tool.name}: transient ${decision.category} failure; retrying ${attempt + 1}/${maxAttempts} in ${decision.delayMs}ms`);
      context.setRuntimeState?.("backoff", `${tool.name} retry ${attempt + 1}/${maxAttempts}`);
      try { await retryDelay(decision.delayMs ?? 0, context.signal); }
      catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
      finally { context.setRuntimeState?.("working"); }
    }
  }
}
