import test from "node:test";
import assert from "node:assert/strict";
import { taskOverview } from "../apps/desktop/renderer/src/task-overview.js";
import type { DesktopReviewSnapshot, DesktopTaskHistorySnapshot, RuntimeEvent } from "../apps/desktop/shared/protocol.js";
const started = (taskId: string): RuntimeEvent => ({ schemaVersion: 1, eventId: taskId, sequence: 1, taskId, timestamp: "2026-10-03T01:00:00Z", type: "task.started", payload: { taskPreview: taskId } });
const tool = (name: string, description: string): RuntimeEvent => ({ ...started("new"), type: "tool.started", payload: { name, description, changesWorkspace: false, verification: false, risk: "read" } });
const changes = { view: "task" as const, git: true, complete: true, changes: [], warnings: [], preExisting: [] };
const review = { overview: { workspace: "project", taskId: "new", branch: "main", taskChanges: changes }, background: [{ id: "worker", command: "worker", running: true }] } as DesktopReviewSnapshot;
test("overview only includes selected round calls and never old replies", () => {
  const result = taskOverview([started("old"), { ...started("old"), type: "assistant.message", payload: { text: "old reply", hasToolCalls: false } }, started("new"), tool("read_skill", "load skill review"), tool("mcp__docs__read", "read docs"), tool("web_search", "search news")]);
  assert.equal(result.goal, "new"); assert.equal(result.summary, undefined);
  assert.equal(result.skills.length, 2); assert.equal(result.sources.length, 2);
});
test("historical overview cannot consume current branch, workers or output", () => {
  const result = taskOverview([started("new")], { title: "saved", events: [], changes } as unknown as DesktopTaskHistorySnapshot, review, "project");
  assert.equal(result.branch, undefined); assert.deepEqual(result.background, []); assert.equal(result.changes, changes);
});
test("task changes require matching task and workspace; environment is explicitly workspace scoped", () => {
  assert.equal(taskOverview([started("new")], undefined, review, "project").changes, changes);
  assert.equal(taskOverview([started("other")], undefined, review, "project").changes, undefined);
  const wrong = taskOverview([started("new")], undefined, review, "elsewhere");
  assert.equal(wrong.changes, undefined); assert.equal(wrong.branch, undefined); assert.deepEqual(wrong.background, []);
});
