import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { resolveConfig, type AgentConfig } from "../src/config.js";
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
  const changedPaths: string[] = [];
  const changes: Array<{ additions?: number; deletions?: number; preview: string[] }> = [];
  const narratedTurns: string[] = [];
  let outcome = "";
  const agent = new Agent(config, provider, builtinTools, async () => true, {
    onToolStart: (name) => events.push(name),
    onAssistantTurn: (text, hasToolCalls) => { if (hasToolCalls) narratedTurns.push(text); },
    onWorkspaceChange: (change) => {
      changedPaths.push(...change.paths);
      changes.push(...change.files);
    },
    onTaskComplete: (summary) => { outcome = summary.outcome; },
  });
  const result = await agent.run("Create answer.txt");
  assert.equal(result, "Completed after reviewing verification limits.");
  assert.equal(await fs.readFile(path.join(cwd, "answer.txt"), "utf8"), "done");
  assert.deepEqual(events, ["write_file"]);
  assert.deepEqual(narratedTurns, ["I will create the file."]);
  assert.deepEqual(changedPaths, ["answer.txt"]);
  assert.equal(changes[0]?.additions, 1);
  assert.equal(changes[0]?.deletions, 0);
  assert.deepEqual(changes[0]?.preview, []);
  assert.equal(outcome, "unverified");
  assert.equal(agent.status().outcome, "unverified");
  assert.equal(agent.status().diagnostics?.model.attempts, 3);
  assert.equal(agent.status().diagnostics?.tools.calls, 1);
  assert.equal(agent.status().diagnostics?.outcome, "unverified");
  const sessions = await fs.readdir(path.join(cwd, ".xiu", "sessions"));
  assert.equal(sessions.length, 1);
  assert.equal((await loadSession(cwd)).diagnostics?.tools.calls, 1);
});

test("agent does not report success when the final tool operation failed", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-tool-failure-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      return calls === 1
        ? { text: "Trying.", toolCalls: [{ id: "failed", name: "always_fails", input: {} }], raw: {} }
        : { text: "The service is unavailable.", toolCalls: [], raw: {} };
    },
  };
  const tool: AgentTool = {
    name: "always_fails", description: "fail deterministically", risk: "execute",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "run failing operation",
    execute: async () => "Tool error: service unavailable",
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true }, provider, [tool], async () => true);
  assert.equal(await agent.run("Complete an external operation"), "The service is unavailable.");
  assert.equal(agent.status().outcome, "failed");
  assert.equal(agent.status().diagnostics?.outcome, "failed");
});

test("agent stops at a safe boundary before executing tools after token budget exhaustion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-budget-"));
  let toolRan = false;
  const provider: ModelProvider = {
    async complete() {
      return { text: "About to act.", toolCalls: [{ id: "call", name: "side_effect", input: {} }], raw: {}, usage: { inputTokens: 90, outputTokens: 20, totalTokens: 110 } };
    },
  };
  const tool: AgentTool = {
    name: "side_effect", description: "side effect", risk: "write", inputSchema: { type: "object", properties: {} }, describe: () => "side effect",
    execute: async () => { toolRan = true; return "done"; },
  };
  const warnings: string[] = [];
  const config = resolveConfig({ provider: "openai", cwd, budgetTokens: "100", budgetWarningPercent: "80", yes: true });
  const agent = new Agent(config, provider, [tool], async () => true, { onBudgetWarning: (message) => warnings.push(message) });
  await assert.rejects(() => agent.run("bounded task"), /预算已用尽|budget exhausted/i);
  assert.equal(toolRan, false);
  assert.equal(agent.status().outcome, "paused");
  assert.equal(agent.status().diagnostics?.budget?.state, "exhausted");
});

