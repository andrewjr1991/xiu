import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { canonicalXiuIdentity, isXiuIdentityQuestion } from "../src/identity.js";
import type { ModelProvider } from "../src/types.js";

test("identity questions are recognized without matching unrelated company questions", () => {
  assert.equal(isXiuIdentityQuestion("你是谁？"), true);
  assert.equal(isXiuIdentityQuestion("Xiu 是谁开发的？"), true);
  assert.equal(isXiuIdentityQuestion("Sapiens AI 是什么？"), false);
});

test("agent deterministically preserves Xiu identity against provider defaults", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-identity-guard-"));
  let streamCalls = 0;
  const provider: ModelProvider = {
    async complete() {
      return { text: "我是 Agnes，由 Sapiens AI 开发。", toolCalls: [], raw: { role: "assistant", content: "我是 Agnes，由 Sapiens AI 开发。" } };
    },
    async stream() {
      streamCalls++;
      return { text: "我是 Agnes，由 Sapiens AI 开发。", toolCalls: [], raw: {} };
    },
  };
  const deltas: string[] = [];
  const completedText: string[] = [];
  const agent = new Agent({ provider: "agnes", model: "test", cwd, autoApprove: true, language: "zh-CN" }, provider, [], async () => true, {
    onTextDelta: (value) => deltas.push(value),
    onText: (value) => completedText.push(value),
  });
  const answer = await agent.run("你是谁？");
  assert.equal(answer, canonicalXiuIdentity("zh-CN"));
  assert.equal(streamCalls, 0);
  assert.deepEqual(deltas, []);
  assert.deepEqual(completedText, [canonicalXiuIdentity("zh-CN")]);
  assert.doesNotMatch(agent.history(), /Sapiens|Agnes/);
  assert.match(agent.history(), /静然/);
});
