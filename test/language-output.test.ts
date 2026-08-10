import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAssistantText } from "../src/language-output.js";

test("normalizes Traditional Chinese prose while preserving code literals", () => {
  const input = "設計已完成，請重新整理。\n\n```js\nconst label = '設計';\n```\n執行 `git 狀態` 後繼續。";
  const output = normalizeAssistantText(input, "zh-CN");
  assert.match(output, /设计已完成，请重新整理/);
  assert.match(output, /```js\nconst label = '設計';\n```/);
  assert.match(output, /`git 狀態`/);
  assert.match(output, /后继续/);
});

test("leaves English output unchanged", () => {
  assert.equal(normalizeAssistantText("Design complete.", "en-US"), "Design complete.");
});
