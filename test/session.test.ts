import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { estimateConversationTokens, listSessions, loadSession } from "../src/session.js";
import type { ModelProvider } from "../src/types.js";

function config(cwd: string): AgentConfig {
  return { provider: "openai", model: "test-model", cwd, maxTurns: 5, autoApprove: true, contextLimit: 60_000 };
}

test("a closed session can be loaded and continued in the same project", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-resume-"));
  const firstProvider: ModelProvider = {
    async complete() { return { text: "first answer", toolCalls: [], raw: { role: "assistant", content: "first answer" }, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }; },
  };
  await new Agent(config(cwd), firstProvider, [], async () => true).run("first task");
  const sessions = await listSessions(cwd);
  assert.equal(sessions.length, 1);
  const restored = await loadSession(cwd);
  assert.equal(restored.messages[0]?.content, "first task");
  assert.equal(restored.stats.modelCalls, 1);

  let sawPreviousAnswer = false;
  const secondProvider: ModelProvider = {
    async complete(_system, messages) {
      sawPreviousAnswer = messages.some((message) => message.content === "first answer");
      return { text: "continued", toolCalls: [], raw: { role: "assistant", content: "continued" } };
    },
  };
  await new Agent(config(cwd), secondProvider, [], async () => true, {}, restored).run("continue task");
  assert.equal(sawPreviousAnswer, true);
  assert.equal((await listSessions(cwd)).length, 1);
});

test("sessions are isolated by workspace", async () => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-project-a-"));
  const second = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-project-b-"));
  const provider: ModelProvider = { async complete() { return { text: "done", toolCalls: [], raw: {} }; } };
  await new Agent(config(first), provider, [], async () => true).run("project A");
  assert.equal((await listSessions(first)).length, 1);
  assert.equal((await listSessions(second)).length, 0);
  await assert.rejects(loadSession(second), /No Xiu sessions/);
});

test("manual compaction replaces long history with a continuation brief", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compact-"));
  const provider: ModelProvider = {
    async complete(system) {
      if (system.includes("compact coding-agent context")) {
        return { text: "Goal: preserve the completed architecture and continue testing.", toolCalls: [], raw: {}, usage: { inputTokens: 100, outputTokens: 12, totalTokens: 112 } };
      }
      return { text: "A very detailed answer ".repeat(200), toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent(config(cwd), provider, [], async () => true);
  await agent.run("Discuss the architecture in detail");
  const before = agent.status().stats.estimatedTokens;
  const result = await agent.compact("Focus on exact test output and code changes.");
  assert.match(result, /Compacted context/);
  assert.ok(agent.status().stats.estimatedTokens < before);
  assert.equal(agent.status().stats.compactions, 1);
  assert.match(agent.history(), /ACTIVE TASK CONTRACT/);
  assert.match(agent.history(), /Discuss the architecture in detail/);
  const restored = await loadSession(cwd);
  assert.match(restored.messages[0]?.content ?? "", /preserve the completed architecture/);
  assert.match(restored.messages[0]?.content ?? "", /Focus on exact test output and code changes/);
  assert.match(restored.messages[0]?.content ?? "", /RECENT USER REQUIREMENTS/);
});

test("context estimation treats Chinese text more conservatively than ASCII", () => {
  const chinese = estimateConversationTokens([{ role: "user", content: "这是一个需要保留的中文任务要求" }]);
  const ascii = estimateConversationTokens([{ role: "user", content: "abcdefghijklmn" }]);
  assert.ok(chinese > ascii);
});

test("conversation compacts automatically before crossing the configured context budget", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-auto-compact-"));
  let summaries = 0;
  const provider: ModelProvider = {
    async complete(system) {
      if (system.includes("compact coding-agent context")) {
        summaries++;
        return { text: "Continue the second task with prior decisions preserved.", toolCalls: [], raw: {} };
      }
      return { text: "lengthy context ".repeat(80), toolCalls: [], raw: {} };
    },
  };
  const tiny = { ...config(cwd), contextLimit: 100 };
  const agent = new Agent(tiny, provider, [], async () => true);
  await agent.run("first task");
  await agent.run("second task");
  assert.equal(summaries, 1);
  assert.equal(agent.status().stats.compactions, 1);
});

test("automatic compaction preserves the active primary task for the next model turn", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-active-contract-"));
  const primaryTask = "Annotate 001.html and 002.html, then produce the final online table.";
  let normalCalls = 0;
  let continuation = "";
  const provider: ModelProvider = {
    async complete(system, messages) {
      if (system.includes("CONTEXT CHECKPOINT COMPACTION")) {
        return { text: "Current progress: inspected the rules. Next action: process 001.html.", toolCalls: [], raw: {} };
      }
      normalCalls++;
      if (normalCalls === 1) {
        return {
          text: "Investigation notes ".repeat(120),
          toolCalls: [{ id: "missing-1", name: "missing_tool", input: {} }],
          raw: {},
        };
      }
      continuation = messages.map((message) => message.content).join("\n");
      return { text: "completed", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ ...config(cwd), contextLimit: 300 }, provider, [], async () => true);
  await agent.run(primaryTask);
  assert.match(continuation, /ACTIVE TASK CONTRACT/);
  assert.match(continuation, new RegExp(primaryTask.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(continuation, /Next action: process 001\.html/);
  assert.match(continuation, /TOOL EVIDENCE LEDGER/);
  assert.match(continuation, /missing_tool/);
});

test("an active interactive agent can switch to a selected persisted session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-switch-session-"));
  const provider: ModelProvider = { async complete() { return { text: "new answer", toolCalls: [], raw: {} }; } };
  const agent = new Agent(config(cwd), provider, [], async () => true);
  agent.restoreSession({
    id: "chosen-session",
    file: path.join(cwd, ".xiu", "sessions", "chosen-session.jsonl"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: "restored-model",
    messages: [{ role: "user", content: "restored task context" }],
    stats: { modelCalls: 4, toolCalls: 7, inputTokens: 100, outputTokens: 20, estimatedTokens: 8, compactions: 1, activeMs: 5000 },
  });
  assert.equal(agent.status().sessionId, "chosen-session");
  assert.equal(agent.status().model, "restored-model");
  assert.match(agent.history(), /restored task context/);
  assert.equal(agent.status().stats.toolCalls, 7);
});

test("session discovery includes legacy Forge session directories", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-legacy-session-"));
  const legacyDirectory = path.join(cwd, ".forge", "sessions");
  await fs.mkdir(legacyDirectory, { recursive: true });
  await fs.writeFile(path.join(legacyDirectory, "legacy-123.jsonl"), [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "task", task: "legacy Forge task", config: { model: "agnes-old" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "assistant", text: "legacy answer", toolCalls: [] }),
  ].join("\n") + "\n");
  const sessions = await listSessions(cwd);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "legacy-123");
  const restored = await loadSession(cwd, "legacy");
  assert.equal(restored.model, "agnes-old");
  assert.match(restored.messages[1]?.content ?? "", /legacy answer/);
});

test("internal subagent sessions do not appear in the user resume list", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-subagent-session-"));
  const provider: ModelProvider = { async complete() { return { text: "internal", toolCalls: [], raw: {} }; } };
  await new Agent({ ...config(cwd), sessionNamespace: "agent-sessions" }, provider, [], async () => true).run("internal task");
  assert.equal((await listSessions(cwd)).length, 0);
  const internal = await fs.readdir(path.join(cwd, ".xiu", "agent-sessions"));
  assert.equal(internal.length, 1);
});
