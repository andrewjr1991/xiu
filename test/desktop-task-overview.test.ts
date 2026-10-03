import test from "node:test";
import assert from "node:assert/strict";
import { stageSummary, taskOverview } from "../apps/desktop/renderer/src/task-overview.js";
import type { DesktopReviewSnapshot, DesktopTaskHistorySnapshot, RuntimeEvent } from "../apps/desktop/shared/protocol.js";
const started = (taskId: string): RuntimeEvent => ({ schemaVersion: 1, eventId: taskId, sequence: 1, taskId, timestamp: "2026-10-03T01:00:00Z", type: "task.started", payload: { taskPreview: taskId } });
const tool = (name: string, description: string): RuntimeEvent => ({ ...started("new"), type: "tool.started", payload: { name, description, changesWorkspace: false, verification: false, risk: "read" } });
const changes = { view: "task" as const, git: true, complete: true, changes: [], warnings: [], preExisting: [] };
const review = { overview: { workspace: "project", taskId: "new", branch: "main", taskChanges: changes }, background: [{ id: "worker", command: "worker", running: true }] } as DesktopReviewSnapshot;
test("overview only includes selected round calls and never old replies", () => {
  const result = taskOverview([started("old"), { ...started("old"), type: "assistant.message", payload: { text: "old reply", hasToolCalls: false } }, started("new"), tool("read_skill", "load skill review"), tool("mcp__docs__read", "read docs"), tool("web_search", "search news")]);
  assert.equal(result.goal, undefined); assert.equal(result.summary, undefined);
  assert.equal(result.skills.length, 2); assert.equal(result.sources.length, 2);
});

test("long original input is not displayed as an initial task summary", () => {
  const event = { ...started("new"), payload: { taskPreview: "用户详细需求".repeat(300) } };
  assert.equal(stageSummary([event]).summary, undefined);
  assert.equal(stageSummary([event]).goal, undefined);
});

test("stage summary appears with plan and changes only on meaningful stage updates", () => {
  const plan: RuntimeEvent = { ...started("new"), type: "plan.updated", payload: { plan: { goal: "交付离线小游戏", updatedAt: started("new").timestamp, steps: [
    { id: "a", title: "实现页面", status: "completed" }, { id: "b", title: "验证交互", status: "in_progress" },
  ] } } };
  const before = stageSummary([started("new"), plan]);
  assert.equal(before.goal, "交付离线小游戏");
  assert.match(before.summary ?? "", /1\/2.*验证交互/);
  const after = stageSummary([started("new"), plan, tool("read_file", "reading")]);
  assert.deepEqual(after, before);
});

test("result summary is bounded and failure cannot inherit a claimed success", () => {
  const failure: RuntimeEvent = { ...started("new"), type: "task.finished", payload: { state: "failed", error: "必需校验未通过", result: "全部成功" } };
  assert.match(stageSummary([started("new"), failure]).summary ?? "", /未完成.*校验未通过/);
  assert.doesNotMatch(stageSummary([started("new"), failure]).summary ?? "", /全部成功/);
  const done: RuntimeEvent = { ...started("new"), type: "task.finished", payload: { state: "completed", result: "已交付。".repeat(500) } };
  assert.ok((stageSummary([done]).summary?.length ?? 0) < 320);
  assert.equal(stageSummary([done]).phase, "结果摘要");
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
