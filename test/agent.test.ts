import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, BackgroundApprovalRequiredError } from "../src/agent.js";
import { resolveConfig, type AgentConfig } from "../src/config.js";
import { loadSession } from "../src/session.js";
import { builtinTools } from "../src/tools.js";
import { TaskRunJournal } from "../src/task-run.js";
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

test("agent suppresses fabricated current facts when every web search fails", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-integrity-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return {
        text: "Searching for current sources.",
        toolCalls: [{ id: "search", name: "web_search", input: { query: "latest Claude news" } }],
        raw: {},
      };
      return { text: "Claude Opus 99 launched tomorrow.", toolCalls: [], raw: {} };
    },
  };
  const tool: AgentTool = {
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    describe: () => "search the web",
    execute: async () => "Tool error: Xiu Search device registration transport failed (ECONNRESET).",
  };
  const visible: string[] = [];
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 4, autoApprove: true, language: "en-US" },
    provider,
    [tool],
    async () => true,
    { onText: (text) => visible.push(text) },
  );

  const result = await agent.run("Search for the latest Claude news");
  assert.match(result, /Web search did not succeed/);
  assert.match(result, /ECONNRESET/);
  assert.doesNotMatch(result, /Opus 99/);
  assert.doesNotMatch(visible.join("\n"), /Opus 99/);
  assert.equal(agent.status().outcome, "failed");
  assert.equal(calls, 3);
});

test("agent stops immediately after a deterministic managed search authentication failure", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-auth-fatal-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls > 1) throw new Error("model must not be called again after deterministic search auth failure");
      return {
        text: "Searching.",
        toolCalls: [{ id: "search", name: "web_search", input: { query: "latest Claude news" } }],
        raw: {},
      };
    },
  };
  const tool: AgentTool = {
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    describe: () => "search the web",
    execute: async () => "Tool error: Xiu Search device registration failed with HTTP 403 (registration_not_allowed).",
  };
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true, language: "zh-CN" },
    provider,
    [tool],
    async () => true,
  );
  const result = await agent.run("搜索 Claude 最新信息");
  assert.match(result, /已停止自动重试/);
  assert.match(result, /registration_not_allowed/);
  assert.equal(calls, 1);
  assert.equal(agent.status().outcome, "failed");
});

test("agent requires opened source URLs before completing a current-information task", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-source-gate-"));
  let calls = 0;
  const source = "https://example.com/news/claude-update";
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return {
        text: "Searching.",
        toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude latest news" } }],
        raw: {},
      };
      if (calls === 2) return { text: `Latest update: ${source}`, toolCalls: [], raw: {} };
      if (calls === 3) return {
        text: "Opening the exact source.",
        toolCalls: [{ id: "open", name: "web_open", input: { url: source } }],
        raw: {},
      };
      return { text: `Verified update: ${source}`, toolCalls: [], raw: {} };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    describe: () => "search the web",
    execute: async () => `UNTRUSTED WEB CONTENT\n\nSearch query: Claude latest news\nResults (1):\n1. Claude update\nURL: ${source}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    describe: () => "open source",
    execute: async () => `UNTRUSTED WEB CONTENT\n\nURL: ${source}\nTitle: Claude update\nContent:\nPublished today.`,
  }];
  const visible: string[] = [];
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 6, autoApprove: true, language: "en-US" },
    provider,
    tools,
    async () => true,
    { onText: (text) => visible.push(text) },
  );

  const result = await agent.run("Find the latest Claude news");
  assert.equal(result, `Verified update: ${source}`);
  assert.equal(agent.status().outcome, "completed");
  assert.equal(calls, 4);
  assert.equal(visible.filter((text) => text.includes("Latest update:")).length, 0);
});

test("agent rejects current-information citations that were not opened after the evidence audit", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-source-reject-"));
  let calls = 0;
  const searched = "https://example.com/news/real";
  const invented = "https://example.com/news/invented";
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return {
        text: "Searching.",
        toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude this week" } }],
        raw: {},
      };
      return { text: `Claude launched a new model: ${invented}`, toolCalls: [], raw: {} };
    },
  };
  const tool: AgentTool = {
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    describe: () => "search the web",
    execute: async () => `UNTRUSTED WEB CONTENT\n\nSearch query: Claude this week\nResults (1):\n1. Real result\nURL: ${searched}`,
  };
  const visible: string[] = [];
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true, language: "zh-CN" },
    provider,
    [tool],
    async () => true,
    { onText: (text) => visible.push(text) },
  );

  const result = await agent.run("搜索 Claude 最近一周的消息");
  assert.match(result, /未完成来源与时效核验/);
  assert.match(result, /本次未成功打开的网址/);
  assert.doesNotMatch(result, /not successfully opened/);
  assert.doesNotMatch(visible.join("\n"), /launched a new model/);
  assert.equal(agent.status().outcome, "failed");
  assert.equal(calls, 3);
});

test("agent accepts an older explicitly dated opened source when the preferred recent range has too few results", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-date-range-"));
  let calls = 0;
  const source = "https://example.com/news/old-update";
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "Searching.", toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude past 1 day" } }], raw: {} };
      if (calls === 2) return { text: "Opening.", toolCalls: [{ id: "open", name: "web_open", input: { url: source } }], raw: {} };
      return { text: `1. Old update\nDate: 2000-01-01\nSource: ${source}`, toolCalls: [], raw: {} };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => `UNTRUSTED WEB CONTENT\nResults (1):\n1. Old update\nURL: ${source}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async () => `UNTRUSTED WEB CONTENT\nURL: ${source}\nTitle: Old update\nPublished: 2000-01-01`,
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true, language: "en-US" }, provider, tools, async () => true);

  const result = await agent.run("Find Claude news from the past 1 day and provide the date");
  assert.match(result, /Old update/);
  assert.match(result, /2000-01-01/);
  assert.equal(agent.status().outcome, "completed");
  assert.equal(calls, 3);
});

