import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { ensureManagedUv, uvExecutableName, type ManagedUvOptions } from "./uv-install.js";
import type { SearchResult } from "./web-search.js";

/**
 * Local, keyless search through free-search-mcp (MIT, https://github.com/sweetcornna/free-search-mcp).
 *
 * Xiu launches the pinned package with uvx (the desktop installer's bundled uv, else uv on PATH, else
 * Xiu's own pinned uv downloaded on first use; see uv-install.ts) and calls only its read-only `search` tool. The server's
 * fetch/download/research tools are not registered, its sign-in engines and agent backend stay off,
 * and it reads no configuration from the user's own free-search setup. Opening pages stays with
 * Xiu's web_open, so the HTTPS/DNS/redirect policy and the evidence gates are unchanged.
 */
export const FREE_SEARCH_VERSION = "0.13.1";

// Every transitive dependency is pinned. free-search-mcp 0.13.1 declares open ranges, and a fresh
// install of selectolax 1.x already breaks its startup, so an unpinned launch is not reproducible.
// Regenerate with `uv pip compile --universal --python-version 3.11` when FREE_SEARCH_VERSION changes.
export const FREE_SEARCH_CONSTRAINTS = [
  "aiosqlite==0.22.1",
  "annotated-doc==0.0.5",
  "annotated-types==0.8.0",
  "anyio==4.15.1",
  "attrs==26.1.0",
  "babel==2.18.0",
  "beautifulsoup4==4.15.0",
  "certifi==2026.7.22",
  "cffi==2.1.1",
  "charset-normalizer==3.5.2",
  "click==8.5.0",
  "colorama==0.4.6 ; sys_platform == 'win32'",
  "courlan==1.4.0",
  "cryptography==50.0.2",
  "curl-cffi==0.16.3",
  "dateparser==1.4.3",
  "ebooklib==0.20",
  "et-xmlfile==2.0.0",
  "extruct==0.18.0",
  "greenlet==3.5.6",
  "h11==0.16.0",
  "html-text==0.7.1",
  "html5lib==1.1",
  "htmldate==1.11.0",
  "httpcore==1.0.9",
  "httpcore2==2.13.1 ; sys_platform != 'emscripten'",
  "httpx==0.28.1",
  "httpx2==2.13.1",
  "httpx2-jsfetch==1.0 ; python_full_version >= '3.12' and sys_platform == 'emscripten'",
  "idna==3.20",
  "jsonschema==4.26.0",
  "jsonschema-specifications==2025.9.1",
  "jstyleson==0.0.2",
  "justext==3.0.2",
  "lxml==6.1.3",
  "lxml-html-clean==0.4.5",
  "markdown-it-py==4.2.0",
  "markdownify==1.2.3",
  "mcp==2.2.0",
  "mcp-types==2.2.0",
  "mdurl==0.1.2",
  "mf2py==2.0.2",
  "openpyxl==3.1.5",
  "opentelemetry-api==1.45.1",
  "pillow==12.3.0",
  "playwright==1.63.0",
  "pycparser==3.11 ; implementation_name != 'PyPy'",
  "pydantic==2.14.1",
  "pydantic-core==2.50.1",
  "pydantic-settings==2.15.0",
  "pyee==13.0.1",
  "pygments==2.21.0",
  "pyjwt==2.15.1",
  "pyparsing==3.3.3",
  "pypdf==6.20.1",
  "pyrdfa3==3.6.5",
  "python-dateutil==2.9.0.post0",
  "python-docx==1.2.0",
  "python-dotenv==1.2.4",
  "python-multipart==0.0.32",
  "python-pptx==1.0.2",
  "pytz==2026.5",
  "pywin32==312 ; sys_platform == 'win32'",
  "rapidfuzz==3.14.6",
  "rdflib==7.6.0",
  "referencing==0.37.0",
  "regex==2026.9.29",
  "requests==2.34.2",
  "rich==15.0.0",
  "rpds-py==2026.9.1",
  "selectolax==0.4.13",
  "shellingham==1.5.4",
  "six==1.17.0",
  "socksio==1.0.0",
  "soupsieve==2.10 ; python_full_version < '3.11.5'",
  "soupsieve==3.0.3 ; python_full_version >= '3.11.5'",
  "sse-starlette==3.5.0",
  "starlette==1.8.0",
  "tld==0.13.2",
  "trafilatura==2.3.1",
  "truststore==0.10.5 ; sys_platform != 'emscripten'",
  "typer==0.27.3",
  "typing-extensions==4.16.0",
  "typing-inspection==0.4.4",
  "tzdata==2026.5 ; sys_platform == 'win32'",
  "tzlocal==5.4.4",
  "urllib3==2.8.0",
  "uvicorn==0.54.0",
  "w3lib==2.5.0",
  "webencodings==0.6.1",
  "xlsxwriter==3.2.9",
];

