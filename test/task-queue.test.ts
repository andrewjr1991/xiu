import assert from "node:assert/strict";
import test from "node:test";
import { formatRunningInputFooter, RunningTaskView, TaskInputQueue } from "../src/task-queue.js";

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

test("task input queue rejects empty and bounded overflow", () => {
  const queue = new TaskInputQueue(1);
  assert.throws(() => queue.enqueue("  "), /cannot be empty/i);
  queue.enqueue("one");
  assert.throws(() => queue.enqueue("two"), /full \(1\)/i);
  assert.equal(queue.clear(), 1);
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
  const footer = formatRunningInputFooter("Thinking - turn 2", 3, "Auto | model");
  assert.match(footer, /Thinking - turn 2/);
  assert.match(footer, /3 queued/);
  assert.match(footer, /Ctrl\+C cancels current/);
  assert.match(footer, /Auto \| model/);
});
