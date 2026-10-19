import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigFileError } from "./config-file-error.js";
import { normalizeLanguage, type UiLanguage } from "./i18n.js";
import type { WebSearchConfig, WebSearchProvider } from "./web-search.js";

export interface XiuSettings {
  language?: UiLanguage;
  webSearch?: WebSearchConfig;
  update?: {
    notifications: boolean;
  };
}

/** What `SettingsStore.inspect()` found: the settings to use and, when the file is damaged, why. */
export interface SettingsInspection {
  file: string;
  /** `read`: the file was parsed; `absent`: no file, defaults apply; `unreadable`: the file exists but cannot be used, defaults apply. */
  state: "read" | "absent" | "unreadable";
  settings: XiuSettings;
  /** The underlying error (a JSON syntax message or a system error code) when `state` is `unreadable`. */
  cause?: string;
  /** The full, actionable error `load()` throws when `state` is `unreadable`. */
  problem?: string;
}

export const XIU_BETA_SEARXNG_ENDPOINT = "https://search.jingran.vip";
export const XIU_BETA_SEARCH_AUTH_ENDPOINT = `${XIU_BETA_SEARXNG_ENDPOINT}/xiu-auth`;
export const XIU_BETA_SEARXNG_TOKEN_ENV = "XIU_BETA_SEARXNG_TOKEN";
const WEB_SEARCH_SCHEMA = 2;

function betaWebSearchConfig(environment: NodeJS.ProcessEnv): WebSearchConfig | undefined {
  const legacyToken = environment[XIU_BETA_SEARXNG_TOKEN_ENV]?.trim();
  const proxy = environment.XIU_WEB_PROXY?.trim();
  return {
    enabled: true,
    // Keyless local search first; the managed endpoint below is its fallback.
    provider: legacyToken ? "searxng" : "free-search",
    baseURL: XIU_BETA_SEARXNG_ENDPOINT,
    ...(legacyToken
      ? { apiKeyEnv: XIU_BETA_SEARXNG_TOKEN_ENV }
      : { managedAuth: "xiu-device" as const, authBaseURL: XIU_BETA_SEARCH_AUTH_ENDPOINT }),
    timeoutMs: 20_000,
    ...(proxy ? { proxy } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 100);
}

function webSearchConfig(value: unknown): WebSearchConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.provider !== "tavily" && input.provider !== "brave" && input.provider !== "searxng" && input.provider !== "free-search") return undefined;
  if (typeof input.baseURL !== "string") return undefined;
  let endpoint: URL;
  try { endpoint = new URL(input.baseURL); } catch { return undefined; }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return undefined;
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isInteger(input.timeoutMs) && input.timeoutMs >= 1_000 && input.timeoutMs <= 60_000
    ? input.timeoutMs : undefined;
  let proxy: string | undefined;
  if (typeof input.proxy === "string" && input.proxy.trim()) {
    try {
      const parsedProxy = new URL(input.proxy);
      if (parsedProxy.protocol === "http:" || parsedProxy.protocol === "https:") proxy = parsedProxy.toString();
    } catch { /* Ignore invalid persisted proxy values. */ }
  }
  const managedAuth = input.managedAuth === "xiu-device" ? "xiu-device" as const : undefined;
  let authBaseURL: string | undefined;
  if (managedAuth && typeof input.authBaseURL === "string") {
    try {
      const parsedAuth = new URL(input.authBaseURL);
      if (parsedAuth.protocol === "https:" && !parsedAuth.username && !parsedAuth.password) authBaseURL = parsedAuth.toString();
    } catch { /* Ignore invalid persisted auth endpoints. */ }
  }
  return {
    enabled: input.enabled === true,
    provider: input.provider as WebSearchProvider,
    baseURL: endpoint.toString(),
    ...(typeof input.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.apiKeyEnv) ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(stringArray(input.allowedDomains)?.length ? { allowedDomains: stringArray(input.allowedDomains) } : {}),
    ...(stringArray(input.blockedDomains)?.length ? { blockedDomains: stringArray(input.blockedDomains) } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(proxy ? { proxy } : {}),
    ...(managedAuth && authBaseURL ? { managedAuth, authBaseURL } : {}),
  };
}

