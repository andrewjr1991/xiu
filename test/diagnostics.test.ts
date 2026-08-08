import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskDiagnostics, restoreTaskDiagnostics, TaskDiagnostics } from "../src/diagnostics.js";

test("task diagnostics aggregate model tools approval tokens and bounded failures", () => {
  let now = 1_000;
  const diagnostics = new TaskDiagnostics("ship diagnostics", () => now);
  diagnostics.beginModel("turn 1", 1);
  now += 240;
  diagnostics.finishModel({ inputTokens: 120, outputTokens: 30 }, true);
  diagnostics.beginTool("run_command", { command: "npm test", api_key: "secret-value" });
  now += 80;
  diagnostics.beginApproval("execute npm test");
  now += 50;
  diagnostics.finishApproval(false);
  now += 20;
  diagnostics.finishTool(false, "Exit code: 1\nAPI key secret-value\nlarge output".repeat(100));

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.model.attempts, 1);
  assert.equal(snapshot.model.inputTokens, 120);
  assert.equal(snapshot.model.outputTokens, 30);
  assert.equal(snapshot.model.totalMs, 240);
  assert.equal(snapshot.tools.calls, 1);
  assert.equal(snapshot.tools.failures, 1);
  assert.equal(snapshot.approvals.requests, 1);
  assert.equal(snapshot.approvals.denied, 1);
  assert.equal(snapshot.approvals.waitMs, 50);
  assert.equal(snapshot.failures.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-value/);
  assert.ok(JSON.stringify(snapshot).length < 12_000);
});

test("diagnostics distinguish waiting and slow work from deterministic stalls", () => {
  let now = 0;
  const diagnostics = new TaskDiagnostics("long task", () => now);
  diagnostics.beginApproval("dangerous command");
  now = 300_000;
  assert.equal(diagnostics.snapshot().health.state, "waiting");
  diagnostics.finishApproval(true);

  diagnostics.beginModel("turn 1", 1);
  now = 370_000;
  const slow = diagnostics.snapshot();
  assert.equal(slow.health.state, "attention");
  assert.equal(slow.health.reason, "slow_model");
  diagnostics.finishModel({ inputTokens: 1, outputTokens: 1 }, true);

  for (let item = 0; item < 3; item += 1) {
    diagnostics.beginTool("run_process", { program: "node", args: ["check.js"] });
    now += 10;
    diagnostics.finishTool(false, "Exit code: 1");
  }
  const stalled = diagnostics.snapshot();
  assert.equal(stalled.health.state, "stalled");
  assert.equal(stalled.health.reason, "repeated_failures");
});

test("new tool evidence refreshes progress while repeated evidence does not", () => {
  let now = 10_000;
  const diagnostics = new TaskDiagnostics("inspect", () => now);
  diagnostics.beginTool("read_file", { path: "src/a.ts" });
  now += 10;
  diagnostics.finishTool(true, "contents");
  const firstProgress = diagnostics.snapshot().progress.lastAt;
  diagnostics.beginTool("read_file", { path: "src/a.ts" });
  now += 10;
  diagnostics.finishTool(true, "contents");
  assert.equal(diagnostics.snapshot().progress.lastAt, firstProgress);
  diagnostics.beginTool("read_file", { path: "src/b.ts" });
  now += 10;
  diagnostics.finishTool(true, "contents");
  assert.notEqual(diagnostics.snapshot().progress.lastAt, firstProgress);
});

test("restored diagnostics validate fields and become idle after process recovery", () => {
  const diagnostics = new TaskDiagnostics("resume me", () => 5_000);
  diagnostics.beginTool("read_file", { path: "README.md" });
  const restored = restoreTaskDiagnostics(diagnostics.snapshot());
  assert.ok(restored);
  assert.equal(restored.snapshot().phase.kind, "idle");
  assert.equal(restored.snapshot().outcome, "interrupted");
  assert.equal(restoreTaskDiagnostics({ version: 1, task: "bad", failures: new Array(99).fill({}) }), undefined);
});

test("diagnostic reports are localized and keep concrete evidence", () => {
  let now = 1_000;
  const diagnostics = new TaskDiagnostics("build feature", () => now);
  diagnostics.beginTool("run_process", { program: "npm", args: ["test"] });
  now += 25;
  diagnostics.finishTool(false, "Exit code: 2");
  const snapshot = diagnostics.snapshot();
  const chinese = formatTaskDiagnostics(snapshot, "zh-CN");
  assert.match(chinese, /任务诊断|失败 1|run_process|最近出现失败/);
  assert.doesNotMatch(chinese, /State:|Current phase:|recent_failures/);
  assert.match(formatTaskDiagnostics(snapshot, "en-US"), /Task diagnostics|Failures: 1|run_process/);
});

test("denied and cancelled tools are measured without becoming failures or progress", () => {
  let now = 1_000;
  const diagnostics = new TaskDiagnostics("safe task", () => now);
  diagnostics.beginTool("run_command", { command: "publish" });
  now += 20;
  diagnostics.finishTool("denied", "Tool execution denied by user.");
  let snapshot = diagnostics.snapshot();
  assert.equal(snapshot.tools.calls, 1);
  assert.equal(snapshot.tools.failures, 0);
  assert.equal(snapshot.progress.distinctOperations, 0);

  diagnostics.beginTool("run_command", { command: "long process" });
  now += 30;
  diagnostics.cancelActive();
  snapshot = diagnostics.snapshot();
  assert.equal(snapshot.tools.calls, 2);
  assert.equal(snapshot.tools.failures, 0);
  assert.equal(snapshot.tools.totalMs, 50);
});

test("task and approval diagnostics redact credential values", () => {
  let now = 5_000;
  const diagnostics = new TaskDiagnostics("debug token=top-secret-value", () => now);
  diagnostics.beginTool("run_command", { command: "deploy", apiKey: "top-secret-value" });
  diagnostics.beginApproval("run deploy with top-secret-value");
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.phase.kind, "approval");
  assert.doesNotMatch(JSON.stringify(snapshot), /top-secret-value/);
  assert.match(JSON.stringify(snapshot), /REDACTED/);
});
