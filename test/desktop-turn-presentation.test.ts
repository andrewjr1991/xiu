import test from "node:test";
import assert from "node:assert/strict";
import { conversationRounds, roundPresentation, turnElapsed } from "../apps/desktop/renderer/src/turn-presentation.js";
import type { RuntimeEvent } from "../src/runtime/protocol.js";
const event = (id: string, type: string, payload: unknown, taskId = "one") => ({ schemaVersion: 1, eventId: id, taskId, sequence: 1, timestamp: "2026-10-03T00:00:00Z", type, payload }) as RuntimeEvent;
test("one round folds commentary and dispatch but keeps user and final answer", () => {
  const events = [event("s", "task.started", { taskPreview: "check" }), event("m", "assistant.message", { text: "checking", hasToolCalls: true }), event("t", "tool.started", { name: "read_file" }), event("a", "subagent.updated", { agent: { id: "child", status: "running" } }), event("a2", "subagent.updated", { agent: { id: "child", status: "completed" } }), event("reply", "assistant.message", { text: "done", hasToolCalls: false }), event("end", "task.finished", { state: "completed", result: "done" })];
  const round = roundPresentation(events);
  assert.equal(round.users.length, 1); assert.equal(round.answer?.eventId, "end");
  assert.deepEqual(round.process.map((e) => e.eventId), ["m", "t", "a", "a2"]);
  assert.equal(round.operations, 1); assert.equal(round.agents, 1);
});
test("failure and denied operations remain outside folded process", () => {
  const events = [event("t", "tool.finished", { name: "run_command", summary: "denied", result: { status: "denied" } }), event("n", "runtime.notice", { kind: "failure", message: "persist failed" }), event("e", "task.finished", { state: "failed", error: "failed" })];
  const round = roundPresentation(events);
  assert.equal(round.alerts.length, 3); assert.equal(round.process.length, 0);
});
test("history rounds never merge answers; truncated live round has stable task identity", () => {
  const events = [event("s1", "task.started", { taskPreview: "old" }), event("e1", "task.finished", { state: "completed", result: "old result" }), event("s2", "task.started", { taskPreview: "new" }, "two"), event("m2", "model.started", { turn: 1 }, "two")];
  const rounds = conversationRounds(events);
  assert.equal(rounds.length, 2); assert.equal(roundPresentation(rounds[1]!.events).answer, undefined);
  assert.equal(conversationRounds(events.slice(-1))[0]?.id, "two");
});
test("a reply requesting input is visible before task termination", () => {
  const round = roundPresentation([event("q", "assistant.message", { text: "请选择目标目录", hasToolCalls: false })]);
  assert.equal(round.answer?.eventId, "q"); assert.equal(round.process.length, 0);
});
test("latest child failure remains visible without repeated progress alerts", () => {
  const round = roundPresentation([event("a", "subagent.updated", { agent: { id: "child", status: "failed", error: "timeout" } }), event("b", "subagent.updated", { agent: { id: "child", status: "failed", error: "timeout" } })]);
  assert.deepEqual(round.alerts.map((e) => e.eventId), ["b"]);
});
test("duration handles missing timestamps without inventing elapsed time", () => {
  assert.equal(turnElapsed(undefined, "bad"), "用时未记录");
  assert.equal(turnElapsed("2026-10-03T00:00:00Z", "2026-10-03T00:01:23Z"), "用时 1 分 23 秒");
});
