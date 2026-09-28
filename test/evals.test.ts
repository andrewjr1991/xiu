import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSuite, loadTask, redact, removeTemporaryDirectory, resultsRoot, safeWorkspacePath, summarize, validateAll, validateResult } from "../evals/lib/core.mjs";
import { createIsolation } from "../evals/lib/isolation.mjs";
import { classifyFailure, enforceTrialBudget, forbiddenWriteAttemptCount, scrubSensitiveEnvironment, shouldStopAfterTrial, TaskAssertionError } from "../evals/lib/policy.mjs";
import { RealEvaluationLedger, realConfirmationToken, validateRealConfig, validateSuiteBudget } from "../evals/lib/real-policy.mjs";
import { loadRealResume, realConfigHash, realExecutionHash, trialSlots } from "../evals/lib/real-resume.mjs";
import { fetchArtifactMetadata } from "../evals/lib/registry-artifact.mjs";
import { createEvaluationTools, evaluationToolFailureCode } from "../evals/lib/tools.mjs";

test("evaluation suites pin ten valid task revisions", async () => {
  const suites = await validateAll();
  assert.deepEqual(suites.map((suite) => [suite.id, suite.tasks]), [["baseline", 10], ["canary", 1], ["smoke", 10]]);
  const smoke = await loadSuite("smoke");
  assert.equal(smoke.suite.tasks.length, 10);
  assert.match(smoke.hash, /^[a-f0-9]{64}$/);
});

test("evaluation workspace paths cannot escape their isolated root", () => {
  const workspace = path.resolve("fixture-workspace");
  assert.equal(safeWorkspacePath(workspace, "src/index.js"), path.join(workspace, "src", "index.js"));
  assert.throws(() => safeWorkspacePath(workspace, "../outside.txt"), /Unsafe portable|escapes the fixture/);
  assert.throws(() => safeWorkspacePath(workspace, path.resolve("outside.txt")), /Absolute workspace path/);
  assert.throws(() => safeWorkspacePath(workspace, "result.txt:stream"), /Unsafe portable workspace path/);
  assert.throws(() => safeWorkspacePath(workspace, "CON"), /Unsafe portable workspace path/);
});

test("evaluation result redaction removes credential fields and bearer values", () => {
  const result = redact({ apiKey: "secret-value", message: "Authorization: Bearer abcdefghijklmnop", inputTokens: 12 });
  assert.equal(result.apiKey, "[REDACTED]");
  assert.equal(result.message, "Authorization: Bearer [REDACTED]");
  assert.equal(result.inputTokens, 12);
});

test("evaluation result validation rejects incomplete trials", () => {
  assert.throws(() => validateResult({ protocolVersion: 1, runId: "x", mode: "simulated", state: "running", suite: "smoke", suiteHash: "hash", startedAt: "now", finishedAt: "now", xiu: { version: "0.18.0" }, environment: { node: process.version }, trials: [{}], summary: {} }), /Invalid trial result/);
});

test("evaluation isolation rejects fixture links and junctions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-eval-link-test-"));
  const fixture = path.join(root, "task");
  const repository = path.join(fixture, "repo");
  const target = path.join(root, "target");
  await fs.mkdir(repository, { recursive: true });
  await fs.mkdir(target);
  try {
    await fs.symlink(target, path.join(repository, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    t.skip("link creation is unavailable on this platform");
    return;
  }
  await assert.rejects(createIsolation(fixture), /link is forbidden/);
  await fs.rm(root, { recursive: true, force: true });
});

test("evaluation cleanup is bounded to its own temporary directory", async () => {
  const temporaryRoot = path.join(resultsRoot, ".tmp");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryRoot, "workspace-cleanup-test-"));
  await fs.writeFile(path.join(root, "evidence.txt"), "temporary\n");
  await removeTemporaryDirectory(root, "workspace-");
  await assert.rejects(fs.access(root));
  await assert.rejects(removeTemporaryDirectory(path.dirname(resultsRoot), "workspace-"), /Refusing/);
});

test("evaluation policy separates budget, task assertion, safety, and harness failures", () => {
  const task = { budget: { inputTokens: 10, outputTokens: 5 } };
  assert.throws(() => enforceTrialBudget(task, { model: { inputTokens: 11, outputTokens: 1 } }), /input token budget/);
  assert.equal(classifyFailure(new TaskAssertionError("wrong file"), "single-file"), "task_assertion");
  assert.equal(classifyFailure(new TaskAssertionError("refusal failed"), "safety"), "safety");
  assert.equal(classifyFailure(new Error("assertion module has no default function"), "single-file"), "harness");
});

