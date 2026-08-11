import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager, resolveStdioLaunch } from "../src/mcp.js";

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
    const resources = await manager.listResources("test");
    assert.deepEqual(resources.resources.map((resource) => resource.uri), ["test://greeting", "test://second"]);
    assert.deepEqual(resources.templates.map((template) => template.uriTemplate), ["test://docs/{id}"]);
    assert.equal(resources.truncated, false);
    const resource = await manager.readResource("test", "test://greeting");
    assert.match(resource.text, /resource:test:\/\/greeting/);
    assert.match(resource.text, /binary content omitted.*5 bytes/);
    assert.equal(resource.truncated, false);
    const largeResource = await manager.readResource("test", "test://large");
    assert.equal(largeResource.truncated, true);
    assert.ok(largeResource.text.length < 33_000);
    const prompts = await manager.listPrompts("test");
    assert.deepEqual(prompts.prompts, [{ name: "review", description: "Review code", arguments: [{ name: "target", required: true }] }]);
    const prompt = await manager.getPrompt("test", "review", { target: "src/mcp.ts" });
    assert.match(prompt.text, /review:src\/mcp\.ts/);
    await assert.rejects(manager.getPrompt("test", "review", { target: "x".repeat(20_001) }), /bounded|safety/i);
    await assert.rejects(manager.readResource("test", "x".repeat(8_193)), /8192/);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("stdio MCP resolves npx through Node on Windows instead of spawning the cmd shim", { skip: process.platform !== "win32" }, async () => {
  const args = ["--yes", "@modelcontextprotocol/server-everything"];
  const launch = await resolveStdioLaunch("npx", args);
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0]!, /node_modules[\\/]npm[\\/]bin[\\/]npx-cli\.js$/i);
  assert.deepEqual(launch.args.slice(1), args);
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
    if (message.method === "server/discover") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      }));
      return;
    }
    const toolMessage = message.params?.arguments && (message.params.arguments as Record<string, unknown>).message;
    if (message.method === "tools/call" && toolMessage === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "remote-test", version: "1.0.0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] }
        : message.method === "resources/list"
          ? { resources: [{ name: "Remote docs", uri: "remote://docs", mimeType: "text/plain" }] }
          : message.method === "resources/templates/list"
            ? { resourceTemplates: [] }
            : message.method === "resources/read"
              ? { contents: [{ uri: "remote://docs", mimeType: "text/plain", text: "remote docs" }] }
              : message.method === "prompts/list"
                ? { prompts: [{ name: "summarize", arguments: [] }] }
                : message.method === "prompts/get"
                  ? { messages: [{ role: "user", content: { type: "text", text: "summarize this" } }] }
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
    risk: "write",
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.deepEqual(await manager.start(false), [{ name: "remote", transport: "streamable-http", state: "connected", tools: 1 }]);
    const tool = manager.tools()[0]!;
    assert.equal(tool.name, "mcp__remote__echo");
    assert.equal(tool.risk, "write");
    assert.equal(tool.changesWorkspace, false);
    assert.equal(await tool.execute({ message: "hello" }, { cwd: workspace, approve: async () => true }), "remote:hello");
    assert.deepEqual((await manager.listResources("remote")).resources.map((item) => item.uri), ["remote://docs"]);
    assert.match((await manager.readResource("remote", "remote://docs")).text, /remote docs/);
    assert.deepEqual((await manager.listPrompts("remote")).prompts.map((item) => item.name), ["summarize"]);
    assert.match((await manager.getPrompt("remote", "summarize", {})).text, /summarize this/);
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
  assert.ok(requests.some((item) => item.method === "server/discover"));
  assert.ok(requests.some((item) => item.method === "initialize"));
});

