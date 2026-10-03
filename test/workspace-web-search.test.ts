import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedWebSearchAuth } from "../src/managed-web-search-auth.js";
import { createWorkspaceWebSearchTools } from "../src/runtime/workspace-web-search.js";
import { executeTool } from "../src/tools.js";
import type { WebSearchConfig } from "../src/web-search.js";

const config: WebSearchConfig = { enabled: true, provider: "searxng", baseURL: "https://search.example.test",
  managedAuth: "xiu-device", authBaseURL: "https://search.example.test/xiu-auth" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const publicDns = async () => ["93.184.216.34"];

test("desktop managed tools enroll lazily, reuse credentials and renew expiring short-lived tokens", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-search-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "search-auth.json");
  let now = 1_000_000;
  let registrations = 0; let tokens = 0; let searches = 0;
  const fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/v1/devices/register")) {
      registrations++;
      assert.equal(init.method, "POST");
      return json({ deviceId: `device_${"a".repeat(32)}`, deviceSecret: "inert-device-secret-".repeat(3) }, 201);
    }
    if (url.endsWith("/v1/tokens")) { tokens++; return json({ accessToken: `inert-short-token-${tokens}`, expiresAt: now / 1000 + 120 }); }
    searches++;
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer inert-short-token-${tokens}`);
    return json({ results: [{ title: "Offline fixture", url: "https://example.com/news", content: "Bounded source" }] });
  };
  const tools = createWorkspaceWebSearchTools(config, { fetch, resolveHostname: publicDns },
    (url, transport) => new ManagedWebSearchAuth(url, filename, transport, () => now, async () => undefined));
  assert.equal(registrations + tokens + searches, 0);
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
  const run = () => executeTool(tools.find((tool) => tool.name === "web_search")!, { query: "fixture" }, { cwd: root, approve: async () => false });
  for (let index = 0; index < 2; index++) {
    const output = await run();
    assert.match(output, /Offline fixture/);
    assert.doesNotMatch(output, /inert-short-token|inert-device-secret/);
  }
  assert.equal(registrations, 1); assert.equal(tokens, 1);
  now += 70_000;
  assert.match(await run(), /Offline fixture/);
  assert.equal(registrations, 1); assert.equal(tokens, 2);
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /inert-short-token/);
  // A rebuilt desktop host (or CLI) reuses the same device state, not a new enrollment.
  const next = createWorkspaceWebSearchTools(config, { fetch, resolveHostname: publicDns },
    (url, transport) => new ManagedWebSearchAuth(url, filename, transport, () => now, async () => undefined));
  assert.match(await executeTool(next[0]!, { query: "restart" }, { cwd: root, approve: async () => false }), /Offline fixture/);
  assert.equal(registrations, 1); assert.equal(tokens, 3);
});

test("desktop managed registration refusal is bounded, secret-free and never proceeds to search", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-search-refused-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const tools = createWorkspaceWebSearchTools(config, { resolveHostname: publicDns, fetch: async (url) => {
    calls.push(url); return json({ error: "registration_refused", secret: "inert-response-secret" }, 401);
  } }, (url, transport) => new ManagedWebSearchAuth(url, path.join(root, "state.json"), transport, Date.now, async () => undefined));
  const output = await executeTool(tools[0]!, { query: "fixture" }, { cwd: root, approve: async () => false });
  assert.match(output, /401/);
  assert.doesNotMatch(output, /inert-response-secret/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.endsWith("/v1/devices/register"));
});

test("desktop task cancellation aborts enrollment and does not issue a token or search", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-search-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "state.json");
  const controller = new AbortController();
  let requests = 0;
  const tools = createWorkspaceWebSearchTools(config, { resolveHostname: publicDns, fetch: async (url, init) => {
    requests++;
    assert.ok(url.endsWith("/v1/devices/register"));
    assert.ok(init.signal);
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("inert-secret-not-in-error")), { once: true });
      controller.abort();
    });
  } }, (url, transport) => new ManagedWebSearchAuth(url, filename, transport, Date.now, async () => undefined));
  const output = await executeTool(tools[0]!, { query: "cancel" }, { cwd: root, approve: async () => false, signal: controller.signal });
  assert.equal(requests, 1);
  assert.match(output, /transport failed|cancel|abort/i);
  assert.doesNotMatch(output, /inert-secret-not-in-error/);
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
});

test("custom and disabled search do not instantiate managed authentication", async (t) => {
  const fail = () => { throw new Error("Managed auth must not be constructed"); };
  assert.deepEqual(createWorkspaceWebSearchTools({ ...config, enabled: false }, {}, fail), []);
  assert.deepEqual(createWorkspaceWebSearchTools(undefined, {}, fail), []);
  const custom = { ...config, managedAuth: undefined, authBaseURL: undefined, apiKeyEnv: "XIU_OFFLINE_SEARCH_KEY" };
  const previous = process.env.XIU_OFFLINE_SEARCH_KEY;
  t.after(() => { if (previous === undefined) delete process.env.XIU_OFFLINE_SEARCH_KEY; else process.env.XIU_OFFLINE_SEARCH_KEY = previous; });
  process.env.XIU_OFFLINE_SEARCH_KEY = "inert-custom-key";
  let authorization: string | null = null;
  const tools = createWorkspaceWebSearchTools(custom, { resolveHostname: publicDns, fetch: async (_url, init) => {
    authorization = new Headers(init.headers).get("authorization");
    return json({ results: [] });
  } }, fail);
  const output = await executeTool(tools[0]!, { query: "custom" }, { cwd: os.tmpdir(), approve: async () => false });
  assert.equal(authorization, "Bearer inert-custom-key");
  assert.doesNotMatch(output, /Tool error|inert-custom-key/);
});
