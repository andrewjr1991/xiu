import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";
import { MCP_SAMPLING_LIMITS, McpSamplingBroker, McpSamplingError, describeSamplingRequest, parseSamplingRequest } from "../src/mcp-sampling.js";
import type { ApprovalRequest, AssistantTurn, ConversationMessage, ModelProvider, ToolContext } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

interface FakeProviderCall { system: string; messages: ConversationMessage[]; tools: number }

function fakeProvider(answer: (call: FakeProviderCall, signal?: AbortSignal) => Promise<Partial<AssistantTurn>> | Partial<AssistantTurn>): ModelProvider & { calls: FakeProviderCall[] } {
  const calls: FakeProviderCall[] = [];
  return {
    calls,
    async complete(system, messages, tools, signal) {
      const call = { system, messages, tools: tools.length };
      calls.push(call);
      const turn = await answer(call, signal);
      return { text: "", toolCalls: [], raw: null, ...turn };
    },
  };
}

function model(provider: ModelProvider, name = "demo-model") {
  return { provider, providerId: "demo", providerLabel: "Demo", model: name };
}

function context(approve: ToolContext["approve"], signal?: AbortSignal): ToolContext {
  return { cwd: os.tmpdir(), approve, signal };
}

async function samplingError(promise: Promise<unknown>): Promise<McpSamplingError> {
  try { await promise; }
  catch (error) { if (error instanceof McpSamplingError) return error; throw error; }
  throw new Error("expected the sampling request to be refused");
}

test("sampling requests are parsed as bounded plain text and everything else is refused", async () => {
  const parsed = parseSamplingRequest({
    messages: [
      { role: "user", content: { type: "text", text: "hello" } },
      { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "text", text: "there" }] },
    ],
    systemPrompt: "Be brief.",
    maxTokens: 10.9,
    includeContext: "none",
    modelPreferences: { hints: [{ name: "any" }] },
  });
  assert.deepEqual(parsed, { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi\nthere" }], systemPrompt: "Be brief.", maxTokens: 10 });
  assert.equal(parseSamplingRequest({ messages: [{ role: "user", content: { type: "text", text: "x" } }], maxTokens: 10_000_000 }).maxTokens, MCP_SAMPLING_LIMITS.maxTokens);
  const refused = (params: unknown, pattern: RegExp) => {
    let error: unknown;
    try { parseSamplingRequest(params); } catch (thrown) { error = thrown; }
    assert.ok(error instanceof McpSamplingError && error.code === -32602, `expected -32602 for ${JSON.stringify(params)}`);
    assert.match(error.message, pattern);
  };
  const text = (value: string) => ({ role: "user", content: { type: "text", text: value } });
  refused(undefined, /params must be an object/);
  refused({ messages: [text("x")], maxTokens: 8, includeContext: "thisServer" }, /never shares its conversation context/);
  refused({ messages: [text("x")], maxTokens: 8, includeContext: "allServers" }, /never shares its conversation context/);
  refused({ messages: [text("x")], maxTokens: 8, tools: [] }, /does not run tools/);
  refused({ messages: [text("x")], maxTokens: 8, toolChoice: { mode: "auto" } }, /does not run tools/);
  refused({ messages: [], maxTokens: 8 }, /non-empty/);
  refused({ messages: [{ role: "user", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } }], maxTokens: 8 }, /text content only/);
  refused({ messages: [{ role: "system", content: { type: "text", text: "x" } }], maxTokens: 8 }, /role must be user or assistant/);
  refused({ messages: Array.from({ length: MCP_SAMPLING_LIMITS.messages + 1 }, () => text("x")), maxTokens: 8 }, /at most 32 messages/);
  refused({ messages: [text("x".repeat(MCP_SAMPLING_LIMITS.totalCharacters + 1))], maxTokens: 8 }, /exceed 64000 characters/);
  refused({ messages: [text("x")], maxTokens: 8, systemPrompt: "s".repeat(MCP_SAMPLING_LIMITS.systemCharacters + 1) }, /systemPrompt exceeds/);
  refused({ messages: [text("x")], maxTokens: 8, systemPrompt: 5 }, /systemPrompt must be a string/);
  refused({ messages: [text("x")] }, /maxTokens must be a positive number/);
  refused({ messages: [text("x")], maxTokens: 0 }, /maxTokens must be a positive number/);
});

