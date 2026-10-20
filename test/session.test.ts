import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { estimateConversationTokens, formatRestoredConversation, listSessions, listSessionsWithIssues, loadSession, sessionTitle, unreadableSessionsNote } from "../src/session.js";
import { TaskDiagnostics } from "../src/diagnostics.js";
import type { ModelProvider } from "../src/types.js";

function config(cwd: string): AgentConfig {
  return { provider: "openai", providerId: "openai", model: "test-model", cwd, maxTurns: 5, autoApprove: true, contextLimit: 60_000 };
}

test("a closed session can be loaded and continued in the same project", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-resume-"));
  const firstProvider: ModelProvider = {
    async complete() { return { text: "first answer", toolCalls: [], raw: { role: "assistant", content: "first answer" }, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }; },
  };
  await new Agent({ config: config(cwd), provider: firstProvider, tools: [], approve: async () => true }).run("first task");
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
  await new Agent({ config: config(cwd), provider: secondProvider, tools: [], approve: async () => true, events: {}, restored }).run("continue task");
  assert.equal(sawPreviousAnswer, true);
  assert.equal((await listSessions(cwd)).length, 1);
});

test("opaque thinking replay survives a session restore while readable blocks do not", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-thinking-replay-"));
  const replay = [{ type: "thinking" as const, thinking: "" as const, signature: "sig-opaque" }, { type: "redacted_thinking" as const, data: "enc-opaque" }];
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "checking", toolCalls: [{ id: "call-1", name: "missing_tool", input: {} }], raw: [], thinkingReplay: replay, finishReason: "tool_calls" as const };
      return { text: "done", toolCalls: [], raw: [], finishReason: "stop" as const };
    },
  };
  await new Agent({ config: config(cwd), provider, tools: [], approve: async () => true }).run("try a tool");
  const session = (await listSessions(cwd))[0]!;
  const tampered = (await fs.readFile(session.file, "utf8")).replace('"signature":"sig-opaque"', '"thinking":"leaked reasoning","signature":"sig-opaque"');
  await fs.writeFile(session.file, tampered, "utf8");
  const restored = await loadSession(cwd);
  const assistant = restored.messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
  assert.ok(assistant);
  assert.deepEqual(assistant.thinkingReplay, [{ type: "redacted_thinking", data: "enc-opaque" }]);
  assert.doesNotMatch(JSON.stringify(restored.messages), /leaked reasoning/);
});

test("sessions are isolated by workspace", async () => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-project-a-"));
  const second = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-project-b-"));
  const provider: ModelProvider = { async complete() { return { text: "done", toolCalls: [], raw: {} }; } };
  await new Agent({ config: config(first), provider, tools: [], approve: async () => true }).run("project A");
  assert.equal((await listSessions(first)).length, 1);
  assert.equal((await listSessions(second)).length, 0);
  await assert.rejects(loadSession(second), /No Xiu sessions/);
});

test("the latest bounded task diagnostics restore with the session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-diagnostic-resume-"));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const diagnostics = new TaskDiagnostics("diagnose the build");
  diagnostics.beginTool("run_process", { program: "npm", args: ["test"] });
  diagnostics.finishTool(false, "Exit code: 1");
  const file = path.join(directory, "diagnostic-session.jsonl");
  await fs.writeFile(file, [
    JSON.stringify({ timestamp: new Date().toISOString(), type: "task", task: "diagnose the build", config: { model: "test-model" } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "diagnostics", snapshot: diagnostics.snapshot() }),
  ].join("\n") + "\n");
  const restored = await loadSession(cwd, "diagnostic-session");
  assert.equal(restored.diagnostics?.task, "diagnose the build");
  assert.equal(restored.diagnostics?.tools.failures, 1);
  assert.equal(restored.diagnostics?.phase.kind, "idle");
});

