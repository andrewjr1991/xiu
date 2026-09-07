import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resultsRoot, safeWorkspacePath, sha256, stableJson, summarize, validateResult } from "./core.mjs";

const budgetFields = ["modelCalls", "toolCalls", "inputTokens", "outputTokens", "durationMs"];

export function realConfigHash(config) {
  return sha256(stableJson(config));
}

export async function realExecutionHash(loadedTasks) {
  const files = [
    "evals/real-run.mjs", "evals/lib/assertions.mjs", "evals/lib/core.mjs", "evals/lib/isolation.mjs", "evals/lib/policy.mjs",
    "evals/lib/real-policy.mjs", "evals/lib/real-resume.mjs", "evals/lib/registry-artifact.mjs", "evals/lib/tools.mjs",
    ...loadedTasks.flatMap((item) => [path.join(item.directory, "task.json"), path.join(item.directory, "assert.mjs")]),
  ].map((file) => path.resolve(file)).sort((left, right) => left.localeCompare(right, "en"));
  const chunks = [];
  for (const file of files) chunks.push(path.relative(process.cwd(), file).split(path.sep).join("/"), "\0", await fs.readFile(file, "utf8"), "\0");
  return sha256(chunks.join(""));
}

export function trialSlots(suite, trialsPerTask) {
  return suite.tasks.flatMap((reference) => Array.from({ length: trialsPerTask }, (_, index) => ({ taskId: reference.id, revision: reference.revision, trial: index + 1 })));
}

