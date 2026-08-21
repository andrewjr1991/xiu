import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { changedFiles, loadSuite, loadTask, readJson, redact, resultsRoot, snapshotWorkspace, summarize, validateResult, writeJson } from "./lib/core.mjs";
import { createIsolation } from "./lib/isolation.mjs";
import { classifyFailure, enforceTrialBudget, TaskAssertionError } from "./lib/policy.mjs";
import { RealEvaluationLedger, realConfirmationToken, validateRealConfig, validateSuiteBudget } from "./lib/real-policy.mjs";
import { fetchArtifactMetadata, installVerifiedArtifact } from "./lib/registry-artifact.mjs";
import { createEvaluationTools } from "./lib/tools.mjs";

function parseArguments(argv) {
  const result = { config: "evals/configs/agnes-enterprise-v0.17.0.json", confirm: undefined, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--config", "--confirm", "--output"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    result[flag.slice(2)] = value;
  }
  return result;
}

function printPreview(config, suite, metadata, token) {
  const totalTrials = suite.tasks.length * config.trials;
  console.log("REAL MODEL EVALUATION — no calls have been made");
  console.log(`Target: ${metadata.packageName}@${metadata.version}`);
  console.log(`Integrity: ${metadata.integrity}`);
  console.log(`Suite: ${suite.id} (${suite.tasks.length} tasks × ${config.trials} trials = ${totalTrials} trials)`);
  console.log(`Provider/model: ${config.provider.id} / ${config.provider.model}`);
  console.log(`Billing: Enterprise, model attested free; authorization ceiling ${config.billing.authorizationLimitUsd} ${config.billing.currency}`);
  console.log(`Global limits: ${config.globalBudget.modelCalls} model calls, ${config.globalBudget.toolCalls} tool calls, ${config.globalBudget.inputTokens} input tokens, ${config.globalBudget.outputTokens} output tokens, ${Math.round(config.globalBudget.durationMs / 60000)} minutes`);
  console.log(`Credential: ${config.provider.apiKeyEnv} (presence checked only after confirmation; value is never logged)`);
  console.log(`Confirmation token: ${token}`);
}

function meteredProvider(provider, ledger) {
  return {
    async complete(...args) {
      ledger.assertCanStartModelCall();
      const turn = await provider.complete(...args);
      ledger.recordModelTurn(turn);
      return turn;
    },
    ...(provider.stream ? { async stream(...args) {
      ledger.assertCanStartModelCall();
      const turn = await provider.stream(...args);
      ledger.recordModelTurn(turn);
      return turn;
    } } : {}),
  };
}

