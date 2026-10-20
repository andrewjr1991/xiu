import test from "node:test";
import assert from "node:assert/strict";
import { conversationRounds, generatedMedia, roundPresentation, turnElapsed } from "../apps/desktop/renderer/src/turn-presentation.js";
import type { RuntimeEvent } from "../src/runtime/protocol.js";
const event = (id: string, type: string, payload: unknown, taskId = "one") => ({ schemaVersion: 1, eventId: id, taskId, sequence: 1, timestamp: "2026-10-03T00:00:00Z", type, payload }) as RuntimeEvent;
test("tool failure notice and multiline result produce one alert with full evidence", () => {
  const full = "Exit code: 1\nTAP version 13\n# failing-test";
  const round = roundPresentation([event("notice", "runtime.notice", { kind: "failure", message: "run_process: Exit code: 1" }), event("result", "tool.finished", { name: "run_process", summary: full, result: { status: "failure" } })]);
  assert.deepEqual(round.alerts.map(e => e.eventId), ["result"]);
});
test("Chinese model failure prefix does not duplicate the same timeout", () => {
  const text = "等待首个可解析响应片段超时";
  const round = roundPresentation([event("n", "runtime.notice", { kind: "failure", message: `模型请求失败：${text}` }), event("end", "task.finished", { state: "failed", error: text })]);
  assert.equal(round.alerts.length, 1);
});
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

test("patch failures and terminal answer are not displayed twice", () => {
  const failed = "Tool error: patches[4].old_text was not found";
  const events = [event("t", "tool.finished", { name: "apply_patch", summary: failed, result: { status: "failure" } }), event("n", "runtime.notice", { kind: "failure", message: `apply_patch: ${failed}` }), event("a", "assistant.message", { text: "模型响应未完整结束", hasToolCalls: false }), event("end", "task.finished", { state: "failed", result: "模型响应未完整结束" })];
  const result = roundPresentation(events);
  assert.deepEqual(result.alerts.map((e) => e.eventId), ["t"]);
  assert.equal(result.answer?.eventId, "a");
  assert.equal(events.length, 4);
});

test("generated media comes from successful media tools' Saved lines, once per path, with a kind the conversation can show", () => {
  const image = "Generated image with image-model\nRequest: req-1\nSaved: assets/cat.png\nSource URL: https://assets.example/cat.png";
  const events = [
    event("i", "tool.finished", { name: "generate_image", summary: image, result: { status: "success" }, verification: false }),
    event("again", "tool.finished", { name: "generate_image", summary: "Reused completed image request req-1; no new generation charge.\nSaved: assets/cat.png", verification: false }),
    event("v", "tool.finished", { name: "generate_video", summary: "Generated video with v\nRequest: req-2\nTask: t\nSaved: clips\\intro.mp4\nSource URL: https://x", result: { status: "success" } }),
    event("a", "tool.finished", { name: "resume_media_operation", summary: "Resumed audio request req-3; no new generation charge.\nSaved: voice.mp3" }),
    event("pcm", "tool.finished", { name: "generate_audio", summary: "Generated audio with a\nRequest: req-4\nSaved: raw.pcm" }),
    event("failed", "tool.finished", { name: "generate_image", summary: "Tool error: generate_image: Image request req-5 was rejected", result: { status: "failure" } }),
    event("denied", "tool.finished", { name: "generate_image", summary: "Tool execution denied\nSaved: nope.png", result: { status: "denied" } }),
    event("other", "tool.finished", { name: "write_file", summary: "Wrote x\nSaved: x.png", result: { status: "success" } }),
    event("list", "tool.finished", { name: "list_media_operations", summary: "Saved: listed.png", result: { status: "success" } }),
  ];
  assert.deepEqual(generatedMedia(events), [
    { eventId: "again", tool: "generate_image", path: "assets/cat.png", kind: "image" },
    { eventId: "v", tool: "generate_video", path: "clips\\intro.mp4", kind: "video" },
    { eventId: "a", tool: "resume_media_operation", path: "voice.mp3", kind: "audio" },
  ]);
  assert.deepEqual(roundPresentation(events).media.map((item) => item.path), ["assets/cat.png", "clips\\intro.mp4", "voice.mp3"]);
  assert.deepEqual(roundPresentation([event("s", "task.started", { taskPreview: "hi" })]).media, []);
});
