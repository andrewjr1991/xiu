import assert from "node:assert/strict";
import test from "node:test";
import { selectedTaskView, subagentElapsed, subagentLifecycleEvents } from "../apps/desktop/renderer/src/subagent-presentation.js";
import { groupedTimelineItems } from "../apps/desktop/renderer/src/task-presentation.js";
import { subagentCards } from "../apps/desktop/renderer/src/TaskDataPanel.js";
import type { RuntimeEvent, RuntimeSubagentCard } from "../src/runtime/protocol.js";

const agent: RuntimeSubagentCard = { id: "run:reviewer", runId: "run", taskId: "reviewer", title: "审查补丁", role: "reviewer", status: "pending" };
const event = (sequence: number, status: string, progress?: string): RuntimeEvent => ({ schemaVersion: 1, eventId: `event-${sequence}`, taskId: "parent", sequence, timestamp: "2026-10-03T01:00:00Z", type: "subagent.updated", payload: { agent: { ...agent, status, progress } } });

test("timeline and inspector use one selected task across running, failed and historical states", () => {
  const history = { events: [] as RuntimeEvent[] };
  const live = [event(1, "running")];
  const active = selectedTaskView(history, true, false, live, [agent]);
  assert.equal(active.history, undefined);
  assert.equal(active.events, live);
  assert.deepEqual(subagentCards(active.events, active.agents), [agent]);
  const failed = selectedTaskView(history, false, false, live, [agent]);
  assert.equal(failed.history, history);
  assert.deepEqual(failed.events, []);
  assert.equal(failed.agents, undefined, "never leak another live task into empty history");
  assert.equal(selectedTaskView(history, false, true, live, [agent]).history, undefined);
});

test("authoritative snapshot preserves children when bounded event history truncates their updates", () => {
  const completed = { ...agent, status: "completed", result: "review passed" };
  const other = { ...agent, id: "run:tester", taskId: "tester", role: "tester" };
  assert.deepEqual(subagentCards([event(1, "running")], [completed, other]), [completed, other]);
  assert.deepEqual(subagentCards([], [completed, other]), [completed, other]);
  assert.equal(subagentCards([event(1, "running")])[0].status, "running");
});

test("a new round never inherits previous round subagent cards", () => {
  const start: RuntimeEvent = { schemaVersion: 1, eventId: "new-round", taskId: "parent", sequence: 2, timestamp: "2026-10-03T02:00:00Z", type: "task.started", payload: { taskPreview: "next" } };
  assert.deepEqual(subagentCards([event(1, "completed"), start]), []);
  assert.equal(subagentCards([event(1, "completed"), start, event(3, "running")])[0].status, "running");
});

test("dispatch, running and terminal states retain chronology while progress ticks do not duplicate starts", () => {
  const events = [event(1, "pending"), event(2, "running"), event(3, "running", "read file"), event(4, "running", "next turn"), event(5, "completed")];
  assert.deepEqual([...subagentLifecycleEvents(events)], ["event-1", "event-2", "event-5"]);
  assert.deepEqual(groupedTimelineItems(events, "completed").map((item) => item.kind === "event" ? item.event.eventId : item.id), ["event-1", "event-2", "event-5"]);
  assert.equal(events.length, 5);
});

test("cancelled, blocked and interrupted are distinct facts, not successful completion", () => {
  const events = [event(1, "pending"), event(2, "blocked"), event(3, "interrupted"), event(4, "cancelled")];
  assert.equal(subagentLifecycleEvents(events).size, 4);
});

test("history never animates an unfinished child's elapsed time or produces NaN", () => {
  const child = { ...agent, status: "running", startedAt: "2026-10-03T01:00:00Z" };
  assert.equal(subagentElapsed(child, Date.parse("2026-10-03T01:00:10Z"), true), 10_000);
  assert.equal(subagentElapsed(child, Date.now(), false), undefined);
  assert.equal(subagentElapsed({ ...child, startedAt: "invalid" }, Date.now(), true), undefined);
  assert.equal(subagentElapsed({ ...child, status: "completed", completedAt: "2026-10-03T01:00:02Z" }, Date.now(), false), 2_000);
});