function requireCounter(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Resume result has an invalid ${label}.`);
}

function validateLedger(result, config) {
  if (!result.ledger || typeof result.ledger !== "object") throw new Error("Resume result has no cumulative ledger.");
  for (const field of budgetFields) {
    requireCounter(result.ledger[field], `ledger.${field}`);
    if (result.ledger[field] > config.globalBudget[field]) throw new Error(`Resume result exceeds the global ${field} budget.`);
  }
  requireCounter(result.ledger.estimatedCostUsd, "ledger.estimatedCostUsd");
  if (result.ledger.estimatedCostUsd > config.billing.authorizationLimitUsd) throw new Error("Resume result exceeds the USD authorization limit.");
  for (const field of ["modelCalls", "toolCalls", "inputTokens", "outputTokens"]) {
    if (result.ledger[field] !== result.summary[field]) throw new Error(`Resume ledger ${field} does not match its trial summary.`);
  }
  if (result.ledger.durationMs < result.summary.durationMs) throw new Error("Resume ledger duration is below its trial summary.");
}

function validateTrialPrefix(result, slots, loadedTasks) {
  if (result.trials.length >= slots.length) throw new Error("Resume result has no unrecorded trial remaining.");
  const tasks = new Map(loadedTasks.map((item) => [item.task.id, item.task]));
  for (const [index, trial] of result.trials.entries()) {
    const expected = slots[index];
    if (trial.taskId !== expected.taskId || trial.revision !== expected.revision || trial.trial !== expected.trial) {
      throw new Error(`Resume result is not an exact ordered trial prefix at position ${index + 1}.`);
    }
    const task = tasks.get(trial.taskId);
    if (!task || trial.category !== task.category) throw new Error(`Resume result has a mismatched category for ${trial.taskId}.`);
    for (const field of ["modelCalls", "toolCalls", "inputTokens", "outputTokens", "durationMs", "retries", "approvals", "unrelatedFiles", "estimatedCostUsd"]) requireCounter(trial.metrics?.[field], `${trial.taskId} trial ${trial.trial} metrics.${field}`);
    for (const [field, budgetField] of [["modelCalls", "modelCalls"], ["toolCalls", "toolCalls"], ["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"]]) {
      if (trial.metrics[field] > task.budget[budgetField]) throw new Error(`Resume result trial ${trial.taskId}:${trial.trial} exceeds its ${field} budget.`);
    }
    for (const field of ["changedFiles", "unrelatedFiles", "approvals"]) if (!Array.isArray(trial[field])) throw new Error(`Resume result trial ${trial.taskId}:${trial.trial} has invalid ${field}.`);
    if (trial.changedFiles.some((file) => typeof file !== "string") || trial.unrelatedFiles.some((file) => typeof file !== "string")) throw new Error(`Resume result trial ${trial.taskId}:${trial.trial} has an invalid file summary.`);
    try { for (const file of trial.changedFiles) safeWorkspacePath(resultsRoot, file); } catch { throw new Error(`Resume result trial ${trial.taskId}:${trial.trial} has an unsafe file summary.`); }
    const expectedUnrelated = trial.changedFiles.filter((file) => !task.allowedChanges.includes(file)).sort();
    if (stableJson(trial.unrelatedFiles) !== stableJson(expectedUnrelated) || trial.metrics.unrelatedFiles !== expectedUnrelated.length) throw new Error(`Resume result trial ${trial.taskId}:${trial.trial} has an inconsistent unrelated-file summary.`);
    if (trial.approvals.some((approval) => !approval || typeof approval.risk !== "string" || typeof approval.approved !== "boolean" || typeof approval.description !== "string" || Object.keys(approval).some((key) => !["risk", "approved", "description"].includes(key)))) throw new Error(`Resume result trial ${trial.taskId}:${trial.trial} has an invalid approval summary.`);
  }
  if (result.state === "stopped" && (!result.trials.length || result.trials.at(-1).failureType !== "budget")) throw new Error("A stopped resume result must end with a recorded budget failure.");
  if (stableJson(result.summary) !== stableJson(summarize(result.trials))) throw new Error("Resume result summary does not match its trials.");
  const trialCost = result.trials.reduce((total, trial) => total + trial.metrics.estimatedCostUsd, 0);
  if (Math.abs(trialCost - result.ledger.estimatedCostUsd) > 1e-8) throw new Error("Resume ledger cost does not match its trials.");
}

function validateRemainingBudget(result, slots, loadedTasks, remainingBudget) {
  const tasks = new Map(loadedTasks.map((item) => [item.task.id, item.task]));
  const required = Object.fromEntries(budgetFields.map((field) => [field, 0]));
  for (const slot of slots.slice(result.trials.length)) {
    const budget = tasks.get(slot.taskId).budget;
    for (const field of budgetFields) required[field] += budget[field === "durationMs" ? "timeoutMs" : field];
  }
  for (const field of budgetFields) if (required[field] > remainingBudget[field]) throw new Error(`Resume result leaves insufficient ${field} budget for the unrecorded trials.`);
  return required;
}

async function safeResultFile(input) {
  const candidate = path.resolve(input);
  if (path.extname(candidate).toLowerCase() !== ".json") throw new Error("Resume source must be a JSON result file.");
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Resume source must be a regular file, not a link.");
  const [root, real] = await Promise.all([fs.realpath(resultsRoot), fs.realpath(candidate)]);
  if (path.dirname(real) !== root) throw new Error("Resume source must be a direct file in evals/results.");
  return real;
}

export async function loadRealResume(input, context) {
  const file = await safeResultFile(input);
  const bytes = await fs.readFile(file);
  const result = validateResult(JSON.parse(bytes.toString("utf8")));
  if (result.mode !== "real" || !["stopped", "interrupted"].includes(result.state)) throw new Error("Only stopped or interrupted real-evaluation results can be resumed.");
  if (result.configHash !== context.configHash || result.suite !== context.suite.id || result.suiteHash !== context.suiteHash || result.executionHash !== context.executionHash) {
    throw new Error("Resume result configuration, suite, or execution hash does not match the current evaluation.");
  }
  if (result.xiu?.package !== context.metadata.packageName || result.xiu?.version !== context.metadata.version || result.xiu?.integrity !== context.metadata.integrity) {
    throw new Error("Resume result does not match the approved Registry artifact.");
  }
  if (result.environment?.provider !== context.config.provider.id || result.environment?.model !== context.config.provider.model) throw new Error("Resume result Provider or model does not match.");
  if (stableJson(result.globalBudget) !== stableJson(context.config.globalBudget)) throw new Error("Resume result global budget does not match the current configuration.");
  const slots = trialSlots(context.suite, context.config.trials);
  validateLedger(result, context.config);
  validateTrialPrefix(result, slots, context.loadedTasks);
  const digest = sha256(bytes);
  const remainingBudget = Object.fromEntries(budgetFields.map((field) => [field, context.config.globalBudget[field] - result.ledger[field]]));
  const requiredBudget = validateRemainingBudget(result, slots, context.loadedTasks, remainingBudget);
  return {
    file,
    digest,
    result,
    slots,
    nextSlot: slots[result.trials.length],
    remainingBudget,
    requiredBudget,
    binding: { resultSha256: digest, sourceRunId: result.runId, recordedTrials: result.trials.length, nextSlot: slots[result.trials.length] },
  };
}