test("agent completes a generated artifact after verify_output passes", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-artifact-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete(_system, messages) {
      calls++;
      if (calls === 1) {
        return {
          text: "Generating the table.",
          toolCalls: [{ id: "write-html", name: "write_file", input: { path: "result.html", content: "<!DOCTYPE html><table><tr><td>001</td><td>002</td></tr></table>" } }],
          raw: {},
        };
      }
      if (calls === 2) {
        assert.match(messages.at(-1)?.content ?? "", /Wrote/);
        return {
          text: "Checking the deliverable.",
          toolCalls: [{ id: "verify-html", name: "verify_output", input: { path: "result.html", required_substrings: ["<!DOCTYPE html>", "<table>", "001", "002"] } }],
          raw: {},
        };
      }
      assert.match(messages.at(-1)?.content ?? "", /^Verification passed:/);
      return { text: "The verified table is ready.", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true }, provider, builtinTools, async () => true);
  assert.equal(await agent.run("Create a prelabel table"), "The verified table is ready.");
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

test("a malformed redundant tool call cannot override successful verification in the same batch", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-mixed-tool-batch-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls++;
      if (calls === 1) {
        return {
          text: "Creating the artifact.",
          toolCalls: [{ id: "write", name: "write_file", input: { path: "video.mp4", content: "fake-mp4-payload" } }],
          raw: {},
        };
      }
      if (calls === 2) {
        return {
          text: "Verifying the artifact.",
          toolCalls: [
            { id: "verify", name: "verify_output", input: { path: "video.mp4", min_bytes: 8, required_substrings: ["mp4"] } },
            { id: "redundant", name: "run_process", input: { program: "node", args: "[\"--version\"]" } },
          ],
          raw: {},
        };
      }
      return { text: "The verified artifact is ready.", toolCalls: [], raw: {} };
    },
  };
  const failures: string[] = [];
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true },
    provider,
    builtinTools,
    async () => true,
    { onFailure: (message) => failures.push(message) },
  );

  assert.equal(await agent.run("Create and verify a video artifact"), "The verified artifact is ready.");
  assert.equal(agent.status().outcome, "completed");
  assert.equal(agent.status().diagnostics?.tools.calls, 3);
  assert.equal(agent.status().diagnostics?.tools.failures, 1);
  assert.match(failures.at(-1) ?? "", /invalid arguments for run_process/);
});

test("agent rebuilds its language contract immediately after a runtime switch", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-language-switch-"));
  const systems: string[] = [];
  const provider: ModelProvider = {
    async complete(system) {
      systems.push(system);
      return { text: "done", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, autoApprove: true, language: "en-US" }, provider, [], async () => true);

  await agent.run("first task");
  agent.setLanguage("zh-CN");
  await agent.run("第二个任务");

  assert.match(systems[0] ?? "", /Language contract: Use English/);
  assert.match(systems[1] ?? "", /Use Simplified Chinese/);
});

test("Chinese agent returns and stores normalized Simplified Chinese", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-simplified-output-"));
  const provider: ModelProvider = {
    async complete() {
      return { text: "設計與驗證已完成。保留 `繁體變數`。", toolCalls: [], raw: { content: "設計與驗證已完成。" } };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, autoApprove: true, language: "zh-CN" }, provider, [], async () => true);
  assert.equal(await agent.run("完成任务"), "设计与验证已完成。保留 `繁體變數`。");
  assert.match(agent.history(), /设计与验证已完成/);
  assert.doesNotMatch(agent.history(), /設計與驗證/);
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
  assert.equal(agent.status().diagnostics?.model.failures, 0);
  assert.equal(agent.status().diagnostics?.outcome, "cancelled");
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
  assert.equal(agent.status().diagnostics?.model.attempts, 2);
  assert.equal(agent.status().diagnostics?.model.failures, 1);
  assert.equal(agent.status().diagnostics?.model.retries, 1);
});

test("agent fails over after bounded transient retries before any output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-failover-"));
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary: ModelProvider = {
    async complete() {
      primaryCalls++;
      throw Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
    },
  };
  const fallback: ModelProvider = {
    async complete() {
      fallbackCalls++;
      return { text: "continued on backup", toolCalls: [], raw: {} };
    },
  };
  const config: AgentConfig = { provider: "openai", providerId: "primary", model: "primary-model", cwd, autoApprove: true };
  const switches: string[] = [];
  const agent = new Agent(config, primary, [], async () => true, {
    onProviderFailover: ({ fromProviderId, toProviderId }) => switches.push(`${fromProviderId}->${toProviderId}`),
  });
  agent.setFailoverController({
    async resolve() {
      return { candidate: { config: { ...config, providerId: "backup", model: "backup-model" }, provider: fallback, tools: [], label: "Backup" } };
    },
  });

  assert.equal(await agent.run("finish safely"), "continued on backup");
  assert.equal(primaryCalls, 3);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(switches, ["primary->backup"]);
  assert.equal(agent.status().model, "backup-model");
  assert.equal(agent.status().diagnostics?.providerFailovers?.switches, 1);
});