const DEFAULT_ENGINES = ["duckduckgo", "bing", "anysearch", "mojeek"];
const STARTUP_TIMEOUT_MS = 180_000;
const PASSTHROUGH_ENVIRONMENT = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "UV_CACHE_DIR", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_PYTHON_INSTALL_MIRROR", "SSL_CERT_FILE"];

export interface FreeSearchLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface FreeSearchClient {
  search(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface FreeSearchOptions {
  proxy?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  connect?: (launch: FreeSearchLaunch) => Promise<FreeSearchClient>;
  /** Supplies Xiu's pinned uvx when none is on PATH. */
  ensureUv?: (options: ManagedUvOptions) => Promise<string>;
}

let bundledUvx: string | undefined;

/** The desktop app calls this with its installer's uv directory; that uv is then always used. */
export function useBundledUv(directory: string | undefined): boolean {
  const candidate = directory && path.join(directory, uvExecutableName("uvx"));
  bundledUvx = candidate && existsSync(candidate) ? candidate : undefined;
  return Boolean(bundledUvx);
}

export interface FreeSearchRequest {
  query: string;
  count: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface FreeSearchResponse {
  results: SearchResult[];
  failedEngines: string[];
}

export function freeSearchHome(): string {
  return path.join(os.homedir(), ".xiu", "free-search");
}

export function freeSearchLaunch(home: string, proxy: string | undefined, environment: NodeJS.ProcessEnv = process.env): FreeSearchLaunch {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENVIRONMENT) if (environment[name]) env[name] = environment[name]!;
  Object.assign(env, {
    SEARCH_MCP_CONFIG_DIR: path.join(home, "config"),
    SEARCH_MCP_CACHE_DIR: path.join(home, "cache"),
    SEARCH_MCP_TOOLS: "search",
    SEARCH_MCP_DOWNLOAD_ENABLED: "false",
    SEARCH_MCP_AGENT_BACKEND: "off",
    SEARCH_MCP_CODEX_AUTO_SIGNIN: "false",
    SEARCH_MCP_DEFAULT_ENGINES: JSON.stringify(DEFAULT_ENGINES),
    ...(proxy ? { SEARCH_MCP_PROXY: proxy } : {}),
  });
  return {
    command: bundledUvx ?? "uvx",
    args: ["--quiet", "--constraints", path.join(home, `constraints-${FREE_SEARCH_VERSION}.txt`), "--from", `free-search-mcp==${FREE_SEARCH_VERSION}`, "free-search-mcp"],
    // free-search also reads ./.env; an Xiu-owned working directory keeps a project's file out of it.
    cwd: home,
    env,
  };
}

async function connectStdio(launch: FreeSearchLaunch): Promise<FreeSearchClient> {
  // The SDK adds only its minimal default environment (PATH, HOME and similar) to `env`,
  // so provider keys and other secrets in Xiu's environment never reach the server.
  // The MCP client is loaded on the first search, not when Xiu starts.
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import("@modelcontextprotocol/client"), import("@modelcontextprotocol/client/stdio")]);
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env, stderr: "ignore" });
  const client = new Client({ name: "xiu", version: FREE_SEARCH_VERSION });
  await client.connect(transport);
  // An idle server must not keep Xiu (or a test run) alive. While a search is pending, its
  // deadline timer keeps the event loop running. The SDK does not expose the child publicly.
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  child?.unref();
  for (const stream of [child?.stdin, child?.stdout]) (stream as unknown as { unref?: () => void } | null | undefined)?.unref?.();
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  if (!tools.includes("search")) {
    await client.close();
    throw new Error("free-search-mcp did not offer its search tool.");
  }
  return {
    async search(args, signal) {
      const result = await client.callTool({ name: "search", arguments: args }, { signal });
      if (result.isError) {
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content.map((item) => (item as { text?: unknown }).text).filter((value) => typeof value === "string").join(" ");
        throw new Error(`free-search-mcp search failed: ${text.slice(0, 300) || "unknown error"}`);
      }
      if (result.structuredContent) return result.structuredContent;
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map((item) => (item as { text?: unknown }).text).find((value) => typeof value === "string");
      return text ? JSON.parse(text) : undefined;
    },
    close: () => client.close(),
  };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    const abort = () => reject(signal?.reason ?? Object.assign(new Error("Web request cancelled."), { name: "AbortError" }));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
  });
}