test("the sampling approval is always a dangerous, per-server request that shows the prompt without the conversation", () => {
  const request = parseSamplingRequest({ messages: [{ role: "user", content: { type: "text", text: "p".repeat(2_500) } }], systemPrompt: "s".repeat(1_200), maxTokens: 200 });
  const approval = describeSamplingRequest("docs", model(fakeProvider(() => ({})), "gpt-x"), request);
  assert.equal(approval.risk, "dangerous");
  assert.equal(approval.sessionScope, "mcp-sampling:docs");
  assert.equal(approval.description, "answer a model sampling request from MCP server docs with Demo / gpt-x");
  assert.match(approval.preview ?? "", /^Server: docs\nModel: Demo \/ gpt-x \(billed to your key; up to 200 output tokens\)\nMessages: 1; the answer goes back to the server/);
  assert.match(approval.preview ?? "", /System prompt: s{1000}… \[200 more characters\]/);
  assert.match(approval.preview ?? "", /Last message \(user\): p{2000}… \[500 more characters\]/);
  assert.ok((approval.preview ?? "").length < 4_000);
});

test("the sampling broker serves only inside a tool call, after approval, with a bounded request count", async () => {
  const provider = fakeProvider(({ messages }) => ({ text: `answer:${messages[messages.length - 1]!.content}`, finishReason: "stop" }));
  const broker = new McpSamplingBroker("docs", () => model(provider));
  const params = { messages: [{ role: "user", content: { type: "text", text: "question" } }], systemPrompt: "Answer briefly.", maxTokens: 50 };

  const outside = await samplingError(broker.handle(params));
  assert.equal(outside.code, -32000);
  assert.match(outside.message, /only while one of its tool calls is in progress/);
  assert.equal(provider.calls.length, 0);

  const approvals: ApprovalRequest[] = [];
  const release = broker.begin(context(async (request) => { approvals.push(request); return true; }));
  assert.equal(broker.active(), 1);
  const result = await broker.handle(params);
  assert.deepEqual(result, { role: "assistant", content: { type: "text", text: "answer:question" }, model: "demo-model", stopReason: "endTurn" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.risk, "dangerous");
  assert.equal(provider.calls[0]?.tools, 0, "the server never gets Xiu's tools");
  assert.match(provider.calls[0]?.system ?? "", /^You are answering a request that an MCP server relayed through Xiu[\s\S]*\n\nAnswer briefly\.$/);
  assert.deepEqual(provider.calls[0]?.messages, [{ role: "user", content: "question" }]);

  const truncated = await broker.handle({ ...params, maxTokens: 1 });
  provider.calls.length = 0;
  assert.equal(truncated.stopReason, "endTurn");
  const long = fakeProvider(() => ({ text: "cut", finishReason: "length" }));
  const longBroker = new McpSamplingBroker("docs", () => model(long));
  const releaseLong = longBroker.begin(context(async () => true));
  assert.equal((await longBroker.handle(params)).stopReason, "maxTokens");
  releaseLong();

  // Two already served above; the cap is per tool call.
  for (let served = 2; served < MCP_SAMPLING_LIMITS.requestsPerCall; served += 1) await broker.handle(params);
  const capped = await samplingError(broker.handle(params));
  assert.equal(capped.code, -32000);
  assert.match(capped.message, /limit of 8 sampling requests for this tool call/);
  assert.equal(approvals.length, MCP_SAMPLING_LIMITS.requestsPerCall, "the capped request is refused before the user is asked");

  release();
  assert.equal(broker.active(), 0);
  assert.match((await samplingError(broker.handle(params))).message, /only while one of its tool calls is in progress/);

  // A fresh call starts a fresh budget, and an invalid request is refused before the approval prompt.
  const again = broker.begin(context(async () => true));
  assert.equal((await samplingError(broker.handle({ ...params, includeContext: "thisServer" }))).code, -32602);
  assert.equal((await broker.handle(params)).content.text, "answer:question");
  again();
});

test("declined, failed, cancelled and model-less sampling requests give the server fixed answers only", async () => {
  const params = { messages: [{ role: "user", content: { type: "text", text: "secret-prompt-canary" } }], maxTokens: 50 };

  const declinedProvider = fakeProvider(() => ({ text: "never" }));
  const declined = new McpSamplingBroker("docs", () => model(declinedProvider));
  const releaseDeclined = declined.begin(context(async () => false));
  const refusal = await samplingError(declined.handle(params));
  assert.equal(refusal.code, -32000);
  assert.equal(refusal.message, "The user declined the sampling request from MCP server docs.");
  assert.equal(declinedProvider.calls.length, 0, "a declined request never reaches the model");
  releaseDeclined();

  const failing = new McpSamplingBroker("docs", () => model(fakeProvider(() => { throw new Error("provider said: secret-prompt-canary sk-live-123"); })));
  const releaseFailing = failing.begin(context(async () => true));
  const failure = await samplingError(failing.handle(params));
  assert.equal(failure.code, -32000);
  assert.equal(failure.message, "The model request failed.");
  releaseFailing();

  const controller = new AbortController();
  const slow = new McpSamplingBroker("docs", () => model(fakeProvider((_call, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted with secret-prompt-canary")), { once: true });
  }))));
  let approvalShown!: () => void;
  const approvalSeen = new Promise<void>((resolve) => { approvalShown = resolve; });
  const releaseSlow = slow.begin(context(async () => { approvalShown(); return true; }, controller.signal));
  const pending = samplingError(slow.handle(params));
  await approvalSeen;
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.code, -32000);
  assert.equal(cancelled.message, "The sampling request was cancelled or timed out.");

  // Cancelled while the user was still looking at the prompt: the model is never called.
  const late = new AbortController();
  const lateProvider = fakeProvider(() => ({ text: "never" }));
  const lateBroker = new McpSamplingBroker("docs", () => model(lateProvider));
  const releaseLate = lateBroker.begin(context(async () => { late.abort(); return true; }, late.signal));
  assert.equal((await samplingError(lateBroker.handle(params))).message, "The sampling request was cancelled or timed out.");
  assert.equal(lateProvider.calls.length, 0, "a call cancelled during the prompt never reaches the model");
  releaseLate();

  // Already cancelled before the request arrives: no prompt at all.
  const gone = new AbortController();
  gone.abort();
  let prompted = 0;
  const goneBroker = new McpSamplingBroker("docs", () => model(fakeProvider(() => ({ text: "never" }))));
  const releaseGone = goneBroker.begin(context(async () => { prompted += 1; return true; }, gone.signal));
  assert.equal((await samplingError(goneBroker.handle(params))).message, "The sampling request was cancelled or timed out.");
  assert.equal(prompted, 0);
  releaseGone();
  releaseSlow();

  const noModel = new McpSamplingBroker("docs", () => undefined);
  let asked = 0;
  const releaseNoModel = noModel.begin(context(async () => { asked += 1; return true; }));
  const missing = await samplingError(noModel.handle(params));
  assert.equal(missing.code, -32000);
  assert.equal(missing.message, "No model is configured to answer sampling requests.");
  assert.equal(asked, 0);
  releaseNoModel();
});

