import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FREE_SEARCH_CONSTRAINTS, FREE_SEARCH_VERSION, FreeSearchBackend, freeSearchLaunch, parseFreeSearchResponse, type FreeSearchClient, type FreeSearchLaunch } from "../src/free-search.js";
import { XIU_BETA_SEARCH_AUTH_ENDPOINT, XIU_BETA_SEARXNG_ENDPOINT } from "../src/settings.js";
import { executeTool } from "../src/tools.js";
import { createWebSearchTools, type WebSearchConfig } from "../src/web-search.js";

const publicDns = async (): Promise<string[]> => ["93.184.216.34"];
const localFirst: WebSearchConfig = {
  enabled: true,
  provider: "free-search",
  baseURL: XIU_BETA_SEARXNG_ENDPOINT,
  managedAuth: "xiu-device",
  authBaseURL: XIU_BETA_SEARCH_AUTH_ENDPOINT,
};
const context = { cwd: process.cwd(), approve: async () => false };

test("free-search launches a pinned package with only the search tool and none of Xiu's secrets", () => {
  const launch = freeSearchLaunch("/xiu-home", "http://127.0.0.1:8080/", {
    OPENAI_API_KEY: "sk-must-not-leak",
    SEARCH_MCP_DEFAULT_ENGINES: '["codex"]',
    HTTPS_PROXY: "http://corp:3128",
  });
  assert.equal(launch.command, "uvx");
  assert.ok(launch.args.includes(`free-search-mcp==${FREE_SEARCH_VERSION}`));
  assert.ok(launch.args.includes("--constraints"));
  assert.equal(launch.cwd, "/xiu-home");
  assert.equal(launch.env.SEARCH_MCP_TOOLS, "search");
  assert.equal(launch.env.SEARCH_MCP_DOWNLOAD_ENABLED, "false");
  assert.equal(launch.env.SEARCH_MCP_AGENT_BACKEND, "off");
  assert.equal(launch.env.SEARCH_MCP_CODEX_AUTO_SIGNIN, "false");
  assert.deepEqual(JSON.parse(launch.env.SEARCH_MCP_DEFAULT_ENGINES!), ["duckduckgo", "bing", "anysearch", "mojeek"]);
  assert.equal(launch.env.SEARCH_MCP_CONFIG_DIR, path.join("/xiu-home", "config"));
  assert.equal(launch.env.SEARCH_MCP_PROXY, "http://127.0.0.1:8080/");
  assert.equal(launch.env.HTTPS_PROXY, "http://corp:3128");
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
});

test("every free-search dependency is pinned to an exact version", () => {
  assert.ok(FREE_SEARCH_CONSTRAINTS.length > 50);
  for (const line of FREE_SEARCH_CONSTRAINTS) assert.match(line, /^[a-z0-9._-]+==[^\s;]+( ; .+)?$/i);
  assert.ok(FREE_SEARCH_CONSTRAINTS.some((line) => /^selectolax==0\./.test(line)), "selectolax 1.x breaks free-search-mcp 0.13.1");
  assert.ok(!FREE_SEARCH_CONSTRAINTS.some((line) => line.startsWith("free-search-mcp")));
});

test("free-search responses map to search results and name the engines that failed", () => {
  const parsed = parseFreeSearchResponse({
    results: [
      { title: "fastapi 0.143.0", url: "https://pypi.org/project/fastapi/0.143.0", snippet: "Latest release", published_age: "2026-10-08" },
      { title: "no url" },
      "junk",
    ],
    errors: { duckduckgo: "blocked", bing: "captcha", "bad name!": "x" },
  });
  assert.deepEqual(parsed.results, [{ title: "fastapi 0.143.0", url: "https://pypi.org/project/fastapi/0.143.0", snippet: "Latest release", published: "2026-10-08" }]);
  assert.deepEqual(parsed.failedEngines, ["duckduckgo", "bing"]);
  assert.throws(() => parseFreeSearchResponse(undefined), /unreadable/);
});