export function parseFreeSearchResponse(value: unknown): FreeSearchResponse {
  if (!value || typeof value !== "object") throw new Error("free-search-mcp returned an unreadable response.");
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record.results) ? record.results : [];
  const results = raw.flatMap((item): SearchResult[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.url !== "string") return [];
    return [{
      title: typeof entry.title === "string" ? entry.title : "",
      url: entry.url,
      snippet: typeof entry.snippet === "string" ? entry.snippet : "",
      ...(typeof entry.published_age === "string" && entry.published_age ? { published: entry.published_age } : {}),
    }];
  });
  const errors = record.errors && typeof record.errors === "object" ? Object.keys(record.errors as object) : [];
  return { results, failedEngines: errors.filter((name) => /^[a-z0-9_-]{1,40}$/i.test(name)).slice(0, 20) };
}

/** One lazily started server per proxy setting, shared by every agent in this process. */
export class FreeSearchBackend {
  private client?: Promise<FreeSearchClient>;
  private failure?: Error;

  constructor(private readonly options: FreeSearchOptions = {}) {}

  private start(): Promise<FreeSearchClient> {
    if (this.failure) return Promise.reject(this.failure);
    this.client ??= (async () => {
      const home = this.options.home ?? freeSearchHome();
      await fs.mkdir(path.join(home, "config"), { recursive: true });
      const launch = freeSearchLaunch(home, this.options.proxy, this.options.environment);
      await fs.writeFile(launch.args[2]!, `${FREE_SEARCH_CONSTRAINTS.join("\n")}\n`, "utf8");
      const connect = this.options.connect ?? connectStdio;
      try {
        return await connect(launch);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || launch.command !== "uvx") throw error;
      }
      // No uv on PATH: use Xiu's pinned copy, downloaded and verified on first use.
      let uvx: string;
      try {
        uvx = await (this.options.ensureUv ?? ensureManagedUv)({ ...(this.options.proxy ? { proxy: this.options.proxy } : {}) });
      } catch (error) {
        throw new Error(`uv is not installed and Xiu could not set up its own copy: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      return connect({ ...launch, command: uvx });
    })().catch((error: unknown) => {
      // A broken uv or install will not fix itself mid-session; fail fast after the first attempt.
      this.failure = error instanceof Error && error.message.startsWith("uv is not installed")
        ? error
        : new Error(`free-search-mcp could not start: ${error instanceof Error ? error.message : String(error)}`);
      this.client = undefined;
      throw this.failure;
    });
    return this.client;
  }

  async search(request: FreeSearchRequest): Promise<FreeSearchResponse> {
    // The first launch may download Python packages. It keeps running in the background when one
    // search gives up waiting, so a later search can use the server once it is ready.
    const starting = this.start();
    starting.catch(() => undefined);
    const client = await withDeadline(starting, Math.min(request.timeoutMs, this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS),
      "free-search-mcp is still starting (the first launch downloads its packages).", request.signal);
    const response = await withDeadline(client.search({
      query: request.query,
      max_results: Math.min(10, Math.max(request.count * 2, request.count)),
      format: "json",
      ...(request.includeDomains?.length ? { include_domains: request.includeDomains } : {}),
      ...(request.excludeDomains?.length ? { exclude_domains: request.excludeDomains } : {}),
    }, request.signal), request.timeoutMs, `free-search-mcp search timed out after ${request.timeoutMs}ms.`, request.signal);
    return parseFreeSearchResponse(response);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.then((value) => value.close(), () => undefined);
  }
}

const shared = new Map<string, FreeSearchBackend>();

export function sharedFreeSearchBackend(proxy: string | undefined): FreeSearchBackend {
  const key = proxy ?? "";
  let backend = shared.get(key);
  if (!backend) {
    backend = new FreeSearchBackend({ ...(proxy ? { proxy } : {}) });
    shared.set(key, backend);
  }
  return backend;
}

export async function closeFreeSearchBackends(): Promise<void> {
  const backends = [...shared.values()];
  shared.clear();
  await Promise.all(backends.map((backend) => backend.close()));
}