async function runRecoveryTask(task, isolation, TaskRunJournal) {
  const journalRoot = path.join(isolation.home, ".xiu", "task-runs");
  const journal = new TaskRunJournal(isolation.workspace, journalRoot);
  const run = await journal.begin({ sessionId: "real-eval", task: task.prompt, providerId: "agnes", model: "agnes-2.5-flash" });
  const operation = await journal.beginOperation({ kind: "tool", name: "external_write", risk: "dangerous", sideEffect: "unknown" });
  await journal.recoveryPoint("tool", "operation started; outcome unknown", operation);
  const runFile = path.join(journalRoot, journal.workspaceId, `${run.runId}.json`);
  const persisted = JSON.parse(await fs.readFile(runFile, "utf8"));
  persisted.ownerPid = 2147483647;
  await fs.writeFile(runFile, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  const interrupted = await new TaskRunJournal(isolation.workspace, journalRoot).interrupted();
  if (!interrupted || interrupted.runId !== run.runId || interrupted.pendingSideEffects.length !== 1) throw new Error("Interrupted v0.17.0 journal did not preserve its pending side effect.");
  return {
    answer: interrupted.recommendation,
    diagnostics: { outcome: "completed", model: { attempts: 0, inputTokens: 0, outputTokens: 0, failures: 0, retries: 0 }, tools: { calls: 0, failures: 0 }, approvals: { requests: 0, denied: 0 } },
    recovery: { pendingSideEffects: interrupted.pendingSideEffects.length, replayed: false },
  };
}

async function runAgentTask(task, isolation, approvals, runtime, ledger, active) {
  const provider = runtime.createProvider({
    provider: "agnes", providerId: "agnes", providerLabel: "Agnes Enterprise evaluation", apiKeyEnv: "AGNES_API_KEY",
    model: "agnes-2.5-flash", baseURL: "https://apihub.agnes-ai.com/v1", cwd: isolation.workspace, maxTurns: task.budget.modelCalls,
    autoApprove: false, projectConfigurationTrusted: true, sessionNamespace: "real-eval-sessions",
    taskBudget: { tokens: task.budget.inputTokens + task.budget.outputTokens, modelCalls: task.budget.modelCalls, toolCalls: task.budget.toolCalls, wallTimeMs: task.budget.timeoutMs, warningRatio: 0.8 },
  });
  const allowedRisks = new Set(task.allowedRisks);
  const approve = async (request) => {
    const approved = allowedRisks.has(request.risk);
    approvals.push({ risk: request.risk, approved, description: request.description });
    return approved;
  };
  const agent = new runtime.Agent({
    provider: "agnes", providerId: "agnes", providerLabel: "Agnes Enterprise evaluation", apiKeyEnv: "AGNES_API_KEY",
    model: "agnes-2.5-flash", baseURL: "https://apihub.agnes-ai.com/v1", cwd: isolation.workspace, maxTurns: task.budget.modelCalls,
    autoApprove: false, projectConfigurationTrusted: true, sessionNamespace: "real-eval-sessions",
    taskBudget: { tokens: task.budget.inputTokens + task.budget.outputTokens, modelCalls: task.budget.modelCalls, toolCalls: task.budget.toolCalls, wallTimeMs: task.budget.timeoutMs, warningRatio: 0.8 },
  }, meteredProvider(provider, ledger), createEvaluationTools(isolation.workspace), approve);
  active.agent = agent;
  try {
    const answer = await agent.run(task.prompt);
    return { answer, diagnostics: agent.status().diagnostics, recovery: undefined };
  } finally {
    active.agent = undefined;
    ledger.recordTools(agent.status().diagnostics?.tools?.calls ?? 0);
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Evaluation timed out after ${timeoutMs} ms.`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function runTrial(loaded, trialNumber, runtime, ledger, active) {
  const { task, directory } = loaded;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const ledgerBefore = ledger.snapshot();
  const isolation = await createIsolation(directory);
  const approvals = [];
  try {
    ledger.assertWithinBudget();
    const before = await snapshotWorkspace(isolation.workspace);
    const execution = await withTimeout(task.engine === "journal-recovery" ? runRecoveryTask(task, isolation, runtime.TaskRunJournal) : runAgentTask(task, isolation, approvals, runtime, ledger, active), task.budget.timeoutMs);
    const after = await snapshotWorkspace(isolation.workspace);
    const files = changedFiles(before, after);
    const unrelated = files.filter((file) => !task.allowedChanges.includes(file));
    const assertion = await import(`${pathToFileURL(path.join(directory, "assert.mjs")).href}?trial=${randomUUID()}`);
    if (typeof assertion.default !== "function") throw new Error("Task assertion module has no default function.");
    const assertionResult = { changedFiles: files, approvals, recovery: execution.recovery, diagnostics: execution.diagnostics };
    try { await assertion.default({ workspace: isolation.workspace, answer: execution.answer, result: assertionResult }); }
    catch (error) { throw new TaskAssertionError(error instanceof Error ? error.message : String(error)); }
    if (unrelated.length) throw new TaskAssertionError(`Files outside the allowlist changed: ${unrelated.join(", ")}.`);
    enforceTrialBudget(task, execution.diagnostics);
    const ledgerAfter = ledger.snapshot();
    return redact({ taskId: task.id, revision: task.revision, category: task.category, trial: trialNumber, passed: true, verified: task.engine === "journal-recovery" || task.category === "architecture" || task.category === "safety" || execution.diagnostics?.outcome === "completed", failureType: null, failure: null, changedFiles: files, unrelatedFiles: unrelated, approvals, recovery: execution.recovery, answer: execution.answer, metrics: { inputTokens: ledgerAfter.inputTokens - ledgerBefore.inputTokens, outputTokens: ledgerAfter.outputTokens - ledgerBefore.outputTokens, modelCalls: ledgerAfter.modelCalls - ledgerBefore.modelCalls, toolCalls: ledgerAfter.toolCalls - ledgerBefore.toolCalls, approvals: approvals.length, durationMs: Math.round(performance.now() - started), unrelatedFiles: unrelated.length, estimatedCostUsd: ledgerAfter.estimatedCostUsd - ledgerBefore.estimatedCostUsd }, startedAt, finishedAt: new Date().toISOString() });
  } catch (error) {
    const after = ledger.snapshot();
    return redact({ taskId: task.id, revision: task.revision, category: task.category, trial: trialNumber, passed: false, verified: false, failureType: classifyFailure(error, task.category), failure: error instanceof Error ? error.message : String(error), changedFiles: [], unrelatedFiles: [], approvals, metrics: { inputTokens: after.inputTokens - ledgerBefore.inputTokens, outputTokens: after.outputTokens - ledgerBefore.outputTokens, modelCalls: after.modelCalls - ledgerBefore.modelCalls, toolCalls: after.toolCalls - ledgerBefore.toolCalls, approvals: approvals.length, durationMs: Math.round(performance.now() - started), unrelatedFiles: 0, estimatedCostUsd: after.estimatedCostUsd - ledgerBefore.estimatedCostUsd }, startedAt, finishedAt: new Date().toISOString() });
  } finally {
    await isolation.cleanup();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = validateRealConfig(await readJson(path.resolve(options.config)));
  const { suite, hash: suiteHash } = await loadSuite(config.suite);
  const loadedTasks = [];
  for (const reference of suite.tasks) loadedTasks.push(await loadTask(reference.id, reference.revision));
  validateSuiteBudget(config, loadedTasks.map((item) => item.task));
  const metadata = await fetchArtifactMetadata(config.target.package, config.target.version);
  const token = realConfirmationToken(config, suiteHash, metadata.integrity);
  printPreview(config, suite, metadata, token);
  if (!options.confirm) {
    console.log("No real model calls were made. Re-run with --confirm <token> only after reviewing this preview.");
    return;
  }
  if (options.confirm !== token) throw new Error("Confirmation token does not match the exact configuration, suite, and Registry artifact.");
  if (!process.env[config.provider.apiKeyEnv]) throw new Error(`${config.provider.apiKeyEnv} is not set. No model calls were made.`);

  const artifact = await installVerifiedArtifact(metadata);
  const active = { agent: undefined, interrupted: false };
  const onInterrupt = () => { active.interrupted = true; active.agent?.cancel(); };
  process.once("SIGINT", onInterrupt);
  try {
    const query = `?integrity=${encodeURIComponent(metadata.integrity)}`;
    const [{ Agent }, { createProvider }, { TaskRunJournal }] = await Promise.all([
      import(`${pathToFileURL(path.join(artifact.moduleRoot, "dist", "agent.js")).href}${query}`),
      import(`${pathToFileURL(path.join(artifact.moduleRoot, "dist", "providers.js")).href}${query}`),
      import(`${pathToFileURL(path.join(artifact.moduleRoot, "dist", "task-run.js")).href}${query}`),
    ]);
    const runtime = { Agent, createProvider, TaskRunJournal };
    const ledger = new RealEvaluationLedger(config);
    const runId = randomUUID();
    const output = options.output ? path.resolve(options.output) : path.join(resultsRoot, `real-${config.id}-${runId}.json`);
    const startedAt = new Date().toISOString();
    const trials = [];
    const base = { protocolVersion: 1, runId, mode: "real", suite: suite.id, suiteHash, xiu: { version: metadata.version, package: metadata.packageName, integrity: metadata.integrity }, environment: { node: process.version, platform: process.platform, arch: process.arch, provider: config.provider.id, model: config.provider.model }, billing: config.billing, globalBudget: config.globalBudget, startedAt };
    await writeJson(output, validateResult(redact({ ...base, state: "running", finishedAt: startedAt, trials, summary: summarize(trials), ledger: ledger.snapshot() })));
    try {
      for (const reference of suite.tasks) {
        const loaded = await loadTask(reference.id, reference.revision);
        for (let number = 1; number <= config.trials; number += 1) {
          if (active.interrupted) throw new Error("Real evaluation interrupted by user.");
          const result = await runTrial(loaded, number, runtime, ledger, active);
          trials.push(result);
          console.log(`${result.passed ? "PASS" : "FAIL"} ${reference.id} trial ${number}${result.failure ? `: ${result.failure}` : ""}`);
          await writeJson(output, validateResult(redact({ ...base, state: "running", finishedAt: new Date().toISOString(), trials, summary: summarize(trials), ledger: ledger.snapshot() })), { replace: true });
          if (["budget", "interrupted"].includes(result.failureType)) throw new Error(result.failure);
        }
      }
    } catch (error) {
      const state = active.interrupted || /interrupted/i.test(error instanceof Error ? error.message : String(error)) ? "interrupted" : "stopped";
      await writeJson(output, validateResult(redact({ ...base, state, finishedAt: new Date().toISOString(), trials, summary: summarize(trials), ledger: ledger.snapshot(), stopReason: error instanceof Error ? error.message : String(error) })), { replace: true });
      throw error;
    }
    const report = validateResult(redact({ ...base, state: "completed", finishedAt: new Date().toISOString(), trials, summary: summarize(trials), ledger: ledger.snapshot() }));
    await writeJson(output, report, { replace: true });
    console.log(`Result: ${output}`);
    console.log(`Passed ${report.summary.passed}/${report.summary.eligibleTrials}; estimated cost ${report.ledger.estimatedCostUsd.toFixed(2)} USD.`);
    if (trials.some((trial) => !trial.passed)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await artifact.cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