test("the backend writes its constraints, reuses one server and stops retrying when uv is missing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-free-search-"));
  const launches: FreeSearchLaunch[] = [];
  const calls: Record<string, unknown>[] = [];
  const working = new FreeSearchBackend({ home, connect: async (launch) => {
    launches.push(launch);
    return { search: async (args) => { calls.push(args); return { results: [] }; }, close: async () => undefined };
  } });
  await working.search({ query: "a", count: 3, timeoutMs: 5_000, includeDomains: ["example.com"] });
  await working.search({ query: "b", count: 3, timeoutMs: 5_000 });
  assert.equal(launches.length, 1);
  assert.equal(calls[0]!.format, "json");
  assert.deepEqual(calls[0]!.include_domains, ["example.com"]);
  assert.equal((await fs.readFile(launches[0]!.args[2]!, "utf8")).trim().split("\n").length, FREE_SEARCH_CONSTRAINTS.length);

  let attempts = 0;
  const missing = new FreeSearchBackend({ home, connect: async () => { attempts++; throw Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT" }); } });
  await assert.rejects(missing.search({ query: "a", count: 3, timeoutMs: 5_000 }), /uv is not installed/);
  await assert.rejects(missing.search({ query: "a", count: 3, timeoutMs: 5_000 }), /uv is not installed/);
  assert.equal(attempts, 1);
  await fs.rm(home, { recursive: true, force: true });
});

test("a slow first launch gives up on this search but keeps starting for the next one", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-free-search-slow-"));
  let release!: (client: FreeSearchClient) => void;
  const ready = new Promise<FreeSearchClient>((resolve) => { release = resolve; });
  let launches = 0;
  const backend = new FreeSearchBackend({ home, startupTimeoutMs: 20, connect: () => { launches++; return ready; } });
  await assert.rejects(backend.search({ query: "a", count: 3, timeoutMs: 5_000 }), /still starting/);
  release({ search: async () => ({ results: [{ title: "t", url: "https://example.com/", snippet: "s" }] }), close: async () => undefined });
  assert.equal((await backend.search({ query: "a", count: 3, timeoutMs: 5_000 })).results.length, 1);
  assert.equal(launches, 1);
  await fs.rm(home, { recursive: true, force: true });
});

test("web_search uses local free-search results and keeps Xiu's domain policy", async () => {
  let fetched = false;
  const tools = createWebSearchTools({ ...localFirst, blockedDomains: ["blocked.example.com"] }, undefined, {
    resolveHostname: publicDns,
    fetch: async () => { fetched = true; return new Response("{}"); },
    freeSearch: { search: async (request) => {
      assert.deepEqual(request.excludeDomains, ["blocked.example.com"]);
      return { results: [
        { title: "Kept", url: "https://docs.example.com/a?utm_source=x", snippet: "evidence", published: "2026-10-01" },
        { title: "Blocked", url: "https://blocked.example.com/b", snippet: "blocked" },
        { title: "Plain HTTP", url: "http://example.org/", snippet: "insecure" },
      ], failedEngines: ["duckduckgo"] };
    } },
  });
  const result = await executeTool(tools.find((tool) => tool.name === "web_search")!, { query: "Xiu" }, context);
  assert.equal(fetched, false);
  assert.match(result, /UNTRUSTED WEB CONTENT/);
  assert.match(result, /Citation URL: https:\/\/docs\.example\.com\/a\n/);
  assert.match(result, /Published: 2026-10-01/);
  assert.doesNotMatch(result, /blocked\.example\.com\/b|example\.org/);
  assert.match(result, /Search backend: local free-search; engines without results this time: duckduckgo/);
});

test("web_search falls back to managed Xiu Search when local search fails or finds nothing", async () => {
  for (const local of [
    async () => { throw new Error("uv is not installed"); },
    async () => ({ results: [], failedEngines: ["bing"] }),
  ]) {
    let requestedUrl = "";
    const tools = createWebSearchTools(localFirst, undefined, {
      resolveHostname: publicDns,
      getBearerToken: async () => "short-token",
      fetch: async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://example.com/f", content: "from searxng" }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      freeSearch: { search: local },
    });
    const result = await executeTool(tools.find((tool) => tool.name === "web_search")!, { query: "Xiu" }, context);
    assert.match(requestedUrl, /^https:\/\/search\.jingran\.vip\/search\?q=Xiu/);
    assert.match(result, /https:\/\/example\.com\/f/);
    assert.match(result, /Search backend: Xiu Search fallback/);
  }
});

test("web_search without a managed fallback reports the local failure", async () => {
  const { managedAuth: _managed, authBaseURL: _auth, ...withoutFallback } = localFirst;
  const tools = createWebSearchTools(withoutFallback, undefined, {
    resolveHostname: publicDns,
    fetch: async () => { throw new Error("must not fetch"); },
    freeSearch: { search: async () => { throw new Error("uv is not installed"); } },
  });
  const result = await executeTool(tools.find((tool) => tool.name === "web_search")!, { query: "Xiu" }, context);
  assert.match(result, /Web search failed: uv is not installed/);
});
