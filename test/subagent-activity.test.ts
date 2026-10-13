import assert from "node:assert/strict";
import test from "node:test";
import { finishSubagentActivity, updateSubagentActivity } from "../src/subagent-activity.js";

const start = "2026-10-08T01:00:00.000Z", end = "2026-10-08T01:00:02.000Z";
test("tool start and terminal facts preserve identity, ordering and elapsed time", () => {
  const a = updateSubagentActivity([], "read_file", "started", start);
  const b = updateSubagentActivity(a, "read_file", "completed", end);
  assert.equal(b[0].id, a[0].id);
  assert.equal(b[0].status, "completed");
  assert.equal(b[0].durationMs, 2000);
  assert.equal(a[0].status, "running", "historical objects remain immutable");
  assert.equal(updateSubagentActivity(b, "read_file", "failed", end), b, "unmatched end never fabricates an execution");
});
test("repeated tool names match their most recent unfinished call", () => {
  let entries = updateSubagentActivity([], "read_file", "started", start);
  entries = updateSubagentActivity(entries, "read_file", "started", start);
  entries = updateSubagentActivity(entries, "read_file", "failed", end);
  assert.deepEqual(entries.map(e => e.status), ["running", "failed"]);
  assert.deepEqual(finishSubagentActivity(entries, end).map(e => e.status), ["interrupted", "failed"]);
});
test("activity metadata is bounded and rejects descriptions or raw arguments as tool names", () => {
  let entries = updateSubagentActivity([], "read_file /private?api_key=secret", "started", start);
  assert.equal(entries[0].name, "tool");
  for (let i = 0; i < 110; i++) entries = updateSubagentActivity(entries, "read_file", "started", start);
  assert.equal(entries.length, 100);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["id", "name", "startedAt", "status"]);
  assert.equal(JSON.stringify(entries).includes("private"), false);
});
test("cancellation is interrupted rather than success and does not alter completed records", () => {
  const a = updateSubagentActivity([], "read_file", "started", start);
  const b = updateSubagentActivity(a, "read_file", "interrupted", end);
  assert.equal(b[0].status, "interrupted");
  assert.deepEqual(finishSubagentActivity(b, end), b);
});
