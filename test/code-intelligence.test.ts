import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectIndexTools, ProjectIndex } from "../src/project-index.js";

async function fixture(): Promise<{ cwd: string; index: ProjectIndex }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-code-map-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src", "math.ts"), `
export interface CalculationOptions { round?: boolean }
export type Numeric = number;
export const version = "1.0";
export function add(left: number, right: number): number { return left + right; }
export class Calculator {
  multiply(left: number, right: number): number { return left * right; }
  total(): number { return add(1, 2); }
}
function internalHelper(): number { return 1; }
`);
  await fs.writeFile(path.join(cwd, "src", "service.ts"), `
import { add as sum, Calculator } from "./math.js";
import * as math from "./math.js";
export function calculate(): number {
  const calculator = new Calculator();
  return sum(1, 2) + math.add(3, 4) + calculator.multiply(2, 3);
}
`);
  await fs.writeFile(path.join(cwd, "src", "other.ts"), `
export function add(value: number): number { return value; }
export function useOther(): number { return add(2); }
`);
  await fs.writeFile(path.join(cwd, "worker.py"), "def python_worker():\n    return 1\n");
  const index = new ProjectIndex(cwd);
  await index.initialize();
  return { cwd, index };
}

async function execute(index: ProjectIndex, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = createProjectIndexTools(index).find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return JSON.parse(await tool.execute(input, { cwd: "unused" })) as Record<string, unknown>;
}

test("repository map exposes modules symbols dependencies and pagination", async () => {
  const { index } = await fixture();
  const first = await execute(index, "repository_map", { path: "src", limit: 2, offset: 0 });
  assert.equal(first.module_count, 3);
  assert.equal(first.analyzed_module_count, 3);
  assert.equal((first.modules as unknown[]).length, 2);
  assert.equal(first.next_offset, 2);
  assert.ok((first.symbol_count as number) >= 10);
  assert.equal(first.dependency_count, 1);

  const second = await execute(index, "repository_map", { path: "src", limit: 2, offset: 2 });
  assert.equal((second.modules as unknown[]).length, 1);
  assert.equal(second.next_offset, null);
  const modules = [...first.modules as Array<Record<string, unknown>>, ...second.modules as Array<Record<string, unknown>>];
  const service = modules.find((module) => module.path === "src/service.ts");
  assert.ok(service);
  assert.deepEqual(service.dependencies, ["src/math.ts"]);
});

test("symbol search returns stable definitions and bounded signatures", async () => {
  const { index } = await fixture();
  const exact = await execute(index, "find_symbol", { query: "Calculator" });
  assert.ok((exact.match_count as number) >= 1);
  const definition = (exact.definitions as Array<Record<string, unknown>>)[0];
  assert.equal(definition.path, "src/math.ts");
  assert.equal(definition.kind, "class");
  assert.equal(definition.exported, true);
  assert.match(String(definition.signature), /class Calculator/);

  const methods = await execute(index, "find_symbol", { query: "multiply", kind: "method" });
  assert.equal(methods.match_count, 1);
  assert.equal((methods.definitions as Array<Record<string, unknown>>)[0].container, "Calculator");
});

test("references keep same-name definitions separate and resolve import aliases", async () => {
  const { index } = await fixture();
  const ambiguous = await execute(index, "find_references", { symbol: "add" });
  assert.equal(ambiguous.ambiguous, true);
  assert.equal((ambiguous.definitions as unknown[]).length, 2);

  const selected = await execute(index, "find_references", { symbol: "add", defined_in: "src/math.ts", limit: 20 });
  assert.equal(selected.ambiguous, false);
  const references = selected.references as Array<Record<string, unknown>>;
  assert.ok(references.some((reference) => reference.path === "src/service.ts" && reference.name === "sum"));
  assert.ok(references.some((reference) => reference.path === "src/service.ts" && reference.qualifier === "math"));
  assert.ok(references.some((reference) => reference.path === "src/math.ts" && reference.container === "Calculator.total"));
  assert.ok(!references.some((reference) => reference.path === "src/other.ts"));
});

test("caller search resolves direct alias namespace method and constructor calls", async () => {
  const { index } = await fixture();
  const add = await execute(index, "find_callers", { symbol: "add", defined_in: "src/math.ts" });
  const addCalls = add.calls as Array<Record<string, unknown>>;
  assert.ok(addCalls.some((call) => call.path === "src/service.ts" && call.name === "sum"));
  assert.ok(addCalls.some((call) => call.path === "src/service.ts" && call.qualifier === "math"));
  assert.ok(addCalls.some((call) => call.container === "Calculator.total"));

  const multiply = await execute(index, "find_callers", { symbol: "multiply", defined_in: "src/math.ts" });
  assert.ok((multiply.calls as Array<Record<string, unknown>>).some((call) => call.path === "src/service.ts" && call.qualifier === "calculator"));

  const constructor = await execute(index, "find_callers", { symbol: "Calculator", defined_in: "src/math.ts" });
  assert.ok((constructor.calls as Array<Record<string, unknown>>).some((call) => call.path === "src/service.ts" && call.call_kind === "construct"));
});

test("default imports and CommonJS require dependencies resolve without matching unrelated exports", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-code-modules-"));
  await fs.writeFile(path.join(cwd, "handler.ts"), `