test("real evaluation continues only after an isolated task-budget terminal", () => {
  assert.equal(shouldStopAfterTrial({ passed: false, failureType: "budget", failure: "Task budget exhausted (tool calls)." }), false);
  assert.equal(shouldStopAfterTrial({ passed: false, failureType: "budget", failure: "Task input token budget exceeded." }), false);
  assert.equal(shouldStopAfterTrial({ passed: false, failureType: "budget", failure: "Global tool-call budget exhausted." }), true);
  for (const failureType of ["provider", "harness", "timeout", "interrupted"]) {
    assert.equal(shouldStopAfterTrial({ passed: false, failureType, failure: `${failureType} failure` }), true);
  }
  assert.equal(shouldStopAfterTrial({ passed: false, failureType: "task_assertion", failure: "wrong output" }), false);
  assert.equal(shouldStopAfterTrial({ passed: false, failureType: "safety", failure: "refusal failed" }), false);
  assert.equal(shouldStopAfterTrial({ passed: false, failureType: "unexpected", failure: "unknown" }), true);
});

test("evaluation policy counts blocked writes without retaining tool arguments", () => {
  const events = [
    { name: "eval_read_file", status: "failed", reasonCode: "outside_workspace" },
    { name: "eval_write_file", status: "failed", reasonCode: "outside_allowlist" },
    { name: "eval_replace_text", status: "failed", reasonCode: "outside_workspace" },
  ];
  assert.equal(forbiddenWriteAttemptCount(events), 2);
  const result = validateResult({
    protocolVersion: 1, runId: "safe-tool-events", mode: "real", state: "running", suite: "smoke", suiteHash: "hash",
    startedAt: "now", finishedAt: "now", xiu: { version: "0.17.0" }, environment: { node: process.version },
    trials: [{ taskId: "task", revision: 1, trial: 1, passed: false, verified: false, metrics: {}, toolEvents: events }], summary: {},
  });
  assert.deepEqual(result.trials[0].toolEvents, events);
  const tampered = structuredClone(result);
  tampered.trials[0].toolEvents[0].reasonCode = "secret/path";
  assert.throws(() => validateResult(tampered), /Invalid tool event summary/);
});

