import assert from "node:assert/strict";
import test from "node:test";
import { continueTaskAfterAnswer, parseAssistantInteraction } from "../src/assistant-interaction.js";

test("explicit user-input marker becomes a blocking terminal question without leaking the marker", () => {
  const parsed = parseAssistantInteraction("我需要先确认目标平台。\n\n使用 Windows 还是 macOS？\nUSER_INPUT_REQUIRED: 使用 Windows 还是 macOS？", "zh-CN");
  assert.equal(parsed.text, "我需要先确认目标平台。");
  assert.equal(parsed.question, "使用 Windows 还是 macOS？");
});

test("a direct unmarked Chinese question is detected as a compatibility fallback", () => {
  const parsed = parseAssistantInteraction("开始前需要确认：你希望使用哪种配色？", "zh-CN");
  assert.equal(parsed.question, "开始前需要确认：你希望使用哪种配色？");
});

test("a completed declarative response does not enter waiting state", () => {
  const parsed = parseAssistantInteraction("修改已完成，并通过全部测试。", "zh-CN");
  assert.equal(parsed.question, undefined);
});

test("an optional closing offer does not masquerade as a blocking question", () => {
  const parsed = parseAssistantInteraction("任务已经完成。需要我继续优化吗？", "zh-CN");
  assert.equal(parsed.question, undefined);
});

test("a user answer resumes the original task instead of becoming a new independent goal", () => {
  const continued = continueTaskAfterAnswer("创建网站", "选择哪种配色？", "深色", "zh-CN");
  assert.match(continued, /原始任务：\n创建网站/);
  assert.match(continued, /用户回答：\n深色/);
  assert.match(continued, /继续完成原始任务/);
});
