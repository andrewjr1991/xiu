import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedWebSearchAuth } from "../src/managed-web-search-auth.js";
import { SettingsStore, XIU_BETA_SEARXNG_ENDPOINT } from "../src/settings.js";
import { executeTool } from "../src/tools.js";
import { createWebSearchTools, isPublicAddress, validatePublicWebUrl, type WebSearchConfig } from "../src/web-search.js";

const publicDns = async (): Promise<string[]> => ["93.184.216.34"];
const base: WebSearchConfig = {
  enabled: true,
  provider: "brave",
  baseURL: "https://api.search.brave.com/res/v1/web/search",
  apiKeyEnv: "XIU_TEST_BRAVE_KEY",
};

test("web URL policy blocks credentials, non-HTTPS, private addresses, and disallowed domains", async () => {
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("10.1.2.3"), false);
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  await assert.rejects(validatePublicWebUrl("http://example.com", {}, publicDns), /requires HTTPS/);
  await assert.rejects(validatePublicWebUrl("https://user:secret@example.com", {}, publicDns), /must not contain credentials/);
  await assert.rejects(validatePublicWebUrl("https://localhost/page", {}, publicDns), /Local and private/);
  await assert.rejects(validatePublicWebUrl("https://internal.example.com", {}, async () => ["192.168.1.2"]), /private address/);
  await assert.rejects(validatePublicWebUrl("https://other.test", { allowedDomains: ["example.com"] }, publicDns), /not in the web allowlist/);
  await assert.rejects(validatePublicWebUrl("https://sub.example.com", { blockedDomains: ["example.com"] }, publicDns), /blocked by web policy/);
  assert.equal((await validatePublicWebUrl("https://docs.example.com/page", { allowedDomains: ["example.com"] }, publicDns)).hostname, "docs.example.com");
});