test("agent deterministically marks a cited result date unknown instead of asking the model to fill it", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-date-correct-"));
  let calls = 0;
  const source = "https://example.com/news/current-update";
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "Searching.", toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude past 1 day" } }], raw: {} };
      if (calls === 2) return { text: "Opening.", toolCalls: [{ id: "open", name: "web_open", input: { url: source } }], raw: {} };
      return { text: `Current update\nSource: ${source}`, toolCalls: [], raw: {} };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => `UNTRUSTED WEB CONTENT\nResults (1):\n1. Current update\nURL: ${source}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async () => `UNTRUSTED WEB CONTENT\nURL: ${source}\nCurrent update without publication metadata`,
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true, language: "en-US" }, provider, tools, async () => true);

  assert.equal(await agent.run("Find Claude news from the past 1 day and provide the date"), `Current update\nSource: ${source}\nDate: Unknown (the source did not provide a verifiable date)`);
  assert.equal(agent.status().outcome, "completed");
  assert.equal(calls, 3);
});

test("agent accepts markdown-formatted Chinese dates for every cited result", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-date-markdown-"));
  let calls = 0;
  const first = "https://example.com/news/one";
  const second = "https://example.org/news/two";
  const today = new Date();
  const currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const chineseDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "搜索", toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude 最近一周" } }], raw: {} };
      if (calls === 2) return {
        text: "打开来源",
        toolCalls: [
          { id: "open-one", name: "web_open", input: { url: first } },
          { id: "open-two", name: "web_open", input: { url: second } },
        ],
        raw: {},
      };
      return {
        text: [
          `1. 第一条\n**日期**：${chineseDate}\n原始链接：${first}`,
          `2. 第二条（${currentDate}）\n原始链接：${second}`,
        ].join("\n\n"),
        toolCalls: [],
        raw: {},
      };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => `UNTRUSTED WEB CONTENT\nResults (2):\nURL: ${first}\nURL: ${second}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async (input) => `UNTRUSTED WEB CONTENT\nURL: ${String(input.url)}\nPublished: ${currentDate}`,
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 4, autoApprove: true, language: "zh-CN" }, provider, tools, async () => true);

  const result = await agent.run("搜索 Claude 最近一周的消息，给出标题、日期和原始链接");
  assert.match(result, /\*\*日期\*\*/);
  assert.match(result, new RegExp(chineseDate));
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

test("agent bounds repeated failed web page opens", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-open-budget-"));
  let executions = 0;
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return {
        text: "Opening candidates.",
        toolCalls: Array.from({ length: 9 }, (_, index) => ({ id: `open-${index}`, name: "web_open", input: { url: `https://example.com/${index}` } })),
        raw: {},
      };
      return { text: "No accessible sources survived.", toolCalls: [], raw: {} };
    },
  };
  const tool: AgentTool = {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async () => { executions += 1; return "Tool error: Web request failed with HTTP 403."; },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true, language: "en-US" }, provider, [tool], async () => true);

  await agent.run("Open these pages");
  assert.equal(executions, 6);
  assert.equal(calls, 2);
  assert.equal(agent.status().outcome, "failed");
});