test("agent routes a model request by phase and restores the user's provider after the task", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-routing-"));
  let primaryCalls = 0;
  let plannerCalls = 0;
  const primary: ModelProvider = {
    async complete() { primaryCalls++; return { text: "primary", toolCalls: [], raw: {} }; },
  };
  const planner: ModelProvider = {
    async complete() { plannerCalls++; return { text: "planned", toolCalls: [], raw: {} }; },
  };
  const config: AgentConfig = { provider: "openai", providerId: "primary", model: "primary-model", cwd, autoApprove: true };
  const switches: string[] = [];
  const restores: string[] = [];
  const agent = new Agent(config, primary, [], async () => true, {
    onProviderRoute: ({ phase, toProviderId }) => switches.push(`${phase}:${toProviderId}`),
    onProviderRouteRestore: ({ providerId, model }) => restores.push(`${providerId}/${model}`),
  });
  agent.setRoutingController({
    async resolve(request) {
      assert.equal(request.phase, "planning");
      return {
        targetProviderId: "planner",
        reason: "configured planning route",
        candidate: { config: { ...config, providerId: "planner", model: "planner-model" }, provider: planner, tools: [], label: "Planner" },
      };
    },
  });

  assert.equal(await agent.run("make a plan"), "planned");
  assert.equal(primaryCalls, 0);
  assert.equal(plannerCalls, 1);
  assert.deepEqual(switches, ["planning:planner"]);
  assert.deepEqual(restores, ["primary/primary-model"]);
  assert.equal(agent.status().model, "primary-model");
  assert.equal(agent.status().diagnostics?.providerRoutes?.switches, 1);
  assert.equal(agent.status().diagnostics?.providerRoutes?.phaseCalls?.planning, 1);
  assert.equal(agent.status().diagnostics?.providerRoutes?.phaseEvents?.[0]?.reason, "initial_analysis");
});

test("agent keeps the current provider when a configured stage route is unsafe", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-routing-skip-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() { calls++; return { text: "safe current result", toolCalls: [], raw: {} }; },
  };
  const skipped: string[] = [];
  const agent = new Agent({ provider: "openai", providerId: "primary", model: "primary-model", cwd, autoApprove: true }, provider, [], async () => true, {
    onProviderRouteSkipped: ({ reason }) => skipped.push(reason),
  });
  agent.setRoutingController({
    async resolve() { return { targetProviderId: "tiny", reason: "context exceeds target safe limit" }; },
  });

  assert.equal(await agent.run("stay safe"), "safe current result");
  assert.equal(calls, 1);
  assert.deepEqual(skipped, ["context exceeds target safe limit"]);
  assert.equal(agent.status().diagnostics?.providerRoutes?.skipped, 1);
});

test("agent never fails over after streaming partial output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-no-unsafe-failover-"));
  let resolutions = 0;
  const provider: ModelProvider = {
    async complete() { throw new Error("complete should not run"); },
    async stream(_system, _messages, _tools, onTextDelta) {
      onTextDelta("partial");
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    },
  };
  const agent = new Agent({ provider: "openai", providerId: "primary", model: "test", cwd, autoApprove: true }, provider, [], async () => true, { onTextDelta: () => {} });
  agent.setFailoverController({ async resolve() { resolutions++; return {}; } });

  await assert.rejects(agent.run("do not duplicate output"), /connection reset/);
  assert.equal(resolutions, 0);
});

test("context compaction uses the failover chain without exposing tools or partial output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compact-failover-"));
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary: ModelProvider = {
    async complete() {
      primaryCalls++;
      if (primaryCalls === 1) return { text: "seed response", toolCalls: [], raw: {} };
      throw Object.assign(new Error("upstream temporarily unavailable"), { status: 503 });
    },
  };
  const fallback: ModelProvider = {
    async complete(system, _messages, tools) {
      fallbackCalls++;
      assert.match(system, /CONTEXT CHECKPOINT COMPACTION/);
      assert.deepEqual(tools, []);
      return { text: "Current progress: preserved on backup\nNext action: continue", toolCalls: [], raw: {} };
    },
  };
  const config: AgentConfig = { provider: "openai", providerId: "primary", model: "primary-model", cwd, autoApprove: true };
  const switches: string[] = [];
  const failures: string[] = [];
  const agent = new Agent(config, primary, [], async () => true, {
    onProviderFailover: ({ fromProviderId, toProviderId }) => switches.push(`${fromProviderId}->${toProviderId}`),
    onFailure: (message) => failures.push(message),
  });
  agent.setFailoverController({
    async resolve(request) {
      assert.equal(request.requiresTools, false);
      return { candidate: { config: { ...config, providerId: "backup", model: "backup-model" }, provider: fallback, tools: [], label: "Backup" } };
    },
  });

  assert.equal(await agent.run("seed the conversation"), "seed response");
  assert.match(await agent.compact(), /Compacted context/);
  assert.equal(primaryCalls, 4);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(switches, ["primary->backup"]);
  assert.deepEqual(failures, []);
  assert.equal(agent.status().model, "backup-model");
});