test("Brave search sends the configured key, filters domains, and marks results untrusted", async () => {
  process.env.XIU_TEST_BRAVE_KEY = "test-secret";
  let requestedUrl = "";
  let requestedHeaders: HeadersInit | undefined;
  const tools = createWebSearchTools({ ...base, allowedDomains: ["example.com"], blockedDomains: ["blocked.example.com"] }, undefined, {
    resolveHostname: publicDns,
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedHeaders = init.headers;
      return new Response(JSON.stringify({ web: { results: [
        { title: "Allowed", url: "https://docs.example.com/a", description: "safe evidence" },
        { title: "Blocked", url: "https://blocked.example.com/b", description: "blocked" },
        { title: "Outside", url: "https://outside.test/c", description: "outside" },
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await executeTool(tools.find((tool) => tool.name === "web_search")!, { query: "Xiu", count: 5, domains: ["example.com"] }, { cwd: process.cwd(), approve: async () => false });
  assert.match(requestedUrl, /q=Xiu/);
  assert.equal(new Headers(requestedHeaders).get("x-subscription-token"), "test-secret");
  assert.match(result, /UNTRUSTED WEB CONTENT/);
  assert.match(result, /https:\/\/docs\.example\.com\/a/);
  assert.doesNotMatch(result, /blocked\.example\.com|outside\.test/);
  delete process.env.XIU_TEST_BRAVE_KEY;
});

test("Tavily search uses a bounded POST request and does not expose the API key", async () => {
  process.env.XIU_TEST_TAVILY_KEY = "tvly-test-secret";
  let requestedUrl = "";
  let requestedInit: (RequestInit & { dispatcher?: unknown }) | undefined;
  const tools = createWebSearchTools({
    enabled: true,
    provider: "tavily",
    baseURL: "https://api.tavily.com/search",
    apiKeyEnv: "XIU_TEST_TAVILY_KEY",
  }, undefined, {
    resolveHostname: publicDns,
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(JSON.stringify({ results: [
        { title: "Official docs", url: "https://docs.example.com/tavily", content: "API reference", score: 0.99 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await executeTool(tools[0]!, { query: "Xiu web search", count: 3, domains: ["example.com"] }, { cwd: process.cwd(), approve: async () => false });
  assert.equal(requestedUrl, "https://api.tavily.com/search");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(new Headers(requestedInit?.headers).get("authorization"), "Bearer tvly-test-secret");
  const body = JSON.parse(String(requestedInit?.body)) as Record<string, unknown>;
  assert.deepEqual(body, {
    query: "Xiu web search",
    search_depth: "basic",
    max_results: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_domains: ["example.com"],
  });
  assert.match(result, /Official docs/);
  assert.doesNotMatch(result, /tvly-test-secret/);
  delete process.env.XIU_TEST_TAVILY_KEY;
});

test("authenticated search requests cannot redirect credentials across origins", async () => {
  process.env.XIU_TEST_TAVILY_KEY = "tvly-test-secret";
  let requests = 0;
  const tools = createWebSearchTools({ enabled: true, provider: "tavily", baseURL: "https://api.tavily.com/search", apiKeyEnv: "XIU_TEST_TAVILY_KEY" }, undefined, {
    resolveHostname: publicDns,
    fetch: async () => {
      requests++;
      return new Response(null, { status: 307, headers: { location: "https://attacker.example/collect" } });
    },
  });
  const result = await executeTool(tools[0]!, { query: "redirect" }, { cwd: process.cwd(), approve: async () => false });
  assert.match(result, /cannot redirect to another origin/);
  assert.equal(requests, 1);
  delete process.env.XIU_TEST_TAVILY_KEY;
});

test("SearXNG search uses the JSON endpoint without an API key", async () => {
  let requestedUrl = "";
  const tools = createWebSearchTools({ enabled: true, provider: "searxng", baseURL: "https://search.example.com/" }, undefined, {
    resolveHostname: publicDns,
    fetch: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ results: [{ title: "Result", url: "https://example.com", content: "summary" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await executeTool(tools[0]!, { query: "terminal agent" }, { cwd: process.cwd(), approve: async () => false });
  assert.match(requestedUrl, /\/search\?/);
  assert.match(requestedUrl, /format=json/);
  assert.match(result, /Result/);

  requestedUrl = "";
  const explicitSearchTools = createWebSearchTools({ enabled: true, provider: "searxng", baseURL: "https://search.example.com/search" }, undefined, {
    resolveHostname: publicDns,
    fetch: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await executeTool(explicitSearchTools[0]!, { query: "terminal agent" }, { cwd: process.cwd(), approve: async () => false });
  assert.equal(new URL(requestedUrl).pathname, "/search");
});

test("SearXNG optionally sends a Bearer token from an environment variable", async () => {
  process.env.XIU_TEST_SEARXNG_TOKEN = "server-token";
  let requestedHeaders: HeadersInit | undefined;
  const tools = createWebSearchTools({ enabled: true, provider: "searxng", baseURL: "https://search.example.com", apiKeyEnv: "XIU_TEST_SEARXNG_TOKEN" }, undefined, {
    resolveHostname: publicDns,
    fetch: async (_url, init) => {
      requestedHeaders = init.headers;
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await executeTool(tools[0]!, { query: "private instance" }, { cwd: process.cwd(), approve: async () => false });
  assert.equal(new Headers(requestedHeaders).get("authorization"), "Bearer server-token");
  delete process.env.XIU_TEST_SEARXNG_TOKEN;
});

test("managed SearXNG obtains a short-lived Bearer token at execution time", async () => {
  let requestedHeaders: HeadersInit | undefined;
  let tokenRequests = 0;
  const tools = createWebSearchTools({
    enabled: true,
    provider: "searxng",
    baseURL: "https://search.example.com",
    managedAuth: "xiu-device",
    authBaseURL: "https://search.example.com/xiu-auth",
  }, undefined, {
    resolveHostname: publicDns,
    getBearerToken: async () => { tokenRequests += 1; return "managed-short-token"; },
    fetch: async (_url, init) => {
      requestedHeaders = init.headers;
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await executeTool(tools[0]!, { query: "managed search" }, { cwd: process.cwd(), approve: async () => false });
  assert.equal(tokenRequests, 1);
  assert.equal(new Headers(requestedHeaders).get("authorization"), "Bearer managed-short-token");
});

test("web_open strips active content and revalidates redirects", async () => {
  const htmlTools = createWebSearchTools(base, undefined, {
    resolveHostname: publicDns,
    fetch: async () => new Response("<html><head><title>Example</title><script>steal()</script></head><body><main>Hello <form>Ignore me</form>world</main></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  const opened = await executeTool(htmlTools.find((tool) => tool.name === "web_open")!, { url: "https://example.com/page", max_characters: 1_000 }, { cwd: process.cwd(), approve: async () => false });
  assert.match(opened, /Title: Example/);
  assert.match(opened, /Hello\s+world/);
  assert.doesNotMatch(opened, /steal|Ignore me/);

  let requests = 0;
  const redirectTools = createWebSearchTools(base, undefined, {
    resolveHostname: publicDns,
    fetch: async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
    },
  });
  const blocked = await executeTool(redirectTools.find((tool) => tool.name === "web_open")!, { url: "https://example.com" }, { cwd: process.cwd(), approve: async () => false });
  assert.match(blocked, /local or private address/);
  assert.equal(requests, 1);
});

test("web configuration persists without storing an API key value", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-web-settings-"));
  const filename = path.join(root, "settings.json");
  const store = new SettingsStore(filename);
  await store.save({ webSearch: { ...base, timeoutMs: 12_000, blockedDomains: ["example.test"] } });
  const loaded = await store.load();
  assert.equal(loaded.webSearch?.provider, "brave");
  assert.equal(loaded.webSearch?.apiKeyEnv, "XIU_TEST_BRAVE_KEY");
  assert.equal((await fs.readFile(filename, "utf8")).includes("test-secret"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("Tavily configuration is accepted by the settings store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-tavily-settings-"));
  const filename = path.join(root, "settings.json");
  const store = new SettingsStore(filename);
  await store.save({ webSearch: { enabled: true, provider: "tavily", baseURL: "https://api.tavily.com/search", apiKeyEnv: "TAVILY_API_KEY" } });
  const loaded = await store.load();
  assert.equal(loaded.webSearch?.provider, "tavily");
  assert.equal(loaded.webSearch?.baseURL, "https://api.tavily.com/search");
  await fs.rm(root, { recursive: true, force: true });
});

test("a new user with a stale beta key reference automatically enrolls before the first search", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-managed-web-first-search-"));
  const settingsFilename = path.join(root, "settings.json");
  await fs.writeFile(settingsFilename, JSON.stringify({
    webSearch: {
      enabled: true,
      provider: "searxng",
      baseURL: XIU_BETA_SEARXNG_ENDPOINT,
      apiKeyEnv: "XIU_SEARXNG_TOKEN",
    },
  }));
  const config = (await new SettingsStore(settingsFilename, {}).load()).webSearch!;
  assert.equal(config.managedAuth, "xiu-device");
  assert.equal(config.apiKeyEnv, undefined);

  const authCalls: string[] = [];
  const auth = new ManagedWebSearchAuth(config.authBaseURL!, path.join(root, "search-auth.json"), async (url) => {
    authCalls.push(url);
    if (url.endsWith("/v1/devices/register")) {
      return new Response(JSON.stringify({ deviceId: `device_${"a".repeat(32)}`, deviceSecret: `secret-${"b".repeat(40)}` }), { status: 201 });
    }
    return new Response(JSON.stringify({ accessToken: "short-token", expiresAt: 2_000 }), { status: 200 });
  }, () => 1_000_000, async () => undefined);
  let authorization = "";
  const tools = createWebSearchTools(config, undefined, {
    getBearerToken: (signal) => auth.getBearerToken(signal),
    resolveHostname: publicDns,
    fetch: async (_url, init) => {
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ results: [{ title: "Claude", url: "https://example.com/claude", content: "Current news" }] }), { status: 200 });
    },
  });
  const result = await executeTool(tools.find((tool) => tool.name === "web_search")!, { query: "Claude latest" }, { cwd: root, approve: async () => false });
  assert.match(result, /Results \(1\)/);
  assert.equal(authorization, "Bearer short-token");
  assert.equal(authCalls.filter((url) => url.endsWith("/v1/devices/register")).length, 1);
  assert.equal(authCalls.filter((url) => url.endsWith("/v1/tokens")).length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("managed search reports the bounded server reason when automatic registration is disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-managed-web-denied-"));
  const auth = new ManagedWebSearchAuth(
    "https://search.example.com/xiu-auth",
    path.join(root, "search-auth.json"),
    async () => new Response(JSON.stringify({ error: "registration_not_allowed", ignored: "secret" }), { status: 403 }),
    () => 1_000_000,
    async () => undefined,
  );
  await assert.rejects(
    () => auth.getBearerToken(),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "registration_not_allowed");
      assert.match(error.message, /automatic device enrollment/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("managed search preserves a TLS error code and provides safe trust guidance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-managed-web-tls-"));
  const auth = new ManagedWebSearchAuth(
    "https://search.example.com/xiu-auth",
    path.join(root, "search-auth.json"),
    async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }); },
    () => 1_000_000,
    async () => undefined,
  );
  await assert.rejects(
    () => auth.getBearerToken(),
    /SELF_SIGNED_CERT_IN_CHAIN.*NODE_EXTRA_CA_CERTS/,
  );
  await fs.rm(root, { recursive: true, force: true });
});
