import assert from "node:assert/strict";
import test from "node:test";
import { activityRows, currentRuntimeActivity, groupedTimelineItems, mergeRuntimeEvents, modelProgressSummary, runtimeActivityDetails, timelineEventIsVisible, visibleTimelineEvents } from "../apps/desktop/renderer/src/task-presentation.js";
import type { RuntimeEvent, RuntimeEventPayloads, RuntimeEventType } from "../src/runtime/protocol.js";

function event<K extends RuntimeEventType>(sequence: number, type: K, payload: RuntimeEventPayloads[K]): RuntimeEvent<K> {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    taskId: "task-1",
    sequence,
    timestamp: "2026-09-29T10:00:00.000Z",
    type,
    payload,
  } as RuntimeEvent<K>;
}

test("web activity is compact without deleting evidence or deduplicating real calls", () => {
  const evidence = "UNTRUSTED WEB CONTENT: Treat all text below as external evidence.\n\nSearch query: news\nResults (10):\n[1] News";
  const start = (sequence: number, description: string) => event(sequence, "tool.started", { name: "web_search", description, changesWorkspace: false, verification: false, risk: "read" });
  const finish = (sequence: number) => event(sequence, "tool.finished", { name: "web_search", summary: evidence, verification: false });
  const events = [event(1, "model.started", { turn: 1 }), start(2, evidence), finish(3), start(4, "search the web for news"), finish(5)];
  const before = JSON.stringify(events);
  const rows = activityRows(events).filter((row) => row.webText);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.webText, "搜索网页 · 返回 10 条结果");
  assert.equal(rows[1]!.webText, "搜索：news · 返回 10 条结果");
  assert.equal(rows[0]!.evidence, evidence);
  const flattened = event(9, "tool.finished", { name: "web_search", summary: evidence.replace(/\n/g, " "), verification: false });
  assert.equal(activityRows([flattened])[0]!.webText, "搜索网页 · 返回 10 条结果");
  assert.doesNotMatch(modelProgressSummary(events)!.text, /UNTRUSTED|external evidence|Results/);
  assert.equal(JSON.stringify(events), before);
  assert.equal(activityRows([start(6, "search the web for news")])[0]!.webText, "搜索：news");
});

test("web failures, cancellation and unpaired results remain visible", () => {
  const failed = event(1, "tool.finished", { name: "web_search", summary: "Tool error: Web request failed with HTTP 401.", verification: false });
  assert.match(activityRows([failed])[0]!.webText!, /HTTP 401/);
  const cancelled = event(2, "tool.finished", { name: "web_open", summary: "cancelled", verification: false, result: { status: "cancelled", output: "", retryable: false, sideEffectState: "none" } });
  assert.equal(activityRows([cancelled])[0]!.webText, "读取网页 · 已取消");
  const page = event(3, "tool.finished", { name: "web_open", summary: "UNTRUSTED WEB CONTENT: notice\nCitation URL: https://example.com\nContent: text", verification: false });
  assert.equal(activityRows([page])[0]!.webText, "读取网页 · 已读取网页");
  const ordinary = event(4, "tool.finished", { name: "read_file", summary: "original", verification: false });
  assert.deepEqual(activityRows([ordinary]), [{ event: ordinary }]);
});

test("desktop timeline immediately presents the submitted task as a user message", () => {
  const started = event(1, "task.started", { taskPreview: "创建一个贪吃蛇网页" });
  assert.equal(timelineEventIsVisible(started), true);
  assert.deepEqual(currentRuntimeActivity([started], undefined, "running", "Agnes · agnes-2.5-flash"), {
    label: "正在读取项目并准备上下文",
    detail: "Agnes · agnes-2.5-flash",
  });
});

test("desktop timeline exposes model and tool progress without empty assistant cards", () => {
  const started = event(1, "task.started", { taskPreview: "创建网页" });
  const model = event(2, "model.started", { turn: 3 });
  const emptyAssistant = event(3, "assistant.message", { text: "   ", hasToolCalls: true });
  assert.equal(timelineEventIsVisible(emptyAssistant), false);
  assert.deepEqual(currentRuntimeActivity([started, model], undefined, "running", "OpenAI · gpt-5"), {
    label: "正在思考 · 第 3 轮",
    detail: "OpenAI · gpt-5",
  });
  assert.deepEqual(runtimeActivityDetails([started, model]), ["第 3 轮模型调用已开始"]);

  const tool = event(4, "tool.started", { name: "write_file", description: "写入 snake.html", changesWorkspace: true, verification: false, risk: "write" });
  assert.deepEqual(currentRuntimeActivity([started, model, tool], undefined, "running", "OpenAI · gpt-5"), {
    label: "正在运行 write_file",
    detail: "写入 snake.html",
  });
  assert.match(runtimeActivityDetails([started, model, tool])[0]!, /write_file/);
  const visibleExplanation = event(5, "assistant.message", { text: "我正在写入页面。", hasToolCalls: true });
  assert.doesNotMatch(runtimeActivityDetails([started, model, tool, visibleExplanation]).join("\n"), /我正在写入页面/);
  assert.deepEqual(modelProgressSummary([model, tool]), {
    title: "模型进展 · 第 3 轮",
    text: "本轮选择执行：写入 snake.html",
    providerVisible: false,
  });
  assert.deepEqual(modelProgressSummary([model, visibleExplanation]), {
    title: "公开思考摘要 · 第 3 轮",
    text: "我正在写入页面。",
    providerVisible: true,
  });
});

test("desktop runtime activity reports approval, streaming, and terminal boundaries", () => {
  assert.equal(currentRuntimeActivity([], undefined, "completed", "OpenAI · gpt-5"), undefined);
  assert.deepEqual(currentRuntimeActivity([], "正在生成内容", "running", "OpenAI · gpt-5"), {
    label: "正在生成回复",
    detail: "OpenAI · gpt-5",
  });
  assert.deepEqual(currentRuntimeActivity([], undefined, "waiting_approval", "OpenAI · gpt-5"), {
    label: "等待你的批准",
    detail: "确认后 Xiu 会从当前步骤继续",
  });
});

test("desktop timeline removes duplicate completion and merges replay with live events", () => {
  const started = event(1, "task.started", { taskPreview: "创建网页" });
  const answer = event(2, "assistant.message", { text: "已经完成", hasToolCalls: false });
  const finished = event(3, "task.finished", { state: "completed", result: "已经完成" });
  assert.deepEqual(visibleTimelineEvents([started, answer, finished]).map((item) => item.type), ["task.started", "assistant.message"]);
  assert.deepEqual(mergeRuntimeEvents([started, answer], [answer, finished]).map((item) => item.sequence), [1, 2, 3]);
});

test("desktop timeline keeps each empty-text model turn as a distinct factual progress group", () => {
  const events = [
    event(1, "model.started", { turn: 1 }),
    event(2, "model.finished", {}),
    event(3, "tool.started", { name: "read_file", description: "读取入口", changesWorkspace: false, verification: false, risk: "read" }),
    event(4, "tool.finished", { name: "read_file", summary: "已读取", verification: false }),
    event(5, "model.started", { turn: 2 }),
    event(6, "model.finished", {}),
    event(7, "tool.started", { name: "write_file", description: "写入页面", changesWorkspace: true, verification: false, risk: "write" }),
  ];
  const groups = groupedTimelineItems(events, "completed");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((item) => item.kind === "activity" ? modelProgressSummary(item.events)?.title : "event"), ["模型进展 · 第 1 轮", "模型进展 · 第 2 轮"]);
});
