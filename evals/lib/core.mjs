import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const resultsRoot = path.join(evalRoot, "results");
const categories = new Set(["single-file", "cross-file", "tests", "architecture", "recovery", "safety"]);
const engines = new Set(["agent", "journal-recovery"]);
const risks = new Set(["write", "execute"]);
const taskKeys = new Set(["protocolVersion", "id", "revision", "category", "prompt", "engine", "fixtureHash", "allowedChanges", "allowedRisks", "forbiddenSideEffects", "budget", "simulation"]);
const budgetKeys = new Set(["timeoutMs", "modelCalls", "toolCalls", "inputTokens", "outputTokens"]);
const simulationTools = new Map([["eval_read_file", "read"], ["eval_write_file", "write"], ["eval_replace_text", "write"], ["eval_verify", "execute"]]);

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directoryEntries(root, current = root) {
  const entries = [];
  for (const item of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, item.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Fixture contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) entries.push(...await directoryEntries(root, absolute));
    else if (stat.isFile()) entries.push({ relative, absolute });
    else throw new Error(`Fixture contains an unsupported entry: ${relative}`);
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

export async function hashDirectory(root) {
  const hash = createHash("sha256");
  for (const entry of await directoryEntries(root)) {
    hash.update(entry.relative).update("\0").update(await fs.readFile(entry.absolute)).update("\0");
  }
  return hash.digest("hex");
}

function requireString(value, label, maximum = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string up to ${maximum} characters.`);
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
}

function requireStringArray(value, label, allowed) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (allowed && !allowed.has(item))) || new Set(value).size !== value.length) {
    throw new Error(`${label} must be a unique string array.`);
  }
}

export async function loadTask(id, expectedRevision) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new Error(`Unsafe task id: ${id}`);
  const directory = path.join(evalRoot, "tasks", id);
  const task = await readJson(path.join(directory, "task.json"));
  const unknownKeys = Object.keys(task).filter((key) => !taskKeys.has(key));
  if (unknownKeys.length) throw new Error(`${id}: unknown task field(s): ${unknownKeys.join(", ")}.`);
  if (task.protocolVersion !== 1 || task.id !== id) throw new Error(`${id}: unsupported protocol or mismatched id.`);
  requireInteger(task.revision, `${id}.revision`, 1, 1000000);
  if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new Error(`${id}: suite requires revision ${expectedRevision}, found ${task.revision}.`);
  if (!categories.has(task.category)) throw new Error(`${id}: unsupported category.`);
  if (!engines.has(task.engine)) throw new Error(`${id}: unsupported engine.`);
  requireString(task.prompt, `${id}.prompt`);
  requireStringArray(task.allowedChanges, `${id}.allowedChanges`);
  for (const relative of task.allowedChanges) {
    if (relative === ".xiu" || relative.startsWith(".xiu/")) throw new Error(`${id}: unsafe allowed change path ${relative}.`);
    try { safeWorkspacePath(path.join(directory, "repo"), relative); }
    catch { throw new Error(`${id}: unsafe allowed change path ${relative}.`); }
  }
  requireStringArray(task.allowedRisks, `${id}.allowedRisks`, risks);
  requireStringArray(task.forbiddenSideEffects, `${id}.forbiddenSideEffects`);
  if (!task.budget || typeof task.budget !== "object") throw new Error(`${id}: budget is required.`);
  const unknownBudgetKeys = Object.keys(task.budget).filter((key) => !budgetKeys.has(key));
  if (unknownBudgetKeys.length) throw new Error(`${id}: unknown budget field(s): ${unknownBudgetKeys.join(", ")}.`);
  requireInteger(task.budget.timeoutMs, `${id}.budget.timeoutMs`, 100, 600000);
  requireInteger(task.budget.modelCalls, `${id}.budget.modelCalls`, 1, 30);
  requireInteger(task.budget.toolCalls, `${id}.budget.toolCalls`, 0, 80);
  requireInteger(task.budget.inputTokens, `${id}.budget.inputTokens`, 1, 200000);
  requireInteger(task.budget.outputTokens, `${id}.budget.outputTokens`, 1, 20000);
  if (!task.simulation || !Array.isArray(task.simulation.turns) || task.simulation.turns.length < 1) throw new Error(`${id}: simulation.turns is required.`);
  if (Object.keys(task.simulation).some((key) => key !== "turns")) throw new Error(`${id}: simulation contains unknown fields.`);
  if (task.simulation.turns.length > task.budget.modelCalls) throw new Error(`${id}: scripted turns exceed the model-call budget.`);
  let scriptedToolCalls = 0;
  for (const [turnIndex, turn] of task.simulation.turns.entries()) {
    if (!turn || typeof turn !== "object" || (turn.text !== undefined && typeof turn.text !== "string") || (turn.toolCalls !== undefined && !Array.isArray(turn.toolCalls))) throw new Error(`${id}: invalid simulation turn ${turnIndex + 1}.`);
    for (const call of turn.toolCalls ?? []) {
      scriptedToolCalls += 1;
      const risk = simulationTools.get(call?.name);
      if (!risk || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) throw new Error(`${id}: invalid simulated tool call in turn ${turnIndex + 1}.`);
      if (risk !== "read" && !task.allowedRisks.includes(risk)) throw new Error(`${id}: simulated ${call.name} is not permitted by allowedRisks.`);
    }
  }
  if (scriptedToolCalls > task.budget.toolCalls) throw new Error(`${id}: scripted tool calls exceed the tool-call budget.`);
  if (task.category === "safety" && (task.allowedChanges.length || task.allowedRisks.length || scriptedToolCalls)) throw new Error(`${id}: safety tasks cannot permit or script side effects.`);
  if (task.engine === "journal-recovery" && task.category !== "recovery") throw new Error(`${id}: journal-recovery engine is only valid for recovery tasks.`);
  const actualHash = await hashDirectory(path.join(directory, "repo"));
  if (task.fixtureHash !== actualHash) throw new Error(`${id}: fixtureHash mismatch; expected ${actualHash}.`);
  await fs.access(path.join(directory, "assert.mjs"));
  return { task, directory, actualHash };
}

export async function loadSuite(name) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) throw new Error(`Unsafe suite name: ${name}`);
  const file = path.join(evalRoot, "suites", `${name}.json`);
  const suite = await readJson(file);
  if (suite.protocolVersion !== 1 || suite.id !== name || !Array.isArray(suite.tasks) || suite.tasks.length < 1) throw new Error(`${name}: invalid suite.`);
  const seen = new Set();
  for (const item of suite.tasks) {
    if (!item || typeof item.id !== "string" || !Number.isSafeInteger(item.revision)) throw new Error(`${name}: invalid task reference.`);
    if (seen.has(item.id)) throw new Error(`${name}: duplicate task ${item.id}.`);
    seen.add(item.id);
  }
  return { suite, hash: sha256(stableJson(suite)) };
}

export async function validateAll() {
  const suites = [];
  for (const entry of (await fs.readdir(path.join(evalRoot, "suites"))).filter((name) => name.endsWith(".json")).sort()) {
    const loaded = await loadSuite(entry.slice(0, -5));
    for (const item of loaded.suite.tasks) await loadTask(item.id, item.revision);
    suites.push({ id: loaded.suite.id, tasks: loaded.suite.tasks.length, hash: loaded.hash });
  }
  return suites;
}

export function safeWorkspacePath(workspace, relative) {
  requireString(relative, "workspace path", 500);
  if (path.isAbsolute(relative)) throw new Error(`Absolute workspace path is forbidden: ${relative}`);
  const segments = relative.split("/");
  if (relative.includes("\\") || relative.includes("\0") || segments.some((part) => !part || part === "." || part === ".." || part.includes(":") || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error(`Unsafe portable workspace path: ${relative}`);
  }
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Workspace path escapes the fixture: ${relative}`);
  return resolved;
}

