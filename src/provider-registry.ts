import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderName } from "./config.js";

export interface ProviderFeatures {
  text: true;
  tools: boolean;
  vision: boolean;
  image: boolean;
  video: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderName;
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  /** Plaintext local credential. Never copy this value into project sessions or terminal output. */
  apiKey?: string;
  proxy?: string;
  contextWindow?: number;
  features: ProviderFeatures;
  builtin?: boolean;
}

interface ProviderFile {
  version: 1;
  active?: string;
  profiles: ProviderProfile[];
  credentials?: Record<string, string>;
}

const textAndTools = (): ProviderFeatures => ({ text: true, tools: true, vision: false, image: false, video: false });

export const BUILTIN_PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: "agnes", name: "Agnes", kind: "agnes", model: "agnes-2.5-flash",
    baseURL: "https://apihub.agnes-ai.com/v1", apiKeyEnv: "AGNES_API_KEY",
    features: { text: true, tools: true, vision: true, image: true, video: true }, builtin: true,
  },
  {
    id: "openai", name: "OpenAI", kind: "openai", model: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
    features: { text: true, tools: true, vision: true, image: false, video: false }, builtin: true,
  },
  {
    id: "anthropic", name: "Anthropic", kind: "anthropic", model: "claude-sonnet-4-20250514",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    features: { text: true, tools: true, vision: true, image: false, video: false }, builtin: true,
  },
  {
    id: "ollama", name: "Ollama (local)", kind: "ollama", model: "local-model",
    baseURL: "http://127.0.0.1:11434/v1", features: textAndTools(), builtin: true,
  },
  {
    id: "lmstudio", name: "LM Studio (local)", kind: "lmstudio", model: "local-model",
    baseURL: "http://127.0.0.1:1234/v1", features: textAndTools(), builtin: true,
  },
  {
    id: "vllm", name: "vLLM (local)", kind: "vllm", model: "local-model",
    baseURL: "http://127.0.0.1:8000/v1", features: textAndTools(), builtin: true,
  },
];

const ALLOWED_KINDS = new Set<ProviderName>(["openai", "anthropic", "agnes", "openai-compatible", "ollama", "lmstudio", "vllm"]);
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);

function validateURL(value: string | undefined, label: string): void {
  if (!value) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must use http:// or https://`);
}

export function validateProviderProfile(profile: ProviderProfile): ProviderProfile {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(profile.id) || RESERVED_IDS.has(profile.id.toLowerCase())) {
    throw new Error("Provider id must be 1-63 letters, numbers, dots, underscores, or hyphens");
  }
  if (!profile.name.trim() || profile.name.length > 80) throw new Error("Provider name must be 1-80 characters");
  if (!ALLOWED_KINDS.has(profile.kind)) throw new Error(`Unsupported provider kind: ${profile.kind}`);
  if (!profile.model.trim() || profile.model.length > 200) throw new Error("Provider model must be 1-200 characters");
  if (profile.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(profile.apiKeyEnv)) throw new Error("apiKeyEnv must be an environment variable name");
  if (profile.apiKey !== undefined && (!profile.apiKey || profile.apiKey.length > 4096 || /[\r\n\0]/.test(profile.apiKey))) {
    throw new Error("apiKey must be 1-4096 characters without line breaks");
  }
  validateURL(profile.baseURL, "baseURL");
  validateURL(profile.proxy, "proxy");
  if (["openai-compatible", "ollama", "lmstudio", "vllm"].includes(profile.kind) && !profile.baseURL) {
    throw new Error(`${profile.kind} profiles require a baseURL`);
  }
  if (profile.contextWindow !== undefined && (!Number.isInteger(profile.contextWindow) || profile.contextWindow < 4_000)) {
    throw new Error("contextWindow must be an integer of at least 4000");
  }
  if (!profile.features || profile.features.text !== true) throw new Error("Provider profiles must support text");
  for (const key of ["tools", "vision", "image", "video"] as const) {
    if (typeof profile.features[key] !== "boolean") throw new Error(`features.${key} must be boolean`);
  }
  if (profile.kind !== "agnes" && (profile.features.image || profile.features.video)) {
    throw new Error("Image and video generation are currently available only through the Agnes adapter");
  }
  return {
    ...profile,
    id: profile.id.trim(), name: profile.name.trim(), model: profile.model.trim(),
    baseURL: profile.baseURL?.replace(/\/$/, ""), apiKeyEnv: profile.apiKeyEnv?.trim(), builtin: Boolean(profile.builtin),
    features: { ...profile.features },
  };
}

