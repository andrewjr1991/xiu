import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpAuthStore } from "../src/mcp-auth-store.js";
import { loginMcpOAuth, XiuMcpOAuthProvider } from "../src/mcp-oauth.js";
import { McpManager } from "../src/mcp.js";

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  return (server.address() as { port: number }).port;
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("MCP OAuth completes discovery, DCR, PKCE callback, and token persistence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-oauth-"));
  const requests: Array<{ method: string; url: string; body: string }> = [];
  let origin = "";
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method ?? "", url: request.url ?? "", body });
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (request.url === "/.well-known/oauth-authorization-server") return send(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    if (request.url === "/register") return send(201, { ...JSON.parse(body), client_id: "dynamic-xiu-client", token_endpoint_auth_method: "none" });
    if (request.url === "/token") return send(200, { access_token: "oauth-access", refresh_token: "oauth-refresh", token_type: "Bearer", expires_in: 3600 });
    if (request.url === "/mcp" && request.method === "POST") {
      if (request.headers.authorization !== "Bearer oauth-access") return send(401, { error: "unauthorized" });
      const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { message?: string } } };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "server/discover"
        ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
        : message.method === "tools/list"
          ? { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] }
          : { resultType: "complete", content: [{ type: "text", text: `oauth:${message.params?.arguments?.message}` }] };
      return send(200, { jsonrpc: "2.0", id: message.id, result });
    }
    return send(404, { error: "not_found" });
  });
  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  const callbackPort = await availablePort();
  const store = new McpAuthStore(path.join(directory, "mcp-auth.json"));
  let browserUrl: URL | undefined;
  const interaction = {
    interactive: true,
    confirmAuthorizationServer: async () => true,
    openBrowser: async (url: URL) => {
      browserUrl = url;
      const callback = new URL(`http://127.0.0.1:${callbackPort}/oauth/callback`);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", origin);
      await fetch(callback);
    },
  };
  try {
    const provider = new XiuMcpOAuthProvider(`${origin}/mcp`, { type: "oauth", registration: "auto", callbackPort }, store, interaction);
    await loginMcpOAuth(provider, interaction);
    const records = await store.find(`${origin}/mcp`);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.issuer, `${origin}/`);
    assert.equal(records[0]?.clientId, "dynamic-xiu-client");
    assert.equal(records[0]?.tokens?.access_token, "oauth-access");
    assert.equal(browserUrl?.searchParams.get("code_challenge_method"), "S256");
    assert.equal(browserUrl?.searchParams.get("resource"), `${origin}/mcp`);
    assert.match(requests.find((item) => item.url === "/token")?.body ?? "", /resource=/);
    const globalConfig = path.join(directory, "mcp.json");
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { secure: { url: `${origin}/mcp`, auth: { type: "oauth", registration: "auto", callbackPort }, risk: "read" } } }));
    const manager = new McpManager(directory, globalConfig, store);
    try {
      assert.deepEqual(await manager.start(false), [{ name: "secure", transport: "streamable-http", state: "connected", tools: 1 }]);
      assert.equal(await manager.tools()[0]!.execute({ message: "hello" }, { cwd: directory, approve: async () => true }), "oauth:hello");
    } finally { await manager.close(); }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP OAuth callback state is exact and one-time", async () => {
  const provider = new XiuMcpOAuthProvider("https://mcp.example.com/mcp", { type: "oauth", clientId: "xiu" }, new McpAuthStore(path.join(os.tmpdir(), `missing-${Date.now()}.json`)));
  const state = provider.state();
  assert.throws(() => provider.validateCallback(new URL(`${provider.redirectUrl}?code=ok&state=wrong`)), /state/i);
  assert.equal(provider.validateCallback(new URL(`${provider.redirectUrl}?code=ok&state=${encodeURIComponent(state)}`)).code, "ok");
  assert.throws(() => provider.validateCallback(new URL(`${provider.redirectUrl}?code=again&state=${encodeURIComponent(state)}`)), /state/i);
});

test("MCP OAuth keeps login available when the system browser cannot be opened", async () => {
  let fallback: URL | undefined;
  const provider = new XiuMcpOAuthProvider(
    "https://mcp.example.com/mcp",
    { type: "oauth", clientId: "xiu" },
    new McpAuthStore(path.join(os.tmpdir(), `missing-${Date.now()}-browser.json`)),
    {
      interactive: true,
      confirmAuthorizationServer: async () => true,
      openBrowser: async () => { throw new Error("opener unavailable"); },
      authorizationUrlReady: (url, opened, error) => {
        assert.equal(opened, false);
        assert.match(error?.message ?? "", /opener unavailable/);
        fallback = url;
      },
    },
  );
  const authorizationUrl = new URL("http://127.0.0.1:53122/authorize?state=test");
  await provider.redirectToAuthorization(authorizationUrl);
  assert.equal(fallback?.toString(), authorizationUrl.toString());
});