export class SettingsStore {
  constructor(
    private readonly filename = path.join(os.homedir(), ".xiu", "settings.json"),
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  get file(): string { return this.filename; }

  /**
   * Loads the settings and fails closed on a damaged file: silently falling back to defaults could
   * switch web search or the language without the user noticing. `xiu doctor` uses `inspect()`
   * instead so it can still run and name the problem.
   */
  async load(): Promise<XiuSettings> {
    const inspection = await this.inspect();
    if (inspection.problem) throw new ConfigFileError("settings", inspection.file, inspection.problem);
    return inspection.settings;
  }

  /** Reads the settings file without throwing; a damaged file yields the defaults plus the cause. */
  async inspect(): Promise<SettingsInspection> {
    const defaults = (): XiuSettings => {
      const webSearch = betaWebSearchConfig(this.environment);
      return webSearch ? { webSearch } : {};
    };
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, "utf8")) as { language?: unknown; webSearch?: unknown; webSearchSchema?: unknown; update?: unknown };
      const webSearch = webSearchConfig(parsed.webSearch);
      const legacyBetaWithoutToken = webSearch?.enabled === true
        && webSearch.baseURL.replace(/\/$/, "") === XIU_BETA_SEARXNG_ENDPOINT
        && Boolean(webSearch.apiKeyEnv)
        && !this.environment[webSearch.apiKeyEnv!]?.trim();
      // Settings written before schema 2 persisted the managed preset without the user choosing it;
      // move that preset to local-first search once. Later saves record schema 2, so an explicit
      // choice of the managed service afterwards is kept.
      const managedPreset = webSearch?.provider === "searxng" && webSearch.managedAuth === "xiu-device"
        && webSearch.baseURL.replace(/\/$/, "") === XIU_BETA_SEARXNG_ENDPOINT;
      const upgradedPreset = parsed.webSearchSchema !== WEB_SEARCH_SCHEMA && managedPreset ? { ...webSearch, provider: "free-search" as const } : webSearch;
      const effectiveWebSearch = Object.prototype.hasOwnProperty.call(parsed, "webSearch")
        ? legacyBetaWithoutToken ? betaWebSearchConfig(this.environment) : upgradedPreset
        : betaWebSearchConfig(this.environment);
      const settings: XiuSettings = {
        ...(typeof parsed.language === "string" ? { language: normalizeLanguage(parsed.language) } : {}),
        ...(effectiveWebSearch ? { webSearch: effectiveWebSearch } : {}),
        ...(parsed.update && typeof parsed.update === "object" && (parsed.update as { notifications?: unknown }).notifications === true
          ? { update: { notifications: true } }
          : {}),
      };
      return { file: this.filename, state: "read", settings };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: this.filename, state: "absent", settings: defaults() };
      const code = (error as NodeJS.ErrnoException).code;
      const cause = typeof code === "string" && code ? code : error instanceof Error ? error.message : String(error);
      return {
        file: this.filename, state: "unreadable", settings: defaults(), cause,
        problem: `Could not read Xiu settings file ${this.filename}: ${cause}. Fix its JSON or move the file away; it holds the language and web-search settings. xiu doctor still runs and names the problem.`,
      };
    }
  }

  async save(settings: XiuSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    const persisted = {
      ...(settings.language ? { language: settings.language } : {}),
      // Persist explicit selections, including managed auth and domain controls.
      // Omitting the beta preset could resurrect an old environment-token mode.
      ...(settings.webSearch ? { webSearch: settings.webSearch, webSearchSchema: WEB_SEARCH_SCHEMA } : {}),
      ...(settings.update?.notifications ? { update: { notifications: true } } : {}),
    };
    await fs.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filename);
  }
}