export class ProviderRegistry {
  private file: ProviderFile = { version: 1, profiles: [], credentials: {} };

  constructor(private readonly filename = path.join(os.homedir(), ".xiu", "providers.json")) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, "utf8")) as Partial<ProviderFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) throw new Error("unsupported provider configuration format");
      if (parsed.profiles.length > 100) throw new Error("provider configuration contains more than 100 profiles");
      const legacyCredentials: Record<string, string> = {};
      const profiles = parsed.profiles.map((profile) => {
        const normalized = validateProviderProfile({ ...profile, builtin: false } as ProviderProfile);
        if (normalized.apiKey) legacyCredentials[normalized.id] = normalized.apiKey;
        const { apiKey: _secret, ...safeProfile } = normalized;
        return safeProfile as ProviderProfile;
      });
      const ids = new Set<string>();
      for (const profile of profiles) {
        if (ids.has(profile.id) || BUILTIN_PROVIDER_PROFILES.some((builtin) => builtin.id === profile.id)) throw new Error(`duplicate or reserved provider id: ${profile.id}`);
        ids.add(profile.id);
      }
      const rawCredentials = parsed.credentials && typeof parsed.credentials === "object" ? parsed.credentials : {};
      const credentials: Record<string, string> = { ...legacyCredentials };
      for (const [id, value] of Object.entries(rawCredentials)) {
        if (typeof value !== "string" || !value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`invalid saved credential for ${id}`);
        if (!BUILTIN_PROVIDER_PROFILES.some((profile) => profile.id === id) && !profiles.some((profile) => profile.id === id)) throw new Error(`credential references unknown provider: ${id}`);
        credentials[id] = value;
      }
      this.file = { version: 1, active: typeof parsed.active === "string" ? parsed.active : undefined, profiles, credentials };
      if (this.file.active && !this.get(this.file.active)) this.file.active = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.file = { version: 1, profiles: [], credentials: {} };
        return;
      }
      throw new Error(`Could not read Xiu provider settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  list(): ProviderProfile[] {
    return [...BUILTIN_PROVIDER_PROFILES, ...this.file.profiles].map((profile) => ({
      ...profile,
      apiKey: this.file.credentials?.[profile.id],
      features: { ...profile.features },
    }));
  }

  get(id: string): ProviderProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  activeId(): string | undefined { return this.file.active; }

  async setActive(id: string): Promise<void> {
    if (!this.get(id)) throw new Error(`Provider profile not found: ${id}`);
    this.file.active = id;
    await this.save();
  }

  async upsert(profile: ProviderProfile): Promise<void> {
    const normalized = validateProviderProfile({ ...profile, builtin: false });
    if (BUILTIN_PROVIDER_PROFILES.some((item) => item.id === normalized.id)) throw new Error(`Built-in provider id cannot be replaced: ${normalized.id}`);
    const { apiKey, ...storedProfile } = normalized;
    const existing = this.file.profiles.findIndex((item) => item.id === normalized.id);
    if (existing >= 0) this.file.profiles[existing] = storedProfile as ProviderProfile;
    else this.file.profiles.push(storedProfile as ProviderProfile);
    if (apiKey) (this.file.credentials ??= {})[normalized.id] = apiKey;
    await this.save();
  }

  async setApiKey(id: string, apiKey?: string): Promise<void> {
    if (!this.get(id)) throw new Error(`Provider profile not found: ${id}`);
    if (apiKey !== undefined && (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey))) throw new Error("apiKey must be 1-4096 characters without line breaks");
    this.file.credentials ??= {};
    if (apiKey) this.file.credentials[id] = apiKey;
    else delete this.file.credentials[id];
    await this.save();
  }

  async remove(id: string): Promise<void> {
    if (BUILTIN_PROVIDER_PROFILES.some((item) => item.id === id)) throw new Error("Built-in providers cannot be removed");
    const next = this.file.profiles.filter((profile) => profile.id !== id);
    if (next.length === this.file.profiles.length) throw new Error(`Provider profile not found: ${id}`);
    this.file.profiles = next;
    if (this.file.credentials) delete this.file.credentials[id];
    if (this.file.active === id) this.file.active = undefined;
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    const safeFile: ProviderFile = {
      version: 1,
      active: this.file.active,
      profiles: this.file.profiles.map(({ apiKey: _secret, ...profile }) => ({ ...profile, builtin: false } as ProviderProfile)),
      credentials: { ...this.file.credentials },
    };
    await fs.writeFile(temporary, `${JSON.stringify(safeFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.filename);
  }
}
