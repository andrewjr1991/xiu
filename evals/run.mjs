import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Agent } from "../dist/agent.js";
import { TaskRunJournal } from "../dist/task-run.js";
import { changedFiles, loadSuite, loadTask, readJson, redact, resultsRoot, snapshotWorkspace, summarize, validateResult, writeJson } from "./lib/core.mjs";
import { createIsolation } from "./lib/isolation.mjs";
import { ScriptedEvaluationProvider } from "./lib/provider.mjs";
import { classifyFailure, enforceTrialBudget, scrubSensitiveEnvironment, TaskAssertionError } from "./lib/policy.mjs";
import { createEvaluationTools } from "./lib/tools.mjs";

function argumentsOf(argv) {
  const result = { suite: "smoke", trials: 1, mode: "simulated", output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--suite", "--trials", "--mode", "--output"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--trials") result.trials = Number(value);
    else result[flag.slice(2)] = value;
  }
  if (!Number.isSafeInteger(result.trials) || result.trials < 1 || result.trials > 10) throw new Error("--trials must be an integer from 1 to 10.");
  if (result.mode !== "simulated") throw new Error("Real-model evaluation is intentionally disabled until its Provider, model, and spend budget are separately approved.");
  return result;
}

async function gitCommit() {
  const head = path.resolve(".git", "HEAD");
  const value = await fs.readFile(head, "utf8").catch(() => "unknown");
  if (!value.startsWith("ref: ")) return value.trim();
  return fs.readFile(path.resolve(".git", value.slice(5).trim()), "utf8").then((item) => item.trim(), () => "unknown");
}

