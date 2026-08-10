import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

test("MCP manager discovers namespaced tools and calls a stdio server", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.mkdir(path.join(workspace, ".xiu"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".xiu", "mcp.json"), JSON.stringify({
    mcpServers: {
      test: {
        command: process.execPath,
        args: [fixture],
        risk: "read",
        toolRisks: { change: "write" },
        toolChangesWorkspace: { change: true },
      },
    },
  }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    const statuses = await manager.start();
    assert.deepEqual(statuses, [{ name: "test", transport: "stdio", state: "connected", tools: 2 }]);
    const tools = manager.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp__test__echo", "mcp__test__change"]);
    assert.equal(tools[0]?.risk, "read");
    assert.equal(tools[0]?.changesWorkspace, false);
    assert.equal(tools[1]?.risk, "write");
    assert.equal(tools[1]?.changesWorkspace, true);
    assert.equal(await tools[0]?.execute({ message: "hello" }, { cwd: workspace, approve: async () => true }), "echo:hello");
    const controller = new AbortController();
    const pending = tools[0]!.execute({ message: "slow" }, { cwd: workspace, approve: async () => true, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.match(manager.summary(), /test: connected \(2 tools\)/);
    assert.match(manager.summary("zh-CN"), /test：已连接（2 个工具）/);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("project MCP configuration overrides a global server and can disable it", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-config-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.mkdir(path.join(workspace, ".xiu"), { recursive: true });
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { shared: { command: process.execPath, args: [fixture] } } }));
  await fs.writeFile(path.join(workspace, ".xiu", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: process.execPath, enabled: false } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.deepEqual(await manager.start(), []);
    assert.equal(manager.tools().length, 0);
    assert.deepEqual(await manager.start(false), [{ name: "shared", transport: "stdio", state: "connected", tools: 2 }]);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("MCP manager connects to Streamable HTTP, preserves its session, and calls tools", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-http-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  const sessionId = "xiu-test-session";
  const requests: Array<{ method: string; session?: string; authorization?: string }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") {
      requests.push({ method: "DELETE", session: request.headers["mcp-session-id"] as string | undefined });
      response.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: Record<string, unknown> };
    requests.push({ method: message.method, session: request.headers["mcp-session-id"] as string | undefined, authorization: request.headers.authorization });
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const toolMessage = message.params?.arguments && (message.params.arguments as Record<string, unknown>).message;
    if (message.method === "tools/call" && toolMessage === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remote-test", version: "1.0.0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] }
        : { content: [{ type: "text", text: `remote:${String(message.params?.arguments && (message.params.arguments as Record<string, unknown>).message)}` }] };
    response.writeHead(200, {
      "content-type": "application/json",
      ...(message.method === "initialize" ? { "mcp-session-id": sessionId } : {}),
    }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.XIU_TEST_MCP_TOKEN = "secret-token";
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { remote: {
    transport: "streamable-http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { Authorization: "Bearer ${XIU_TEST_MCP_TOKEN}" },
    risk: "read",
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.deepEqual(await manager.start(false), [{ name: "remote", transport: "streamable-http", state: "connected", tools: 1 }]);
    const tool = manager.tools()[0]!;
    assert.equal(tool.name, "mcp__remote__echo");
    assert.equal(await tool.execute({ message: "hello" }, { cwd: workspace, approve: async () => true }), "remote:hello");
    const controller = new AbortController();
    const pending = tool.execute({ message: "slow" }, { cwd: workspace, approve: async () => true, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /abort|cancel/i);
    assert.ok(requests.some((item) => item.method === "tools/list" && item.session === sessionId));
    assert.ok(requests.some((item) => item.method === "tools/call" && item.authorization === "Bearer secret-token"));
    assert.doesNotMatch(manager.summary(), /secret-token/);
  } finally {
    await manager.close();
    delete process.env.XIU_TEST_MCP_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  }
  assert.ok(requests.some((item) => item.method === "DELETE" && item.session === sessionId));
});

test("MCP remote configuration rejects unsafe URLs and conflicting transports", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-invalid-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  const manager = new McpManager(workspace, globalConfig);
  try {
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { unsafe: { url: "http://example.com/mcp" } } }));
    await assert.rejects(manager.start(false), /HTTPS|localhost/i);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { conflict: { command: "node", url: "https://example.com/mcp" } } }));
    await assert.rejects(manager.start(false), /command.*url|exactly one/i);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { reserved: { url: "https://example.com/mcp", headers: { Accept: "text/plain" } } } }));
    await assert.rejects(manager.start(false), /reserved MCP header/i);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("user MCP add and remove update configuration atomically", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-manage-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  const manager = new McpManager(workspace, globalConfig);
  try {
    await manager.addUserHttpServer("docs", "https://example.com/mcp", "DOCS_MCP_TOKEN", "read");
    assert.deepEqual(await manager.userServerNames(), ["docs"]);
    const parsed = JSON.parse(await fs.readFile(globalConfig, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.equal(parsed.mcpServers.docs?.transport, "streamable-http");
    assert.equal(parsed.mcpServers.docs?.headers && (parsed.mcpServers.docs.headers as Record<string, string>).Authorization, "Bearer ${DOCS_MCP_TOKEN}");
    assert.equal(await manager.removeUserServer("docs"), true);
    assert.deepEqual(await manager.userServerNames(), []);
    assert.equal(await manager.removeUserServer("docs"), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
