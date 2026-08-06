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

test("revisiting a file after materially different calls is not treated as a loop", () => {
  const guard = new ToolLoopGuard();
  const observations = [
    guard.observe("read_file", { path: "rules.md" }),
    guard.observe("search_text", { query: "waimai_in_order" }),
    guard.observe("read_file", { path: "case-001.html", startLine: 200 }),
    guard.observe("run_command", { command: "extract evidence" }),
    guard.observe("read_file", { path: "rules.md" }),
    guard.observe("read_file", { path: "case-002.html", startLine: 200 }),
    guard.observe("read_file", { path: "rules.md" }),
  ];
  assert.equal(observations.some((item) => item.blocked), false);
});

test("reset forgets stale loop evidence after compaction or real progress", () => {
  const guard = new ToolLoopGuard();
  guard.observe("read_file", { path: "a" });
  guard.observe("read_file", { path: "a" });
  assert.equal(guard.observe("read_file", { path: "a" }).blocked, true);
  guard.reset();
  assert.equal(guard.observe("read_file", { path: "a" }).blocked, false);
  assert.equal(guard.observe("read_file", { path: "a" }).blocked, false);
});