test("session restoration keeps the latest provider profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-resume-"));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "provider-session.jsonl"), [
    JSON.stringify({ type: "task", task: "first", config: { provider: "openai", providerId: "openai", model: "gpt-5" } }),
    JSON.stringify({ type: "provider_changed", provider: "ollama", providerId: "ollama", model: "qwen-coder" }),
  ].join("\n") + "\n");
  const restored = await loadSession(cwd, "provider-session");
  assert.equal(restored.providerId, "ollama");
  assert.equal(restored.model, "qwen-coder");
});

test("session logs redact locally saved provider credentials", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-secret-log-"));
  const provider: ModelProvider = { async complete() { return { text: "request mentioned never-write-this-secret", toolCalls: [], raw: {} }; } };
  await new Agent({
    config: { ...config(cwd), providerId: "private", apiKey: "never-write-this-secret" },
    provider,
    tools: [],
    approve: async () => true,
  }).run("check never-write-this-secret safely");
  const session = (await listSessions(cwd))[0]!;
  const log = await fs.readFile(session.file, "utf8");
  assert.doesNotMatch(log, /never-write-this-secret/);
  assert.match(log, /"apiKey":"configured"/);
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
  const agent = new Agent({ config: config(cwd), provider, tools: [], approve: async () => true });
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

test("restored conversation preview shows recent dialogue without generated project context", () => {
  const preview = formatRestoredConversation([
    { role: "user", content: "修复选择器\n\nAutomatically prepared project context:\nlarge index" },
    { role: "tool", content: "raw tool output" },
    { role: "assistant", content: "已经修复。" },
  ], "zh-CN");
  assert.match(preview.join("\n"), /你> 修复选择器/);
  assert.match(preview.join("\n"), /Xiu> 已经修复/);
  assert.doesNotMatch(preview.join("\n"), /large index|raw tool output/);
});

test("structured replay preserves multiline terminal semantics", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-replay-"));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "replay.jsonl"), [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "task", task: "修复界面" }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "assistant", text: "中间说明", toolCalls: [{ id: "1", name: "read_file", input: {} }] }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "assistant", text: "第一行\n\n- 完整列表", toolCalls: [] }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:03.000Z", type: "ui_turn", version: 1, turn: {
      task: "修复界面", inputKind: "task", supplements: ["同时补测试"], response: "第一行\n\n- 完整列表", changes: [], receipts: ["  √ 验证通过"], completion: { message: "✓ 已完成", success: true }, exact: true,
    } }),
  ].join("\n") + "\n");
  const restored = await loadSession(cwd, "replay");
  assert.equal(restored.replay.length, 1);
  assert.equal(restored.replay[0]?.response, "第一行\n\n- 完整列表");
  assert.deepEqual(restored.replay[0]?.supplements, ["同时补测试"]);
  assert.equal(restored.replay[0]?.completion?.message, "✓ 已完成");
  assert.equal(restored.replay[0]?.exact, true);
});

