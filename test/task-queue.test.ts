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
  assert.match(footer, /\[>\] Inspect relevant files/);
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
  view.recordWorkspaceChange({ tool: "apply_patch", paths: ["src/task-queue.ts"], description: "patch progress UI" });
  const summary = view.progressLines().join("\n");
  assert.match(summary, /Plan: 1\/3 completed/);
  assert.match(summary, /\[x\] Inspect current UI/);
  assert.match(summary, /\[>\] Implement progress panel/);
  assert.match(summary, /Now: Implement progress panel/);
  assert.match(summary, /Next: Run regression tests/);
  assert.match(summary, /Changed: Modified: src\/task-queue\.ts/);
});