test("agent bounds repeated web discovery searches", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-search-budget-"));
  let executions = 0;
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return {
        text: "Searching several variants.",
        toolCalls: Array.from({ length: 6 }, (_, index) => ({ id: `search-${index}`, name: "web_search", input: { query: `Claude query ${index}` } })),
        raw: {},
      };
      return { text: "Discovery finished.", toolCalls: [], raw: {} };
    },
  };
  const tool: AgentTool = {
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => { executions += 1; return "UNTRUSTED WEB CONTENT\nResults (1):\nURL: https://example.com/result"; },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true, language: "en-US" }, provider, [tool], async () => true);

  assert.equal(await agent.run("Research several Claude topics"), "Discovery finished.");
  assert.equal(executions, 3);
  assert.equal(calls, 2);
});

test("agent permits one evidence-only final answer after the web page failure budget is exhausted", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-open-finalize-"));
  let calls = 0;
  let executions = 0;
  const source = "https://example.com/verified";
  const provider: ModelProvider = {
    async complete(_system, messages) {
      calls += 1;
      if (calls === 1) return { text: "Searching.", toolCalls: [{ id: "search", name: "web_search", input: { query: "latest Claude news" } }], raw: {} };
      if (calls === 2) return {
        text: "Opening candidates.",
        toolCalls: [
          { id: "open-ok", name: "web_open", input: { url: source } },
          ...Array.from({ length: 6 }, (_, index) => ({ id: `open-fail-${index}`, name: "web_open", input: { url: `https://unavailable.example/${index}` } })),
        ],
        raw: {},
      };
      const finalization = messages.at(-1)?.content ?? "";
      assert.match(finalization, /ALLOWED SUCCESSFULLY OPENED URLS/);
      assert.match(finalization, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(finalization, /https:\/\/unavailable\.example\/0/);
      return { text: `One verified result. Source: ${source}`, toolCalls: [], raw: {} };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => `UNTRUSTED WEB CONTENT\nResults (1):\nURL: ${source}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async (input) => {
      executions += 1;
      return input.url === source ? `UNTRUSTED WEB CONTENT\nCitation URL: ${source}\nCurrent news` : "Tool error: fetch failed";
    },
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 4, autoApprove: true, language: "en-US" }, provider, tools, async () => true);

  assert.equal(await agent.run("Find the latest Claude news"), `One verified result. Source: ${source}`);
  assert.equal(executions, 5);
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

test("agent prunes unsupported result blocks from the final web answer and keeps verified results", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-open-prune-"));
  let calls = 0;
  const verified = "https://example.com/verified";
  const unsupported = "https://unavailable.example/invented";
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "搜索", toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude 最新消息" } }], raw: {} };
      if (calls === 2) return {
        text: "打开候选来源",
        toolCalls: [
          { id: "open-ok", name: "web_open", input: { url: verified } },
          ...Array.from({ length: 4 }, (_, index) => ({ id: `open-fail-${index}`, name: "web_open", input: { url: `https://unavailable.example/${index}` } })),
        ],
        raw: {},
      };
      return {
        text: [
          "以下是核验后的结果：",
          "",
          `1. 已核验消息\n日期：2026-08-14\n摘要：来自已打开页面。\n原始链接：${verified}`,
          "",
          `2. 未核验消息\n日期：2026-08-14\n摘要：不应显示。\n原始链接：${unsupported}`,
        ].join("\n"),
        toolCalls: [],
        raw: {},
      };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => `UNTRUSTED WEB CONTENT\nResults (2):\nURL: ${verified}\nURL: ${unsupported}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async (input) => input.url === verified
      ? `UNTRUSTED WEB CONTENT\nURL: ${verified}\nPublished: 2026-08-14`
      : "Tool error: fetch failed",
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 4, autoApprove: true, language: "zh-CN" }, provider, tools, async () => true);

  const result = await agent.run("搜索 Claude 最新消息");
  assert.match(result, /已核验消息/);
  assert.match(result, new RegExp(verified.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result, /已移除未完成来源核验的候选条目/);
  assert.doesNotMatch(result, /未核验消息|不应显示|unavailable\.example/);
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

test("agent prunes unsupported result blocks before the web page failure budget is exhausted", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-open-partial-prune-"));
  let calls = 0;
  const verified = "https://example.com/verified";
  const unsupported = "https://unavailable.example/invented";
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "搜索", toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude 最新消息" } }], raw: {} };
      if (calls === 2) return {
        text: "打开候选来源",
        toolCalls: [
          { id: "open-ok", name: "web_open", input: { url: verified } },
          { id: "open-fail-1", name: "web_open", input: { url: unsupported } },
          { id: "open-fail-2", name: "web_open", input: { url: "https://unavailable.example/second" } },
        ],
        raw: {},
      };
      return {
        text: [
          "以下是核验后的结果：",
          "",
          `1. 已核验消息\n日期：2026-08-14\n摘要：来自已打开页面。\n原始链接：${verified}`,
          "",
          `2. 未核验消息\n日期：未知\n摘要：页面没有成功打开。\n原始链接：${unsupported}`,
        ].join("\n"),
        toolCalls: [],
        raw: {},
      };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => `UNTRUSTED WEB CONTENT\nResults (2):\nURL: ${verified}\nURL: ${unsupported}`,
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async (input) => input.url === verified
      ? `UNTRUSTED WEB CONTENT\nURL: ${verified}\nPublished: 2026-08-14`
      : "Tool error: fetch failed",
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 4, autoApprove: true, language: "zh-CN" }, provider, tools, async () => true);

  const result = await agent.run("搜索 Claude 最新消息");
  assert.match(result, /已核验消息/);
  assert.match(result, new RegExp(verified.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result, /已移除未完成来源核验的候选条目/);
  assert.doesNotMatch(result, /未核验消息|页面没有成功打开|unavailable\.example/);
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

test("agent localizes a source evidence failure after web finalization", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-web-open-localized-"));
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: "搜索", toolCalls: [{ id: "search", name: "web_search", input: { query: "Claude 最新消息" } }], raw: {} };
      if (calls === 2) return { text: "打开", toolCalls: Array.from({ length: 6 }, (_, index) => ({ id: `open-${index}`, name: "web_open", input: { url: `https://example.com/${index}` } })), raw: {} };
      return { text: "继续搜索", toolCalls: [{ id: "again", name: "web_search", input: { query: "再试一次" } }], raw: {} };
    },
  };
  const tools: AgentTool[] = [{
    name: "web_search", description: "search", risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, describe: () => "search",
    execute: async () => "UNTRUSTED WEB CONTENT\nResults (1):\nURL: https://example.com/0",
  }, {
    name: "web_open", description: "open", risk: "read",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, describe: () => "open",
    execute: async () => "Tool error: fetch failed",
  }];
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 4, autoApprove: true, language: "zh-CN" }, provider, tools, async () => true);

  const result = await agent.run("搜索 Claude 最新消息");
  assert.match(result, /网页来源多次打开失败|网页打开失败预算耗尽/);
  assert.doesNotMatch(result, /final answer cited|not successfully opened|requested more tools/);
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "failed");
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