test("legacy replay includes every task instead of only the latest twelve messages", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-legacy-replay-"));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const events: object[] = [];
  for (let index = 0; index < 15; index++) {
    events.push({ timestamp: new Date(index * 2_000).toISOString(), type: "task", task: `任务 ${index}` });
    events.push({ timestamp: new Date(index * 2_000 + 1_000).toISOString(), type: "assistant", text: `回答 ${index}\n第二行`, toolCalls: [] });
  }
  await fs.writeFile(path.join(directory, "legacy-all.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const restored = await loadSession(cwd, "legacy-all");
  assert.equal(restored.replay.length, 15);
  assert.equal(restored.replay[0]?.task, "任务 0");
  assert.equal(restored.replay[14]?.response, "回答 14\n第二行");
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
  const agent = new Agent({ config: tiny, provider, tools: [], approve: async () => true });
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
  const agent = new Agent({ config: { ...config(cwd), contextLimit: 300 }, provider, tools: [], approve: async () => true });
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
  const agent = new Agent({ config: config(cwd), provider, tools: [], approve: async () => true });
  agent.restoreSession({
    id: "chosen-session",
    file: path.join(cwd, ".xiu", "sessions", "chosen-session.jsonl"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: "restored-model",
    messages: [{ role: "user", content: "restored task context" }],
    stats: { modelCalls: 4, toolCalls: 7, inputTokens: 100, outputTokens: 20, estimatedTokens: 8, compactions: 1, activeMs: 5000 },
    replay: [],
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
  await new Agent({ config: { ...config(cwd), sessionNamespace: "agent-sessions" }, provider, tools: [], approve: async () => true }).run("internal task");
  assert.equal((await listSessions(cwd)).length, 0);
  const internal = await fs.readdir(path.join(cwd, ".xiu", "agent-sessions"));
  assert.equal(internal.length, 1);
});

test("a session whose task failed before its task event was logged is still listed under that task", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-session-title-"));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  // What a run that failed within milliseconds leaves behind: stats, a diagnostics snapshot and the turn record, no `task` event.
  await fs.writeFile(path.join(directory, "failed-early.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-19T21:19:17.074Z", type: "stats", stats: { modelCalls: 0 } }),
    JSON.stringify({ timestamp: "2026-10-19T21:19:17.077Z", type: "diagnostics", snapshot: { version: 1, task: "Say hello again", outcome: "failed" } }),
    JSON.stringify({ timestamp: "2026-10-19T21:19:17.082Z", type: "ui_turn", version: 1, turn: { task: "Say hello again", inputKind: "task", supplements: [] } }),
  ].join("\n") + "\n");
  await fs.writeFile(path.join(directory, "empty.jsonl"), `${JSON.stringify({ timestamp: "2026-10-19T21:19:18.000Z", type: "stats", stats: { modelCalls: 0 } })}\n`);
  const sessions = await listSessions(cwd);
  assert.deepEqual(sessions.map((session) => [session.id, session.firstTask]), [["empty", ""], ["failed-early", "Say hello again"]]);
  // The lists label an empty title in the interface language instead of printing "Untitled session" in Chinese.
  assert.equal(sessionTitle(sessions[0]!, "zh-CN"), "未命名会话");
  assert.equal(sessionTitle(sessions[0]!, "en-US"), "Untitled session");
  assert.equal(sessionTitle({ firstTask: "  fix\n the   build  " }, "zh-CN"), "fix the build");
  assert.equal(sessionTitle({ firstTask: "x".repeat(100) }, "en-US", 80), "x".repeat(80));
});

test("one unreadable session log no longer hides the others, and loading it names the reason", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-unreadable-session-"));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "good.jsonl"), `${JSON.stringify({ type: "task", task: "good task", timestamp: "2026-10-19T01:00:00.000Z" })}\n`);
  await fs.mkdir(path.join(directory, "broken.jsonl"));

  assert.deepEqual((await listSessions(cwd)).map((item) => item.id), ["good"]);
  const listing = await listSessionsWithIssues(cwd);
  assert.deepEqual(listing.unreadable, [{ id: "broken", reason: "EISDIR" }]);
  assert.equal(unreadableSessionsNote(listing.unreadable, "en-US"), "1 more session log(s) could not be read (EISDIR ×1) and are not listed.");
  assert.equal(unreadableSessionsNote(listing.unreadable, "zh-CN"), "另有 1 个会话日志无法读取（EISDIR ×1），未列出。");
  assert.equal(unreadableSessionsNote([], "en-US"), undefined);

  assert.equal((await loadSession(cwd)).id, "good", "the latest readable session still loads");
  await assert.rejects(loadSession(cwd, "broken"), (error: NodeJS.ErrnoException) => error.code === "EISDIR" && /^Session log cannot be read \(EISDIR\): broken$/.test(error.message));
  await assert.rejects(loadSession(cwd, "missing"), /Session not found in this workspace: missing/);

  await fs.rm(path.join(directory, "good.jsonl"));
  assert.deepEqual(await listSessions(cwd), []);
  await assert.rejects(loadSession(cwd, "broken"), /cannot be read \(EISDIR\)/, "an unreadable log is told apart from a workspace without sessions");
  await assert.rejects(loadSession(cwd), /No Xiu sessions exist in this workspace/);
});