export async function snapshotWorkspace(workspace) {
  const result = {};
  for (const entry of await directoryEntries(workspace)) {
    if (entry.relative === ".xiu" || entry.relative.startsWith(".xiu/")) continue;
    result[entry.relative] = sha256(await fs.readFile(entry.absolute));
  }
  return result;
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}

export function redact(value, key = "") {
  if (/api.?key|authorization|cookie|client.?secret|password|token$/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(/\b(?:sk|xox[baprs]|ghp)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]").replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  return value;
}

export function summarize(trials) {
  const eligible = trials.filter((trial) => !["provider", "harness", "interrupted"].includes(trial.failureType));
  const sum = (field) => trials.reduce((total, trial) => total + (Number(trial.metrics?.[field]) || 0), 0);
  return {
    trials: trials.length,
    eligibleTrials: eligible.length,
    passed: eligible.filter((trial) => trial.passed).length,
    verified: eligible.filter((trial) => trial.verified).length,
    safetyTrials: eligible.filter((trial) => trial.category === "safety").length,
    safetyPassed: eligible.filter((trial) => trial.category === "safety" && trial.passed).length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    modelCalls: sum("modelCalls"),
    toolCalls: sum("toolCalls"),
    approvals: sum("approvals"),
    durationMs: sum("durationMs"),
    unrelatedFiles: sum("unrelatedFiles"),
    failures: Object.fromEntries([...new Set(trials.map((trial) => trial.failureType).filter(Boolean))].sort().map((type) => [type, trials.filter((trial) => trial.failureType === type).length])),
  };
}

export function validateResult(result) {
  if (!result || result.protocolVersion !== 1 || typeof result.runId !== "string" || !["simulated", "real"].includes(result.mode)) throw new Error("Invalid evaluation result identity.");
  for (const field of ["suite", "suiteHash", "startedAt", "finishedAt"]) if (typeof result[field] !== "string" || !result[field]) throw new Error(`Invalid evaluation result field: ${field}.`);
  if (!result.xiu || typeof result.xiu.version !== "string" || !result.environment || typeof result.environment.node !== "string" || !Array.isArray(result.trials) || !result.summary) throw new Error("Evaluation result is missing required structured data.");
  for (const trial of result.trials) {
    if (typeof trial.taskId !== "string" || !Number.isSafeInteger(trial.revision) || typeof trial.passed !== "boolean" || typeof trial.verified !== "boolean" || !trial.metrics) throw new Error(`Invalid trial result for ${trial.taskId ?? "unknown"}.`);
  }
  return result;
}

export async function writeJson(file, value, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(redact(value), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    if (options.replace) await fs.rename(temporary, file);
    else await fs.copyFile(temporary, file, fs.constants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
