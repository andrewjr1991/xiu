import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLanguage, type UiLanguage } from "./i18n.js";
import type { WebSearchConfig, WebSearchProvider } from "./web-search.js";

export interface XiuSettings {
  language?: UiLanguage;
  webSearch?: WebSearchConfig;
}

export const XIU_BETA_SEARXNG_ENDPOINT = "https://search.jingran.vip";
export const XIU_BETA_SEARCH_AUTH_ENDPOINT = `${XIU_BETA_SEARXNG_ENDPOINT}/xiu-auth`;
export const XIU_BETA_SEARXNG_TOKEN_ENV = "XIU_BETA_SEARXNG_TOKEN";

function betaWebSearchConfig(environment: NodeJS.ProcessEnv): WebSearchConfig | undefined {
  const legacyToken = environment[XIU_BETA_SEARXNG_TOKEN_ENV]?.trim();
  const proxy = environment.XIU_WEB_PROXY?.trim();
  return {
    enabled: true,
    provider: "searxng",
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
  if (input.provider !== "tavily" && input.provider !== "brave" && input.provider !== "searxng") return undefined;
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

  async load(): Promise<XiuSettings> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, "utf8")) as { language?: unknown; webSearch?: unknown };
      const webSearch = webSearchConfig(parsed.webSearch);
      const legacyBetaWithoutToken = webSearch?.enabled === true
        && webSearch.baseURL.replace(/\/$/, "") === XIU_BETA_SEARXNG_ENDPOINT
        && Boolean(webSearch.apiKeyEnv)
        && !this.environment[webSearch.apiKeyEnv!]?.trim();
      const effectiveWebSearch = Object.prototype.hasOwnProperty.call(parsed, "webSearch")
        ? legacyBetaWithoutToken ? betaWebSearchConfig(this.environment) : webSearch
        : betaWebSearchConfig(this.environment);
      return {
        ...(typeof parsed.language === "string" ? { language: normalizeLanguage(parsed.language) } : {}),
        ...(effectiveWebSearch ? { webSearch: effectiveWebSearch } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const webSearch = betaWebSearchConfig(this.environment);
        return webSearch ? { webSearch } : {};
      }
      throw new Error(`Could not read Xiu settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(settings: XiuSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    const implicitBetaSearch = settings.webSearch?.baseURL.replace(/\/$/, "") === XIU_BETA_SEARXNG_ENDPOINT
      && (settings.webSearch.managedAuth === "xiu-device" || settings.webSearch.apiKeyEnv === XIU_BETA_SEARXNG_TOKEN_ENV);
    const persisted = {
      ...(settings.language ? { language: settings.language } : {}),
      ...(!implicitBetaSearch && settings.webSearch ? { webSearch: settings.webSearch } : {}),
    };
    await fs.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filename);
  }
}
