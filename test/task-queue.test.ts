import assert from "node:assert/strict";
import test from "node:test";
import { failureRecoveryOptions, formatRunningInputFooter, RunningTaskView, TaskInputQueue } from "../src/task-queue.js";

test("task input queue preserves order and returns defensive snapshots", () => {
  const queue = new TaskInputQueue(3);
  queue.enqueue(" first follow-up ");
  queue.enqueue("second follow-up");
  const snapshot = queue.list();
  snapshot[0]!.text = "changed";
  assert.equal(queue.dequeue()?.text, "first follow-up");
  assert.equal(queue.dequeue()?.text, "second follow-up");
  assert.equal(queue.size, 0);
});

test("task input queue can prepend a retry ahead of existing work", () => {
  const queue = new TaskInputQueue(3);
  queue.enqueue("later");
  queue.prepend("retry now");
  assert.deepEqual(queue.list().map((item) => item.text), ["retry now", "later"]);
});

test("task input queue rejects empty and bounded overflow", () => {
  const queue = new TaskInputQueue(1);
  assert.throws(() => queue.enqueue("  "), /cannot be empty/i);
  queue.enqueue("one");
  assert.throws(() => queue.enqueue("two"), /full \(1\)/i);
  assert.equal(queue.clear(), 1);
});

test("failure recovery defaults to stopping and only offers continue for an explicit queue", () => {
  assert.equal(failureRecoveryOptions(0)[0]?.value, "stop");
  assert.deepEqual(failureRecoveryOptions(0).map((option) => option.value), ["stop", "retry"]);
  assert.deepEqual(failureRecoveryOptions(2).map((option) => option.value), ["stop", "retry", "continue"]);
});

test("running task view buffers output and drains it exactly once", () => {
  const view = new RunningTaskView();
  view.setPhase("  Running   tests ");
  view.write("partial");
  view.line(" line");
  assert.equal(view.phase(), "Running tests");
  assert.equal(view.drain(), "partial line\n");
  assert.equal(view.drain(), "");
});

test("running task view bounds long output and explains truncation", () => {
  const view = new RunningTaskView(5);
  view.write("123456789");
  const output = view.drain();
  assert.match(output, /Earlier live output was truncated/);
  assert.ok(output.endsWith("56789"));
});

test("running input footer exposes phase, queue, and cancellation semantics", () => {
  const view = new RunningTaskView();
  view.setTurn(2, 30);
  view.setPhase("Thinking");
  view.beginTool("read_file", "read rules.md");
  const footer = formatRunningInputFooter(view, 3, 1, "Auto | model");
  assert.match(footer, /Turn 2\/30/);
  assert.match(footer, /3 queued/);
  assert.match(footer, /1 steering/);
  assert.match(footer, /Ctrl\+O show details/);
  assert.match(footer, /→ Inspect relevant files/);
  assert.match(footer, /Next: Implement changes/);
  assert.match(footer, /Auto \| model/);
});