async function stdioManager(options: { sampling?: boolean; env?: Record<string, string>; model?: boolean }) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-sampling-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { test: {
    command: process.execPath,
    args: [fixture],
    risk: "read",
    ...(options.sampling ? { sampling: true } : {}),
    ...(options.env ? { env: options.env } : {}),
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  const provider = fakeProvider(({ messages }) => ({ text: `answer:${messages[messages.length - 1]!.content}`, finishReason: "stop" }));
  if (options.model !== false) manager.setSamplingModel(() => model(provider, "fake-model"));
  const close = async () => { await manager.close(); await fs.rm(workspace, { recursive: true, force: true }); };
  return { manager, provider, workspace, close };
}

test("a stdio MCP server with sampling enabled is answered through the user's approval inside its tool call", async () => {
  const { manager, provider, workspace, close } = await stdioManager({ sampling: true });
  try {
    const [manifest] = await manager.permissionManifests(false);
    assert.ok(manifest?.permissions.includes("model:sampling"), "sampling is a declared permission the user approves once");
    assert.ok(manifest?.details?.includes("sampling:enabled"));
    await manager.approvePermissions("test", false);
    assert.deepEqual(await manager.start(false), [{ name: "test", transport: "stdio", state: "connected", tools: 3, sampling: true }]);
    assert.match(manager.summary(), /test: connected \(3 tools, sampling on request\)/);
    assert.match(manager.summary("zh-CN"), /test：已连接（3 个工具，可采样（每次需确认））/);
    const sample = manager.tools().find((tool) => tool.name === "mcp__test__sample")!;
    const approvals: ApprovalRequest[] = [];
    const approve = async (request: ApprovalRequest) => { approvals.push(request); return true; };
    assert.equal(await sample.execute({ prompt: "what is 2+2" }, { cwd: workspace, approve }), "sampled:answer:what is 2+2:fake-model:endTurn");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.risk, "dangerous");
    assert.equal(approvals[0]?.sessionScope, "mcp-sampling:test");
    assert.match(approvals[0]?.preview ?? "", /Server: test\nModel: Demo \/ fake-model/);
    assert.match(approvals[0]?.preview ?? "", /System prompt: Answer briefly\./);
    assert.deepEqual(provider.calls.map((call) => call.tools), [0]);

    assert.equal(await sample.execute({ prompt: "no" }, { cwd: workspace, approve: async () => false }), "sampled-error:-32000:The user declined the sampling request from MCP server test.".replace("sampled-error", "sampling-error"));
    assert.equal(provider.calls.length, 1, "a declined request never reaches the model");

    for (const variant of ["context", "image", "tools"]) {
      const answer = await sample.execute({ prompt: "x", variant }, { cwd: workspace, approve });
      assert.match(String(answer), /^sampling-error:-32602:Invalid sampling request: /, `${variant} must be refused as invalid`);
    }
    assert.equal(approvals.length, 1, "invalid requests are refused before the user is asked");

    const many = String(await sample.execute({ prompt: "n", count: MCP_SAMPLING_LIMITS.requestsPerCall + 1 }, { cwd: workspace, approve }));
    const answers = many.split("|");
    assert.equal(answers.length, MCP_SAMPLING_LIMITS.requestsPerCall + 1);
    assert.ok(answers.slice(0, MCP_SAMPLING_LIMITS.requestsPerCall).every((answer) => answer === "sampled:answer:n:fake-model:endTurn"));
    assert.match(answers[MCP_SAMPLING_LIMITS.requestsPerCall]!, /^sampling-error:-32000:MCP server test reached the limit of 8 sampling requests/);
    assert.equal(approvals.length, 1 + MCP_SAMPLING_LIMITS.requestsPerCall);
  } finally {
    await close();
  }
});