async function runJournalRecovery(task, isolation) {
  const journalRoot = path.join(isolation.home, ".xiu", "task-runs");
  const journal = new TaskRunJournal(isolation.workspace, journalRoot);
  const run = await journal.begin({ sessionId: "eval", task: task.prompt, providerId: "eval-simulated", model: "scripted" });
  const operation = await journal.beginOperation({ kind: "tool", name: "external_write", risk: "dangerous", sideEffect: "unknown" });
  await journal.recoveryPoint("tool", "operation started; outcome unknown", operation);
  const runFile = path.join(journalRoot, journal.workspaceId, `${run.runId}.json`);
  const persisted = JSON.parse(await fs.readFile(runFile, "utf8"));
  persisted.ownerPid = 2147483647;
  await fs.writeFile(runFile, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  const interrupted = await new TaskRunJournal(isolation.workspace, journalRoot).interrupted();
  if (!interrupted || interrupted.runId !== run.runId || interrupted.pendingSideEffects.length !== 1) throw new Error("Interrupted journal was not recovered with its pending side effect.");
  return {
    answer: interrupted.recommendation,
    diagnostics: { outcome: "completed", model: { attempts: 0, inputTokens: 0, outputTokens: 0, failures: 0, retries: 0 }, tools: { calls: 0, failures: 0 }, approvals: { requests: 0, denied: 0 } },
    recovery: { pendingSideEffects: interrupted.pendingSideEffects.length, replayed: false },
  };
}

async function runAgentTask(task, isolation, approvals) {
  const provider = new ScriptedEvaluationProvider(task.simulation.turns);
  const allowedRisks = new Set(task.allowedRisks);
  const approve = async (request) => {
    const approved = allowedRisks.has(request.risk);
    approvals.push({ risk: request.risk, approved, description: request.description });
    return approved;
  };
  const agent = new Agent({
    provider: "openai-compatible", providerId: "eval-simulated", providerLabel: "Evaluation simulation", model: "scripted-v1",
    cwd: isolation.workspace, maxTurns: task.budget.modelCalls, autoApprove: false, projectConfigurationTrusted: true, sessionNamespace: "eval-sessions",
    taskBudget: { tokens: task.budget.inputTokens + task.budget.outputTokens, modelCalls: task.budget.modelCalls, toolCalls: task.budget.toolCalls, wallTimeMs: task.budget.timeoutMs, warningRatio: 0.8 },
  }, provider, createEvaluationTools(isolation.workspace), approve);
  const answer = await agent.run(task.prompt);
  return { answer, diagnostics: agent.status().diagnostics, recovery: undefined };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Evaluation timed out after ${timeoutMs} ms.`)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTrial(loaded, trialNumber) {
  const { task, directory } = loaded;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const isolation = await createIsolation(directory);
  const approvals = [];
  try {
    const before = await snapshotWorkspace(isolation.workspace);
    const execution = await withTimeout(task.engine === "journal-recovery" ? runJournalRecovery(task, isolation) : runAgentTask(task, isolation, approvals), task.budget.timeoutMs);
    const after = await snapshotWorkspace(isolation.workspace);
    const files = changedFiles(before, after);
    const unrelated = files.filter((file) => !task.allowedChanges.includes(file));
    const assertion = await import(`${pathToFileURL(path.join(directory, "assert.mjs")).href}?trial=${randomUUID()}`);
    const resultForAssertion = { changedFiles: files, approvals, recovery: execution.recovery, diagnostics: execution.diagnostics };
    if (typeof assertion.default !== "function") throw new Error("Task assertion module has no default function.");
    try {
      await assertion.default({ workspace: isolation.workspace, answer: execution.answer, result: resultForAssertion });
    } catch (error) {
      throw new TaskAssertionError(error instanceof Error ? error.message : String(error));
    }
    if (unrelated.length) throw new TaskAssertionError(`Files outside the allowlist changed: ${unrelated.join(", ")}.`);
    const diagnostics = execution.diagnostics;
    enforceTrialBudget(task, diagnostics);
    return redact({
      taskId: task.id, revision: task.revision, category: task.category, trial: trialNumber, passed: true,
      verified: task.engine === "journal-recovery" || task.category === "architecture" || task.category === "safety" || diagnostics?.outcome === "completed",
      failureType: null, failure: null, changedFiles: files, unrelatedFiles: unrelated, approvals, recovery: execution.recovery, answer: execution.answer,
      metrics: {
        inputTokens: diagnostics?.model?.inputTokens ?? 0, outputTokens: diagnostics?.model?.outputTokens ?? 0,
        modelCalls: diagnostics?.model?.attempts ?? 0, toolCalls: diagnostics?.tools?.calls ?? 0,
        retries: diagnostics?.model?.retries ?? 0, approvals: approvals.length, durationMs: Math.round(performance.now() - started), unrelatedFiles: unrelated.length,
      },
      startedAt, finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureType = classifyFailure(error, task.category);
    return redact({ taskId: task.id, revision: task.revision, category: task.category, trial: trialNumber, passed: false, verified: false, failureType, failure: message, changedFiles: [], unrelatedFiles: [], approvals, metrics: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, retries: 0, approvals: approvals.length, durationMs: Math.round(performance.now() - started), unrelatedFiles: 0 }, startedAt, finishedAt: new Date().toISOString() });
  } finally {
    await isolation.cleanup();
  }
}

try {
  const options = argumentsOf(process.argv.slice(2));
  const scrubbedEnvironmentVariables = scrubSensitiveEnvironment();
  const { suite, hash: suiteHash } = await loadSuite(options.suite);
  const manifest = await readJson(path.resolve("package.json"));
  const startedAt = new Date().toISOString();
  const trials = [];
  const runId = randomUUID();
  const output = options.output ? path.resolve(options.output) : path.join(resultsRoot, `${suite.id}-${runId}.json`);
  const base = { protocolVersion: 1, runId, mode: options.mode, suite: suite.id, suiteHash, xiu: { version: manifest.version, commit: await gitCommit() }, environment: { node: process.version, platform: process.platform, arch: process.arch, provider: "eval-simulated", model: "scripted-v1", providerCredentialsPresent: false, scrubbedSensitiveVariables: scrubbedEnvironmentVariables }, startedAt };
  await writeJson(output, validateResult(redact({ ...base, state: "running", finishedAt: startedAt, trials, summary: summarize(trials) })));
  for (const reference of suite.tasks) {
    const loaded = await loadTask(reference.id, reference.revision);
    for (let number = 1; number <= options.trials; number += 1) {
      const result = await runTrial(loaded, number);
      trials.push(result);
      console.log(`${result.passed ? "PASS" : "FAIL"} ${reference.id} trial ${number}${result.failure ? `: ${result.failure}` : ""}`);
      await writeJson(output, validateResult(redact({ ...base, state: "running", finishedAt: new Date().toISOString(), trials, summary: summarize(trials) })), { replace: true });
    }
  }
  const run = validateResult(redact({ ...base, state: "completed", finishedAt: new Date().toISOString(), trials, summary: summarize(trials) }));
  await writeJson(output, run, { replace: true });
  console.log(`Result: ${output}`);
  console.log(`Passed ${run.summary.passed}/${run.summary.eligibleTrials}; infrastructure failures ${run.summary.failures.harness ?? 0}.`);
  if (trials.some((trial) => !trial.passed)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
