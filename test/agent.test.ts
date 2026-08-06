import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { loadSession } from "../src/session.js";
import { builtinTools } from "../src/tools.js";
import type { AgentTool, AssistantTurn, ConversationMessage, ModelProvider, ToolDefinition } from "../src/types.js";

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
  let outcome = "";
  const agent = new Agent(config, provider, builtinTools, async () => true, {
    onToolStart: (name) => events.push(name),
    onTaskComplete: (summary) => { outcome = summary.outcome; },
  });
  const result = await agent.run("Create answer.txt");
  assert.equal(result, "Completed after reviewing verification limits.");
  assert.equal(await fs.readFile(path.join(cwd, "answer.txt"), "utf8"), "done");
  assert.deepEqual(events, ["write_file"]);
  assert.equal(outcome, "unverified");
  assert.equal(agent.status().outcome, "unverified");
  const sessions = await fs.readdir(path.join(cwd, ".xiu", "sessions"));
  assert.equal(sessions.length, 1);
});

test("steering amends the active task without replacing its primary goal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-steer-"));
  await fs.writeFile(path.join(cwd, "input.txt"), "data");
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let calls = 0;
  const provider: ModelProvider = {
    async complete(_system, messages) {
      calls++;
      if (calls === 1) {
        release();
        await blocked;
        return { text: "inspect", toolCalls: [{ id: "read-1", name: "read_file", input: { path: "input.txt" } }], raw: {} };
      }
      if (calls === 2) {
        const steering = messages.at(-1)?.content ?? "";
        assert.match(steering, /PRIMARY GOAL \(still mandatory\)/);
        assert.match(steering, /process input/);
        assert.match(steering, /also create JSONL/);
        return { text: "I only answered the added request.", toolCalls: [], raw: {} };
      }
      const audit = messages.at(-1)?.content ?? "";
      assert.match(audit, /Task-contract completion audit/);
      assert.match(audit, /process input/);
      assert.match(audit, /also create JSONL/);
      return { text: "primary goal and steering complete", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true }, provider, builtinTools, async () => true);
  const running = agent.run("process input");
  await started;
  assert.equal(agent.steer("also create JSONL"), true);
  unblock();
  assert.equal(await running, "primary goal and steering complete");
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

test("agent stops a repeated successful tool-call loop before the turn limit", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-loop-"));
  await fs.writeFile(path.join(cwd, "same.txt"), "same");
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls++;
      return { text: "read again", toolCalls: [{ id: `read-${calls}`, name: "read_file", input: { path: "same.txt" } }], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 20, autoApprove: true }, provider, builtinTools, async () => true);
  await assert.rejects(agent.run("inspect without looping"), /repeatedly revisiting/i);
  assert.ok(calls < 20);
  assert.equal(agent.status().outcome, "failed");
});

test("agent can continue beyond 30 model turns when no explicit limit is configured", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-unlimited-turns-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls++;
      if (calls <= 30) {
        return { text: `working ${calls}`, toolCalls: [{ id: `missing-${calls}`, name: `missing_tool_${calls}`, input: {} }], raw: {} };
      }
      return { text: "completed after turn 30", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, autoApprove: true }, provider, [], async () => true);
  assert.equal(await agent.run("finish a long task"), "completed after turn 30");
  assert.equal(calls, 31);
  assert.equal(agent.status().maxTurns, undefined);
});

test("agent keeps complete tool logs out of the model context after a bounded head and tail", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-tool-context-"));
  const largeResult = `HEAD-${"A".repeat(40_000)}-${"B".repeat(40_000)}-TAIL`;
  const tool: AgentTool = {
    name: "large_result",
    description: "Return a large diagnostic result.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "return large result",
    async execute() { return largeResult; },
  };
  let calls = 0;
  const provider: ModelProvider = {
    async complete(_system, messages) {
      calls++;
      if (calls === 1) return { text: "inspect", toolCalls: [{ id: "large-1", name: "large_result", input: {} }], raw: {} };
      const toolResult = messages.at(-1)?.content ?? "";
      assert.ok(toolResult.length <= 33_000);
      assert.match(toolResult, /^HEAD-/);
      assert.match(toolResult, /tool output middle omitted/i);
      assert.match(toolResult, /-TAIL$/);
      return { text: "done", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true }, provider, [tool], async () => true);
  assert.equal(await agent.run("inspect a large result"), "done");
  const restored = await loadSession(cwd);
  const restoredTool = restored.messages.find((message) => message.role === "tool");
  assert.ok((restoredTool?.content.length ?? 0) <= 33_000);
  const sessionFile = (await fs.readdir(path.join(cwd, ".xiu", "sessions"))).at(0)!;
  const events = (await fs.readFile(path.join(cwd, ".xiu", "sessions", sessionFile), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
  const toolEvent = events.find((event) => event.type === "tool");
  assert.equal(toolEvent?.result, largeResult);
  assert.equal(toolEvent?.contextResult, restoredTool?.content);
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