test("sampling requests outside a tool call, without a model, or from a server not opted in are refused", async () => {
  const early = await stdioManager({ sampling: true, env: { XIU_TEST_MCP_SAMPLE_EARLY: "1" } });
  try {
    await early.manager.approvePermissions("test", false);
    await early.manager.start(false);
    const sample = early.manager.tools().find((tool) => tool.name === "mcp__test__sample")!;
    let asked = 0;
    const answer = await sample.execute({ variant: "early" }, { cwd: early.workspace, approve: async () => { asked += 1; return true; } });
    assert.equal(answer, "sampling-error:-32000:Xiu serves sampling for MCP server test only while one of its tool calls is in progress.");
    assert.equal(asked, 0);
    assert.equal(early.provider.calls.length, 0);
  } finally {
    await early.close();
  }

  const noModel = await stdioManager({ sampling: true, model: false });
  try {
    await noModel.manager.approvePermissions("test", false);
    await noModel.manager.start(false);
    const sample = noModel.manager.tools().find((tool) => tool.name === "mcp__test__sample")!;
    assert.equal(await sample.execute({ prompt: "x" }, { cwd: noModel.workspace, approve: async () => true }), "sampling-error:-32000:No model is configured to answer sampling requests.");
  } finally {
    await noModel.close();
  }

  const plain = await stdioManager({});
  try {
    const [manifest] = await plain.manager.permissionManifests(false);
    assert.ok(!manifest?.permissions.includes("model:sampling"));
    await plain.manager.approvePermissions("test", false);
    assert.deepEqual(await plain.manager.start(false), [{ name: "test", transport: "stdio", state: "connected", tools: 3 }]);
    assert.doesNotMatch(plain.manager.summary(), /sampling/);
    const sample = plain.manager.tools().find((tool) => tool.name === "mcp__test__sample")!;
    let asked = 0;
    assert.equal(await sample.execute({ prompt: "x" }, { cwd: plain.workspace, approve: async () => { asked += 1; return true; } }), "sampling-error:-32601:Sampling is not enabled for this server in Xiu");
    assert.equal(asked, 0);
    assert.equal(plain.provider.calls.length, 0);
  } finally {
    await plain.close();
  }
});