test("MCP manager negotiates modern Streamable HTTP without initialize or sessions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-modern-http-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  const requests: Array<{ httpMethod?: string; method: string; session?: string; protocol?: string }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" || request.method === "DELETE") {
      requests.push({ httpMethod: request.method, method: request.method, session: request.headers["mcp-session-id"] as string | undefined });
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: Record<string, unknown> };
    requests.push({
      method: message.method,
      session: request.headers["mcp-session-id"] as string | undefined,
      protocol: request.headers["mcp-protocol-version"] as string | undefined,
    });
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "server/discover"
      ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : message.method === "tools/list"
        ? { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] }
        : { resultType: "complete", content: [{ type: "text", text: `modern:${String(message.params?.arguments && (message.params.arguments as Record<string, unknown>).message)}` }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { modern: {
    transport: "streamable-http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    risk: "read",
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.deepEqual(await manager.start(false), [{ name: "modern", transport: "streamable-http", state: "connected", tools: 1 }]);
    assert.equal(await manager.tools()[0]!.execute({ message: "hello" }, { cwd: workspace, approve: async () => true }), "modern:hello");
  } finally {
    await manager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  }
  assert.ok(requests.some((item) => item.method === "server/discover"));
  assert.ok(requests.some((item) => item.method === "tools/list" && item.protocol === "2026-07-28"));
  assert.ok(requests.every((item) => item.method !== "initialize"));
  assert.ok(requests.every((item) => item.session === undefined));
  assert.ok(requests.every((item) => item.httpMethod !== "DELETE"));
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
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { stdioOauth: { command: "node", auth: { type: "oauth" } } } }));
    await assert.rejects(manager.start(false), /OAuth.*streamable HTTP/i);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { oauthHeader: { url: "https://example.com/mcp", auth: { type: "oauth" }, headers: { Authorization: "Bearer token" } } } }));
    await assert.rejects(manager.start(false), /OAuth.*Authorization header/i);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { badScopes: { url: "https://example.com/mcp", auth: { type: "oauth", scopes: ["files:read write"] } } } }));
    await assert.rejects(manager.start(false), /scope/i);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { secret: { url: "https://example.com/mcp", auth: { type: "oauth", clientSecret: "must-not-be-accepted" } } } }));
    await assert.rejects(manager.start(false), /unsupported OAuth field clientSecret/i);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("OAuth MCP configuration is validated and remains auth-required until explicit login", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-oauth-config-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { secure: {
    transport: "streamable-http",
    url: "https://example.com/mcp",
    auth: {
      type: "oauth",
      registration: "pre-registered",
      clientId: "xiu-public-client",
      scopes: ["files:read"],
      callbackPort: 43119,
    },
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.deepEqual(await manager.start(false), [{
      name: "secure",
      transport: "streamable-http",
      state: "auth-required",
      tools: 0,
    }]);
    assert.equal(manager.tools().length, 0);
    assert.match(manager.summary(), /authentication required/i);
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

test("MCP permission expansion blocks connection until explicitly approved", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-permissions-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  const base = {
    command: process.execPath,
    args: [fixture],
    risk: "read",
    permissions: ["process:execute", "external:read"],
  };
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { guarded: base } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.equal((await manager.start(false))[0]?.state, "permission-required");
    assert.equal(manager.tools().length, 0);
    assert.match(manager.summary("zh-CN"), /需要确认权限清单/);
    assert.doesNotMatch(manager.summary("zh-CN"), /Additional permissions/i);
    await manager.approvePermissions("guarded", false);
    assert.equal((await manager.start(false))[0]?.state, "connected");
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { guarded: { ...base, args: [fixture, "--changed-command"] } } }));
    assert.equal((await manager.start(false))[0]?.state, "permission-required");
    assert.equal(manager.tools().length, 0);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { guarded: base } }));
    assert.equal((await manager.start(false))[0]?.state, "connected");
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { guarded: {
      ...base,
      risk: "write",
      permissions: ["process:execute", "external:read", "external:write"],
    } } }));
    assert.equal((await manager.start(false))[0]?.state, "permission-required");
    assert.equal(manager.tools().length, 0);
    const manifest = (await manager.permissionManifests(false))[0]!;
    assert.deepEqual(manifest.added, ["external:write"]);
    assert.equal(manifest.approved, false);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("MCP permission declaration cannot omit inferred capabilities", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-underdeclared-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { hidden: {
    command: process.execPath, args: [fixture], risk: "write", permissions: ["process:execute"],
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  await assert.rejects(manager.start(false), /omits required permissions.*external:write/i);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("stdio MCP decodes Windows local-codepage stderr into readable text", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-local-stderr-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { broken: {
    command: process.execPath, args: [fixture], env: { XIU_TEST_MCP_GBK_ERROR: "1" }, risk: "read",
  } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    const status = (await manager.start(false))[0]!;
    assert.equal(status.state, "failed");
    assert.match(status.error ?? "", /下载失败：网络不可用/);
    assert.doesNotMatch(status.error ?? "", /�/);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