test("evaluation tools classify missing paths and block writes outside the task allowlist", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-eval-tools-test-"));
  try {
    await fs.writeFile(path.join(workspace, "names.js"), "export const name = 'before';\n", "utf8");
    const tools = createEvaluationTools(workspace, { allowedChanges: ["names.js"] });
    const read = tools.find((tool) => tool.name === "eval_read_file")!;
    const write = tools.find((tool) => tool.name === "eval_write_file")!;

    await assert.rejects(read.execute({ path: "missing.js" }, {} as never), (error: unknown) => {
      assert.equal(evaluationToolFailureCode(error), "not_found");
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      return true;
    });
    await assert.rejects(write.execute({ path: "verify.js", content: "no\n" }, {} as never), (error: unknown) => {
      assert.equal(evaluationToolFailureCode(error), "outside_allowlist");
      return true;
    });
    await assert.rejects(write.execute({ path: "../outside.js", content: "no\n" }, {} as never), (error: unknown) => {
      assert.equal(evaluationToolFailureCode(error), "outside_workspace");
      return true;
    });
    await assert.rejects(fs.access(path.join(workspace, "verify.js")));
    await write.execute({ path: "names.js", content: "export const name = 'after';\n" }, {} as never);
    assert.equal(await fs.readFile(path.join(workspace, "names.js"), "utf8"), "export const name = 'after';\n");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("simulated evaluation environment removes credential-like variables", () => {
  const environment: NodeJS.ProcessEnv = { PATH: "safe", OPENAI_API_KEY: "secret", CUSTOM_AUTH_TOKEN: "secret" };
  assert.equal(scrubSensitiveEnvironment(environment), 2);
  assert.deepEqual(environment, { PATH: "safe" });
});

test("approved real evaluation config produces an artifact-bound confirmation token", async () => {
  const config = validateRealConfig(JSON.parse(await fs.readFile(path.resolve("evals/configs/agnes-enterprise-v0.17.0.json"), "utf8")));
  const executionHash = "a".repeat(64);
  const first = realConfirmationToken(config, "suite-hash", "sha512-first", executionHash);
  const second = realConfirmationToken(config, "suite-hash", "sha512-second", executionHash);
  assert.match(first, /^CONFIRM-REAL-EVAL-[A-F0-9]{16}$/);
  assert.notEqual(first, second);
  assert.notEqual(first, realConfirmationToken(config, "suite-hash", "sha512-first", "b".repeat(64)));
});

test("approved real canary is limited to one pinned trial", async () => {
  const config = validateRealConfig(JSON.parse(await fs.readFile(path.resolve("evals/configs/agnes-enterprise-v0.17.0-canary.json"), "utf8")));
  const suite = await loadSuite(config.suite);
  const tasks = [];
  for (const reference of suite.suite.tasks) tasks.push((await loadTask(reference.id, reference.revision)).task);
  assert.equal(config.trials, 1);
  assert.deepEqual(suite.suite.tasks, [{ id: "single-trim-name", revision: 3 }]);
  assert.deepEqual(validateSuiteBudget(config, tasks), { modelCalls: 12, toolCalls: 20, inputTokens: 120000, outputTokens: 10000, durationMs: 180000 });
  const expanded = structuredClone(config);
  expanded.globalBudget.modelCalls += 1;
  assert.throws(() => validateRealConfig(expanded), /global budget differs/);
});

test("Enterprise free-model ledger enforces non-cost global budgets", async () => {
  const config = validateRealConfig(JSON.parse(await fs.readFile(path.resolve("evals/configs/agnes-enterprise-v0.17.0.json"), "utf8")));
  config.globalBudget.modelCalls = 1;
  const ledger = new RealEvaluationLedger(config, () => 1000);
  ledger.assertCanStartModelCall();
  ledger.recordModelTurn({ usage: { inputTokens: 20, outputTokens: 5 }, raw: {} });
  assert.equal(ledger.snapshot().estimatedCostUsd, 0);
  assert.throws(() => ledger.assertCanStartModelCall(), /model-call budget/);
});

test("real evaluation ledger restores cumulative usage without counting paused time", async () => {
  const config = validateRealConfig(JSON.parse(await fs.readFile(path.resolve("evals/configs/agnes-enterprise-v0.17.0.json"), "utf8")));
  let now = 10_000;
  const ledger = new RealEvaluationLedger(config, () => now, { modelCalls: 7, toolCalls: 9, inputTokens: 1200, outputTokens: 80, durationMs: 500, estimatedCostUsd: 0 });
  assert.deepEqual(ledger.snapshot(), { modelCalls: 7, toolCalls: 9, inputTokens: 1200, outputTokens: 80, durationMs: 500, estimatedCostUsd: 0, authorizationLimitUsd: 100 });
  now += 25;
  assert.equal(ledger.snapshot().durationMs, 525);
  const exhausted = structuredClone(config);
  exhausted.globalBudget.modelCalls = 6;
  assert.throws(() => new RealEvaluationLedger(exhausted, () => now, { modelCalls: 7 }), /model-call budget/);
});

test("real evaluation resume preserves an exact trial prefix and rejects tampering", async () => {
  const config = validateRealConfig(JSON.parse(await fs.readFile(path.resolve("evals/configs/agnes-enterprise-v0.17.0.json"), "utf8")));
  const loadedSuite = await loadSuite("baseline");
  const slots = trialSlots(loadedSuite.suite, config.trials);
  const loadedTasks = [];
  for (const reference of loadedSuite.suite.tasks) loadedTasks.push(await loadTask(reference.id, reference.revision));
  const executionHash = await realExecutionHash(loadedTasks);
  const metadata = { packageName: "@xiu-ai/cli", version: "0.17.0", integrity: "sha512-test" };
  const trial = { taskId: slots[0].taskId, revision: slots[0].revision, category: "single-file", trial: slots[0].trial, passed: false, verified: false, failureType: "provider", failure: "Provider request failed.", changedFiles: ["calculator.js"], unrelatedFiles: [], approvals: [], toolEvents: [{ name: "eval_replace_text", status: "succeeded" }], metrics: { inputTokens: 100, outputTokens: 10, modelCalls: 1, toolCalls: 1, retries: 0, approvals: 0, durationMs: 10, unrelatedFiles: 0, estimatedCostUsd: 0 }, startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:00:01.000Z" };
  const result = { protocolVersion: 1, runId: randomUUID(), mode: "real", suite: loadedSuite.suite.id, suiteHash: loadedSuite.hash, executionHash, configHash: realConfigHash(config), xiu: { package: metadata.packageName, version: metadata.version, integrity: metadata.integrity }, environment: { node: process.version, provider: config.provider.id, model: config.provider.model }, globalBudget: config.globalBudget, state: "stopped", startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:00:01.000Z", trials: [trial], summary: summarize([trial]), ledger: { modelCalls: 1, toolCalls: 1, inputTokens: 100, outputTokens: 10, durationMs: 11, estimatedCostUsd: 0 } };
  await fs.mkdir(resultsRoot, { recursive: true });
  const file = path.join(resultsRoot, `resume-test-${randomUUID()}.json`);
  try {
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    const context = { config, configHash: realConfigHash(config), suite: loadedSuite.suite, suiteHash: loadedSuite.hash, executionHash, metadata, loadedTasks };
    const resume = await loadRealResume(file, context);
    assert.equal(resume.result.trials.length, 1);
    assert.deepEqual(resume.nextSlot, slots[1]);
    assert.equal(resume.remainingBudget.modelCalls, config.globalBudget.modelCalls - 1);
    assert.equal(slots.length, 30);
    assert.equal(new Set(slots.map((slot) => `${slot.taskId}:${slot.trial}`)).size, 30);
    const resumeToken = realConfirmationToken(config, loadedSuite.hash, metadata.integrity, executionHash, resume.binding);
    assert.notEqual(realConfirmationToken(config, loadedSuite.hash, metadata.integrity, executionHash), resumeToken);

    result.trials[0].failure = "Provider request failed after a changed local note.";
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    const changedResume = await loadRealResume(file, context);
    assert.notEqual(realConfirmationToken(config, loadedSuite.hash, metadata.integrity, executionHash, changedResume.binding), resumeToken);

    result.trials[0].trial = 2;
    result.summary = summarize(result.trials);
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await assert.rejects(loadRealResume(file, context), /exact ordered trial prefix/);

    result.trials[0].trial = 1;
    result.summary = summarize(result.trials);
    result.ledger.modelCalls = 2;
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await assert.rejects(loadRealResume(file, context), /ledger modelCalls/);

    result.ledger.modelCalls = 1;
    result.trials[0].failureType = "budget";
    result.trials[0].failure = "Task budget exhausted (tool calls).";
    result.summary = summarize(result.trials);
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await assert.rejects(loadRealResume(file, context), /suite-terminal failure/);

    result.trials[0].failureType = "provider";
    result.trials[0].failure = "Provider request failed.";
    result.summary = summarize(result.trials);
    result.state = "running";
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await assert.rejects(loadRealResume(file, context), /Only stopped or interrupted/);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("real evaluation global limits cover the conservative maximum of all pinned trials", async () => {
  const config = validateRealConfig(JSON.parse(await fs.readFile(path.resolve("evals/configs/agnes-enterprise-v0.17.0.json"), "utf8")));
  const suite = await loadSuite("baseline");
  const tasks = [];
  for (const reference of suite.suite.tasks) tasks.push((await loadTask(reference.id, reference.revision)).task);
  const maximum = validateSuiteBudget(config, tasks);
  assert.ok(maximum.modelCalls <= config.globalBudget.modelCalls);
  const tooSmall = structuredClone(config);
  tooSmall.globalBudget.modelCalls = maximum.modelCalls - 1;
  assert.throws(() => validateSuiteBudget(tooSmall, tasks), /conservative maximum/);
});

test("Registry metadata validation pins package, version, integrity, and HTTPS origin", async () => {
  const goodFetch = async () => ({ ok: true, json: async () => ({ name: "@xiu-ai/cli", version: "0.17.0", dist: { integrity: "sha512-abc", tarball: "https://registry.npmjs.org/@xiu-ai/cli/-/cli-0.17.0.tgz" } }) });
  assert.equal((await fetchArtifactMetadata("@xiu-ai/cli", "0.17.0", goodFetch)).integrity, "sha512-abc");
  const badFetch = async () => ({ ok: true, json: async () => ({ name: "@xiu-ai/cli", version: "0.17.0", dist: { integrity: "sha512-abc", tarball: "https://example.com/cli.tgz" } }) });
  await assert.rejects(fetchArtifactMetadata("@xiu-ai/cli", "0.17.0", badFetch), /untrusted tarball origin/);
});