export default function defaultHandler(): number { return 1; }
export function namedHandler(): number { return 2; }
`);
  await fs.writeFile(path.join(cwd, "consumer.ts"), `
import run from "./handler.js";
export const result = run();
`);
  await fs.writeFile(path.join(cwd, "legacy.cjs"), `
const handlers = require("./handler.js");
module.exports = handlers.namedHandler();
`);
  const index = new ProjectIndex(cwd);
  await index.initialize();
  const map = await execute(index, "repository_map", {});
  assert.equal(map.dependency_count, 2);

  const defaults = await execute(index, "find_callers", { symbol: "defaultHandler", defined_in: "handler.ts" });
  assert.ok((defaults.calls as Array<Record<string, unknown>>).some((call) => call.path === "consumer.ts" && call.name === "run"));
  assert.ok(!(defaults.calls as Array<Record<string, unknown>>).some((call) => call.path === "legacy.cjs"));

  const named = await execute(index, "find_callers", { symbol: "namedHandler", defined_in: "handler.ts" });
  assert.ok((named.calls as Array<Record<string, unknown>>).some((call) => call.path === "legacy.cjs" && call.qualifier === "handlers"));
});

test("unsupported languages remain visible without fabricated symbols", async () => {
  const { index } = await fixture();
  const map = await execute(index, "repository_map", { path: "worker.py" });
  const worker = (map.modules as Array<Record<string, unknown>>)[0];
  assert.equal(worker.language, "Python");
  assert.equal(worker.analyzed, false);
  assert.deepEqual(worker.symbols, []);
});

test("symbol intelligence is reused and only a changed file is reparsed", async () => {
  const { cwd, index } = await fixture();
  const initialSymbols = index.status().symbols;
  assert.ok(initialSymbols > 0);

  const cached = new ProjectIndex(cwd);
  await cached.initialize();
  assert.equal(cached.status().mode, "cache");
  assert.equal(cached.status().indexed, 0);
  assert.equal(cached.status().symbols, initialSymbols);

  const service = path.join(cwd, "src", "service.ts");
  await fs.appendFile(service, "\nexport function recentlyAddedSymbol(): number { return 7; }\n");
  await fs.utimes(service, new Date(), new Date(Date.now() + 2_000));
  const incremental = new ProjectIndex(cwd);
  await incremental.initialize();
  assert.equal(incremental.status().mode, "incremental");
  assert.equal(incremental.status().indexed, 1);
  assert.equal(incremental.status().updated, 1);
  const result = await execute(incremental, "find_symbol", { query: "recentlyAddedSymbol" });
  assert.equal(result.match_count, 1);
});

test("repository and symbol tools reject unsafe paths and bound result pages", async () => {
  const { cwd, index } = await fixture();
  const generated = Array.from({ length: 130 }, (_, item) => `export const generatedSymbol${item} = ${item};`).join("\n");
  const many = path.join(cwd, "src", "many.ts");
  await fs.writeFile(many, generated);
  await fs.utimes(many, new Date(), new Date(Date.now() + 2_000));
  index.invalidate();
  const page = await execute(index, "find_symbol", { query: "generatedSymbol", limit: 10, offset: 0 });
  assert.equal((page.definitions as unknown[]).length, 10);
  assert.equal(page.next_offset, 10);
  await assert.rejects(() => execute(index, "repository_map", { path: "../outside" }), /workspace-relative/);
  await assert.rejects(() => execute(index, "find_references", { symbol: "add", defined_in: "C:\\outside.ts" }), /workspace-relative/);
});

test("repository map bounds directory summaries in unusually wide projects", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-wide-map-"));
  for (let item = 0; item < 105; item += 1) {
    const directory = path.join(cwd, `module-${String(item).padStart(3, "0")}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "index.ts"), `export const value${item} = ${item};\n`);
  }
  const index = new ProjectIndex(cwd);
  const map = await execute(index, "repository_map", { limit: 1 });
  assert.equal((map.directories as unknown[]).length, 100);
  assert.equal(map.directories_truncated, true);
  assert.ok(JSON.stringify(map).length < 60_000);
});
