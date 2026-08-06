import assert from "node:assert/strict";
import test from "node:test";
import { toolCallSignature, ToolLoopGuard } from "../src/loop-guard.js";

test("tool signatures are stable across object key order", () => {
  assert.equal(toolCallSignature("read_file", { line: 1, path: "a" }), toolCallSignature("read_file", { path: "a", line: 1 }));
});

test("loop guard blocks a third identical successful operation", () => {
  const guard = new ToolLoopGuard();
  assert.equal(guard.observe("read_file", { path: "a" }).blocked, false);
  assert.equal(guard.observe("read_file", { path: "a" }).blocked, false);
  assert.match(guard.observe("read_file", { path: "a" }).reason ?? "", /same tool-call/i);
});

test("loop guard detects a repeated multi-tool cycle and eventually aborts", () => {
  const guard = new ToolLoopGuard();
  const calls = ["a", "b", "a", "b", "a", "b", "a", "b"];
  const observations = calls.map((path) => guard.observe("read_file", { path }));
  assert.ok(observations.some((item) => item.blocked));
  assert.equal(observations.at(-1)?.abort, true);
});
