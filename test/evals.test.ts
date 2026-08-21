import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSuite, redact, safeWorkspacePath, validateAll, validateResult } from "../evals/lib/core.mjs";
import { createIsolation } from "../evals/lib/isolation.mjs";
import { classifyFailure, enforceTrialBudget, scrubSensitiveEnvironment, TaskAssertionError } from "../evals/lib/policy.mjs";

test("evaluation suites pin ten valid task revisions", async () => {
  const suites = await validateAll();
  assert.deepEqual(suites.map((suite) => [suite.id, suite.tasks]), [["baseline", 10], ["smoke", 10]]);
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
  assert.throws(() => validateResult({ protocolVersion: 1, runId: "x", mode: "simulated", suite: "smoke", suiteHash: "hash", startedAt: "now", finishedAt: "now", xiu: { version: "0.18.0" }, environment: { node: process.version }, trials: [{}], summary: {} }), /Invalid trial result/);
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

test("evaluation policy separates budget, task assertion, safety, and harness failures", () => {
  const task = { budget: { inputTokens: 10, outputTokens: 5 } };
  assert.throws(() => enforceTrialBudget(task, { model: { inputTokens: 11, outputTokens: 1 } }), /input token budget/);
  assert.equal(classifyFailure(new TaskAssertionError("wrong file"), "single-file"), "task_assertion");
  assert.equal(classifyFailure(new TaskAssertionError("refusal failed"), "safety"), "safety");
  assert.equal(classifyFailure(new Error("assertion module has no default function"), "single-file"), "harness");
});

test("simulated evaluation environment removes credential-like variables", () => {
  const environment: NodeJS.ProcessEnv = { PATH: "safe", OPENAI_API_KEY: "secret", CUSTOM_AUTH_TOKEN: "secret" };
  assert.equal(scrubSensitiveEnvironment(environment), 2);
  assert.deepEqual(environment, { PATH: "safe" });
});
