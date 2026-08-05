import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { builtinTools } from "../src/tools.js";
import type { AssistantTurn, ConversationMessage, ModelProvider, ToolDefinition } from "../src/types.js";

class ScriptedProvider implements ModelProvider {
  calls = 0;
  async complete(_system: string, messages: ConversationMessage[], _tools: ToolDefinition[]): Promise<AssistantTurn> {
    this.calls++;
    if (this.calls === 1) {
      return {
        text: "I will create the file.",
        toolCalls: [{ id: "call-1", name: "write_file", input: { path: "answer.txt", content: "done" } }],
        raw: { role: "assistant", content: "I will create the file." },
      };
    }
    if (this.calls === 2) {
      assert.equal(messages.at(-1)?.role, "tool");
      assert.match(messages.at(-1)?.content ?? "", /Wrote/);
      return { text: "Completed.", toolCalls: [], raw: { role: "assistant", content: "Completed." } };
    }
    assert.equal(messages.at(-1)?.role, "user");
    assert.match(messages.at(-1)?.content ?? "", /Completion gate/);
    return { text: "Completed after reviewing verification limits.", toolCalls: [], raw: { role: "assistant", content: "Completed after reviewing verification limits." } };
  }
}

test("agent executes tools and continues until the model finishes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-"));
  const config: AgentConfig = { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true };
  const provider = new ScriptedProvider();
  const events: string[] = [];
  const agent = new Agent(config, provider, builtinTools, async () => true, { onToolStart: (name) => events.push(name) });
  const result = await agent.run("Create answer.txt");
  assert.equal(result, "Completed after reviewing verification limits.");
  assert.equal(await fs.readFile(path.join(cwd, "answer.txt"), "utf8"), "done");
  assert.deepEqual(events, ["write_file"]);
  const sessions = await fs.readdir(path.join(cwd, ".xiu", "sessions"));
  assert.equal(sessions.length, 1);
});

test("agent cancellation aborts an in-flight model request", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-cancel-"));
  const provider: ModelProvider = {
    async complete(_system, _messages, _tools, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const config: AgentConfig = { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true };
  const agent = new Agent(config, provider, builtinTools, async () => true);
  const running = agent.run("wait forever");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(agent.cancel(), true);
  await assert.rejects(running, /Task cancelled/);
});

test("agent retains conversation across interactive tasks and can clear it", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-conversation-"));
  const messageCounts: number[] = [];
  const provider: ModelProvider = {
    async complete(_system, messages) {
      messageCounts.push(messages.length);
      return { text: "ok", toolCalls: [], raw: { role: "assistant", content: "ok" } };
    },
  };
  const config: AgentConfig = { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true };
  const agent = new Agent(config, provider, builtinTools, async () => true);
  await agent.run("first");
  await agent.run("second");
  agent.clearConversation();
  await agent.run("third");
  assert.deepEqual(messageCounts, [1, 3, 1]);
});

test("agent streams model text without printing the completed response twice", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-stream-"));
  const provider: ModelProvider = {
    async complete() { throw new Error("non-streaming path should not be used"); },
    async stream(_system, _messages, _tools, onTextDelta) {
      onTextDelta("hello ");
      onTextDelta("world");
      return { text: "hello world", toolCalls: [], raw: {} };
    },
  };
  const deltas: string[] = [];
  const completed: string[] = [];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true }, provider, [], async () => true, {
    onTextDelta: (text) => deltas.push(text),
    onText: (text) => completed.push(text),
  });
  assert.equal(await agent.run("stream"), "hello world");
  assert.deepEqual(deltas, ["hello ", "world"]);
  assert.deepEqual(completed, []);
});

test("agent retries a transient model failure before any text is emitted", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-retry-"));
  let calls = 0;
  const retries: string[] = [];
  const provider: ModelProvider = {
    async complete() { throw new Error("unused"); },
    async stream(_system, _messages, _tools, onTextDelta) {
      calls++;
      if (calls === 1) throw Object.assign(new Error("rate limit"), { status: 429 });
      onTextDelta("recovered");
      return { text: "recovered", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true }, provider, [], async () => true, {
    onTextDelta: () => {},
    onRetry: (message) => retries.push(message),
  });
  assert.equal(await agent.run("retry"), "recovered");
  assert.equal(calls, 2);
  assert.match(retries[0] ?? "", /retrying 2\/3/);
});