test("detached agent pauses recoverably when a new approval is required", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-background-approval-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  let toolRan = false;
  const provider: ModelProvider = {
    async complete() {
      return { text: "About to write.", toolCalls: [{ id: "call", name: "side_effect", input: {} }], raw: {} };
    },
  };
  const tool: AgentTool = {
    name: "side_effect", description: "side effect", risk: "write", changesWorkspace: true,
    inputSchema: { type: "object", properties: {} }, describe: () => "write the result",
    execute: async () => { toolRan = true; return "done"; },
  };
  const journal = new TaskRunJournal(cwd, path.join(root, "task-runs"));
  const agent = new Agent(
    { provider: "openai", providerId: "openai", model: "test", cwd, autoApprove: false, backgroundMode: true },
    provider,
    [tool],
    async (request) => { throw new BackgroundApprovalRequiredError(request.description); },
    {}, undefined, undefined, undefined, undefined, undefined, journal,
  );

  await assert.rejects(() => agent.run("write in background"), /background task requires|后台任务需要/i);
  assert.equal(toolRan, false);
  assert.equal(agent.status().outcome, "paused");
  const interrupted = await new TaskRunJournal(cwd, path.join(root, "task-runs")).interrupted();
  assert.equal(interrupted?.status, "paused");
  assert.match(interrupted?.recoveryPoints.at(-1)?.evidence ?? "", /background approval required/);
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