test("running input footer shows only the current turn when no limit is configured", () => {
  const view = new RunningTaskView();
  view.setTurn(31);
  const footer = formatRunningInputFooter(view, 0, 0, "Auto | model");
  assert.match(footer, /Turn 31 \|/);
  assert.doesNotMatch(footer, /31\//);
});

test("running input footer shows bounded task diagnostics", () => {
  const view = new RunningTaskView(256_000, "zh-CN");
  view.setDiagnostics({
    version: 1, task: "长任务", startedAt: new Date(0).toISOString(), updatedAt: new Date(1_000).toISOString(), outcome: "running", durationMs: 1_000,
    phase: { kind: "tool", operation: "run_process npm test", activeMs: 200 }, health: { state: "attention", reason: "recent_failures" },
    model: { attempts: 2, completed: 2, failures: 0, retries: 0, inputTokens: 1_000, outputTokens: 200, totalMs: 500, slowestMs: 300 },
    tools: { calls: 3, failures: 1, totalMs: 400, slowestMs: 250, byName: [{ name: "run_process", calls: 1, failures: 1, totalMs: 250 }] },
    approvals: { requests: 0, denied: 0, waitMs: 0 }, compactions: 0,
    progress: { lastAt: new Date(0).toISOString(), operationsSince: 2, distinctOperations: 1, consecutiveFailures: 1 }, failures: [],
  });
  const footer = formatRunningInputFooter(view, 0, 0, "自动 | model");
  assert.match(footer, /诊断：1,200 tokens/);
  assert.match(footer, /失败 1/);
  assert.match(footer, /需要关注/);
});

test("running task details toggle expands recent activity", () => {
  const view = new RunningTaskView();
  view.activity("one");
  view.activity("two");
  assert.match(view.progressLines().join("\n"), /Progress: automatic/);
  assert.equal(view.toggleDetails(), true);
  assert.deepEqual(view.progressLines().map((line) => line.split(" ").at(-1)), ["one", "two"]);
});

test("running task summary shows explicit plan, current and next steps, and file changes", () => {
  const view = new RunningTaskView();
  view.setPlan({
    goal: "Ship visible progress",
    updatedAt: new Date().toISOString(),
    steps: [
      { id: "inspect", title: "Inspect current UI", status: "completed" },
      { id: "implement", title: "Implement progress panel", status: "in_progress" },
      { id: "test", title: "Run regression tests", status: "pending" },
    ],
  });
  view.recordWorkspaceChange({
    tool: "apply_patch",
    paths: ["src/task-queue.ts"],
    description: "patch progress UI",
    files: [{ path: "src/task-queue.ts", kind: "modified", additions: 3, deletions: 1, bytesBefore: 100, bytesAfter: 120, preview: ["- old", "+ new"] }],
  });
  const summary = view.progressLines().join("\n");
  assert.match(summary, /Plan: 1\/3 completed/);
  assert.match(summary, /√ Inspect current UI/);
  assert.match(summary, /→ Implement progress panel/);
  assert.match(summary, /Now: Implement progress panel/);
  assert.match(summary, /Next: Run regression tests/);
  assert.match(summary, /Changed: Modified: src\/task-queue\.ts/);
  const pending = view.drainWorkspaceChanges();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.files[0]?.additions, 3);
  assert.deepEqual(view.drainWorkspaceChanges(), []);
});

test("running task summary keeps concise narration while hidden logs can be discarded", () => {
  const view = new RunningTaskView();
  view.write("hidden tool log\n");
  view.narrate("**已定位问题。** 接下来修改渲染逻辑。\n");
  view.setCompletion("Done - verified", true);
  assert.match(view.progressLines().join("\n"), /Update: 已定位问题。 接下来修改渲染逻辑。/);
  view.discard();
  assert.equal(view.drain(), "");
  assert.deepEqual(view.completionSummary(), { message: "Done - verified", success: true });
});

test("Chinese task view localizes progress, actions, and footer controls", () => {
  const view = new RunningTaskView(256_000, "zh-CN");
  view.setTurn(3);
  view.setPhase("思考中");
  view.recordImportantAction("验证通过：npm test");
  const footer = formatRunningInputFooter(view, 0, 0, "自动 | model");
  assert.match(footer, /运行中：轮次 3/);
  assert.match(footer, /进度：自动/);
  assert.match(footer, /当前：思考中/);
  assert.match(footer, /Ctrl\+O 显示详情/);
  assert.deepEqual(view.receiptLines(), ["  √ 验证通过：npm test"]);
});

test("successful verification advances the automatic view to final summary", () => {
  const view = new RunningTaskView(256_000, "zh-CN");
  view.beginTool("verify_output", "验证生成结果", false, true);
  view.markVerificationPassed();
  const output = view.progressLines().join("\n");
  assert.match(output, /√ 验证结果/);
  assert.match(output, /→ 复核并完成/);
  assert.match(output, /验证已通过，等待最终总结/);
});

test("running task view changes language without recreating the active task", () => {
  const view = new RunningTaskView(256_000, "en-US");
  view.setTurn(2);
  assert.match(formatRunningInputFooter(view, 0, 0, "Auto | model"), /Working: Turn 2/);

  view.setLanguage("zh-CN");
  const switched = formatRunningInputFooter(view, 0, 0, "自动 | model");
  assert.equal(view.language(), "zh-CN");
  assert.match(switched, /运行中：轮次 2/);
  assert.match(switched, /当前：处理中/);
  assert.doesNotMatch(switched, /Working|Understand the task/);
});

test("Chinese task view suppresses untranslated model narration and old English plan titles", () => {
  const view = new RunningTaskView(256_000, "zh-CN");
  view.narrate("I am inspecting the current implementation and preparing the next change.");
  view.setPlan({
    goal: "Build the feature",
    updatedAt: new Date().toISOString(),
    steps: [
      { id: "inspect", title: "Inspect current implementation", status: "in_progress" },
      { id: "test", title: "运行 npm test", status: "pending" },
    ],
  });
  const output = view.progressLines().join("\n");
  assert.doesNotMatch(output, /inspecting|Inspect current/);
  assert.match(output, /步骤 inspect/);
  assert.match(output, /运行 npm test/);
});
