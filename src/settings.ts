import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLanguage, type UiLanguage } from "./i18n.js";
import type { WebSearchConfig, WebSearchProvider } from "./web-search.js";

export interface XiuSettings {
  language?: UiLanguage;
  webSearch?: WebSearchConfig;
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
  return {
    enabled: input.enabled === true,
    provider: input.provider as WebSearchProvider,
    baseURL: endpoint.toString(),
    ...(typeof input.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.apiKeyEnv) ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(stringArray(input.allowedDomains)?.length ? { allowedDomains: stringArray(input.allowedDomains) } : {}),
    ...(stringArray(input.blockedDomains)?.length ? { blockedDomains: stringArray(input.blockedDomains) } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

export class SettingsStore {
  constructor(private readonly filename = path.join(os.homedir(), ".xiu", "settings.json")) {}

  async load(): Promise<XiuSettings> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, "utf8")) as { language?: unknown; webSearch?: unknown };
      const webSearch = webSearchConfig(parsed.webSearch);
      return {
        ...(typeof parsed.language === "string" ? { language: normalizeLanguage(parsed.language) } : {}),
        ...(webSearch ? { webSearch } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Could not read Xiu settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(settings: XiuSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filename);
  }
}