test("a Streamable HTTP server's sampling request over SSE is served the same way", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-sampling-http-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  const seen: string[] = [];
  let samplingAnswer: unknown;
  let finishToolCall: (() => void) | undefined;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
    if (message.method === undefined) {
      // The client's answer to our sampling request.
      samplingAnswer = message;
      response.writeHead(202).end();
      finishToolCall?.();
      return;
    }
    seen.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === "tools/call") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "sampling/createMessage", params: {
        messages: [{ role: "user", content: { type: "text", text: "over http" } }], maxTokens: 20,
      } })}\n\n`);
      await new Promise<void>((resolve) => { finishToolCall = resolve; });
      const answer = samplingAnswer as { result?: { content?: { text?: string }; model?: string } };
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `sampled:${answer.result?.content?.text}:${answer.result?.model}` }] } })}\n\n`);
      response.end();
      return;
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remote-sampling", version: "1.0.0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "ask", description: "Ask the client model", inputSchema: { type: "object", properties: {} } }] }
        : {};
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { remote: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, risk: "read", sampling: true } } }));
  const manager = new McpManager(workspace, globalConfig);
  const provider = fakeProvider(({ messages }) => ({ text: `answer:${messages[0]!.content}`, finishReason: "stop" }));
  manager.setSamplingModel(() => model(provider, "fake-model"));
  try {
    await manager.approvePermissions("remote", false);
    assert.deepEqual(await manager.start(false), [{ name: "remote", transport: "streamable-http", state: "connected", tools: 1, sampling: true }]);
    const approvals: ApprovalRequest[] = [];
    const answer = await manager.tools()[0]!.execute({}, { cwd: workspace, approve: async (request) => { approvals.push(request); return true; } });
    assert.equal(answer, "sampled:answer:over http:fake-model");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.risk, "dangerous");
    assert.equal(approvals[0]?.sessionScope, "mcp-sampling:remote");
  } finally {
    await manager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
