import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpAuthStore } from "../src/mcp-auth-store.js";
import { loginMcpOAuth, logoutMcpOAuth, sanitizeOAuthError, waitForOAuthCallback, windowsBrowserOpenAttempts, XiuMcpOAuthProvider } from "../src/mcp-oauth.js";
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

test("Windows OAuth browser launch prefers the URL protocol handler over Explorer", () => {
  const url = new URL("https://auth.example.com/authorize?state=one&scope=read%20write");
  const attempts = windowsBrowserOpenAttempts(url, "C:\\Windows");
  assert.equal(attempts[0]?.[0], path.join("C:\\Windows", "System32", "rundll32.exe"));
  assert.deepEqual(attempts[0]?.[1], ["url.dll,FileProtocolHandler", url.toString()]);
  assert.equal(attempts[0]?.[2], true);
  assert.equal(attempts[1]?.[0], path.join("C:\\Windows", "explorer.exe"));
});

test("MCP OAuth refresh is single-flight, rotates credentials, and records absolute expiry", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-refresh-"));
  const store = new McpAuthStore(path.join(directory, "mcp-auth.json"));
  let origin = "";
  let refreshes = 0;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (request.url === "/.well-known/oauth-authorization-server") return send(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    if (request.url === "/token" && body.includes("grant_type=refresh_token")) {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return send(200, { access_token: "fresh-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 600, scope: "read" });
    }
    return send(404, {});
  });
  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  const identity = { resource: `${origin}/mcp`, issuer: `${origin}/`, clientId: "xiu-client" };
  try {
    await store.save({ ...identity, clientInformation: { client_id: identity.clientId, token_endpoint_auth_method: "none" }, tokens: { access_token: "expired", refresh_token: "old-refresh", token_type: "Bearer", issuer: identity.issuer, scope: "read" }, expiresAt: Date.now() - 1 });
    const provider = new XiuMcpOAuthProvider(`${origin}/mcp`, { type: "oauth", clientId: identity.clientId }, store);
    await Promise.all([provider.ensureFresh(), provider.ensureFresh(), provider.ensureFresh()]);
    const refreshed = await store.get(identity);
    assert.equal(refreshes, 1);
    assert.equal(refreshed?.tokens?.access_token, "fresh-access");
    assert.equal(refreshed?.tokens?.refresh_token, "rotated-refresh");
    assert.ok((refreshed?.expiresAt ?? 0) > Date.now());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP OAuth logout revokes refresh then access token and always clears local tokens", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-logout-"));
  const store = new McpAuthStore(path.join(directory, "mcp-auth.json"));
  const revoked: string[] = [];
  let origin = "";
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, revocation_endpoint: `${origin}/revoke`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    }
    if (request.url === "/revoke") {
      revoked.push(new URLSearchParams(body).get("token") ?? "");
      response.writeHead(200).end();
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  const identity = { resource: `${origin}/mcp`, issuer: `${origin}/`, clientId: "logout-client" };
  try {
    await store.save({ ...identity, clientInformation: { client_id: identity.clientId }, tokens: { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" } });
    const result = await logoutMcpOAuth(new XiuMcpOAuthProvider(`${origin}/mcp`, { type: "oauth", clientId: identity.clientId }, store));
    assert.deepEqual(revoked, ["refresh-secret", "access-secret"]);
    assert.equal(result.revoked, true);
    assert.equal((await store.get(identity))?.tokens, undefined);
    assert.equal((await store.get(identity))?.clientInformation?.client_id, identity.clientId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP OAuth cancellation closes the callback listener and errors are redacted", async () => {
  const port = await availablePort();
  const controller = new AbortController();
  const waiting = waitForOAuthCallback(new URL(`http://127.0.0.1:${port}/oauth/callback`), controller.signal, 10_000);
  controller.abort();
  await assert.rejects(waiting, /cancelled/i);
  const hidden = sanitizeOAuthError(new Error("Bearer abc123 https://x.test/?code=secret&access_token=topsecret"));
  assert.doesNotMatch(hidden.message, /abc123|secret|topsecret/);
  assert.match(hidden.message, /REDACTED/);
});

test("MCP OAuth cancellation aborts discovery instead of waiting for the network timeout", async () => {
  const callbackPort = await availablePort();
  const server = http.createServer(() => {});
  const port = await listen(server);
  const controller = new AbortController();
  const provider = new XiuMcpOAuthProvider(
    `http://127.0.0.1:${port}/mcp`,
    { type: "oauth", clientId: "cancel-client", callbackPort },
    new McpAuthStore(path.join(os.tmpdir(), `xiu-cancel-${Date.now()}.json`)),
    { interactive: true, signal: controller.signal, confirmAuthorizationServer: async () => true },
  );
  try {
    const started = Date.now();
    const login = loginMcpOAuth(provider, { interactive: true, signal: controller.signal, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(login, /abort|cancel/i);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP OAuth scope elevation requires approval and retries the rejected call once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-scope-"));
  const callbackPort = await availablePort();
  const store = new McpAuthStore(path.join(directory, "mcp-auth.json"));
  let origin = "";
  let tokenExchanges = 0;
  let toolCalls = 0;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (request.url === "/.well-known/oauth-authorization-server") return send(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    if (request.url === "/register") return send(201, { ...JSON.parse(body), client_id: "scope-client", token_endpoint_auth_method: "none" });
    if (request.url === "/token") {
      tokenExchanges += 1;
      return send(200, { access_token: tokenExchanges === 1 ? "basic-token" : "elevated-token", refresh_token: `refresh-${tokenExchanges}`, token_type: "Bearer", expires_in: 3600, scope: tokenExchanges === 1 ? "read" : "read write" });
    }
    if (request.url === "/mcp" && request.method === "POST") {
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) return void response.writeHead(202).end();
      if (message.method === "server/discover") return send(200, { jsonrpc: "2.0", id: message.id, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
      if (message.method === "tools/list") return send(200, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "write", inputSchema: { type: "object", properties: {} } }] } });
      toolCalls += 1;
      if (request.headers.authorization !== "Bearer elevated-token") return send(403, { error: "insufficient_scope" }, { "www-authenticate": `Bearer error="insufficient_scope", scope="write"` });
      return send(200, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", content: [{ type: "text", text: "elevated" }] } });
    }
    return send(404, {});
  });
  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  const interaction = {
    interactive: true,
    confirmAuthorizationServer: async () => true,
    openBrowser: async (url: URL) => {
      const callback = new URL(`http://127.0.0.1:${callbackPort}/oauth/callback`);
      callback.searchParams.set("code", `code-${tokenExchanges + 1}`);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", origin);
      await fetch(callback);
    },
  };
  const globalConfig = path.join(directory, "mcp.json");
  try {
    const authConfig = { type: "oauth" as const, registration: "auto" as const, callbackPort, scopes: ["read"] };
    await loginMcpOAuth(new XiuMcpOAuthProvider(`${origin}/mcp`, authConfig, store, interaction), interaction);
    await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { secure: { url: `${origin}/mcp`, auth: authConfig, risk: "execute" } } }));
    const manager = new McpManager(directory, globalConfig, store, interaction);
    try {
      await manager.start(false);
      let approvals = 0;
      const output = await manager.tools()[0]!.execute({}, { cwd: directory, approve: async () => { approvals += 1; return true; } });
      assert.equal(output, "elevated");
      assert.equal(approvals, 1);
      assert.equal(tokenExchanges, 2);
      assert.equal(toolCalls, 2);
    } finally { await manager.close(); }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
