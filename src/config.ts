import path from "node:path";
import { resolveContextProfile, type ContextWindowSource } from "./context.js";
import { defaultLanguage, normalizeLanguage, type UiLanguage } from "./i18n.js";

export type ProviderName = "openai" | "anthropic" | "agnes" | "openai-compatible" | "ollama" | "lmstudio" | "vllm";

export interface ProviderFeatureFlags {
  text: true;
  tools: boolean;
  vision: boolean;
  image: boolean;
  video: boolean;
}

export interface CapabilityModels {
  text: string;
  vision: string;
  image?: string;
  video?: string;
  unified?: string;
}

export interface AgentConfig {
  provider: ProviderName;
  providerId: string;
  providerLabel?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  /** Non-secret local revision used to invalidate credential-dependent in-memory work. */
  credentialRevision?: number;
  providerFeatures?: ProviderFeatureFlags;
  model: string;
  cwd: string;
  /** Optional user-selected cap. Undefined means the primary agent may continue until completion or cancellation. */
  maxTurns?: number;
  autoApprove: boolean;
  baseURL?: string;
  mediaBaseURL?: string;
  proxy?: string;
  capabilities?: CapabilityModels;
  contextLimit?: number;
  contextWindow?: number;
  contextWindowSource?: ContextWindowSource;
  contextLimitMode?: "automatic" | "configured";
  agentConcurrency?: number;
  /** Internal session-log namespace. CLI user sessions use the default `sessions`. */
  sessionNamespace?: string;
  language?: UiLanguage;
}

export function resolveConfig(options: {
  provider?: string;
  model?: string;
  cwd?: string;
  maxTurns?: string;
  yes?: boolean;
  baseURL?: string;
  mediaBaseURL?: string;
  proxy?: string;
  visionModel?: string;
  imageModel?: string;
  videoModel?: string;
  unifiedModel?: string;
  contextLimit?: string;
  contextWindow?: string;
  agentConcurrency?: string;
  language?: string;
  providerId?: string;
  providerLabel?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  credentialRevision?: number;
  providerFeatures?: ProviderFeatureFlags;
}): AgentConfig {
  const provider = (options.provider ?? process.env.XIU_PROVIDER ?? "openai") as ProviderName;
  if (!["openai", "anthropic", "agnes", "openai-compatible", "ollama", "lmstudio", "vllm"].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}.`);
  }

  const defaultModel = provider === "anthropic"
    ? "claude-sonnet-4-20250514"
    : provider === "agnes"
      ? "agnes-2.5-flash"
      : provider === "openai" ? "gpt-5" : "local-model";
  const configuredMaxTurns = options.maxTurns ?? process.env.XIU_MAX_TURNS;
  const maxTurns = configuredMaxTurns === undefined ? undefined : Number(configuredMaxTurns);
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw new Error("max-turns must be a positive integer when provided");
  }
  const agentConcurrency = Number(options.agentConcurrency ?? process.env.XIU_AGENT_CONCURRENCY ?? 3);
  if (!Number.isInteger(agentConcurrency) || agentConcurrency < 1 || agentConcurrency > 8) {
    throw new Error("agent-concurrency must be an integer from 1 to 8");
  }

  const proxy = options.proxy ?? (provider === "agnes" ? process.env.AGNES_PROXY : undefined);
  if (proxy) {
    let parsed: URL;
    try { parsed = new URL(proxy); } catch { throw new Error("proxy must be a valid URL, for example http://127.0.0.1:12334"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("proxy must use http:// or https://");
    }
  }

  const model = options.model ?? process.env.XIU_MODEL ?? defaultModel;
  const unified = options.unifiedModel ?? process.env.XIU_UNIFIED_MODEL;
  const supportsVision = options.providerFeatures?.vision ?? (provider === "agnes" || provider === "openai" || provider === "anthropic");
  const capabilities: CapabilityModels = unified
    ? provider === "agnes"
      ? { text: unified, vision: unified, image: unified, video: unified, unified }
      : { text: unified, vision: supportsVision ? unified : "", unified }
    : provider === "agnes" ? {
        text: model,
        vision: options.visionModel ?? process.env.XIU_VISION_MODEL ?? model,
        image: options.imageModel ?? process.env.XIU_IMAGE_MODEL ?? "agnes-image-2.1-flash",
        video: options.videoModel ?? process.env.XIU_VIDEO_MODEL ?? "agnes-video-v2.0",
      } : {
        text: model,
        vision: supportsVision ? model : "",
        ...(options.imageModel ?? process.env.XIU_IMAGE_MODEL ? { image: options.imageModel ?? process.env.XIU_IMAGE_MODEL } : {}),
        ...(options.videoModel ?? process.env.XIU_VIDEO_MODEL ? { video: options.videoModel ?? process.env.XIU_VIDEO_MODEL } : {}),
      };
  const context = resolveContextProfile({
    provider,
    model: capabilities.text,
    contextWindow: options.contextWindow ?? process.env.XIU_CONTEXT_WINDOW,
    contextLimit: options.contextLimit ?? process.env.XIU_CONTEXT_LIMIT,
  });

  const baseURL = options.baseURL
    ?? (provider === "agnes"
      ? process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1"
      : provider === "anthropic" ? process.env.ANTHROPIC_BASE_URL
        : provider === "ollama" ? "http://127.0.0.1:11434/v1"
          : provider === "lmstudio" ? "http://127.0.0.1:1234/v1"
            : provider === "vllm" ? "http://127.0.0.1:8000/v1"
              : process.env.OPENAI_BASE_URL);
  const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE) ?? defaultLanguage();

  return {
    provider,
    providerId: options.providerId ?? provider,
    providerLabel: options.providerLabel,
    apiKeyEnv: options.apiKeyEnv,
    apiKey: options.apiKey,
    credentialRevision: options.credentialRevision,
    providerFeatures: options.providerFeatures,
    model: capabilities.text,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    maxTurns,
    autoApprove: Boolean(options.yes),
    baseURL,
    mediaBaseURL: options.mediaBaseURL
      ?? process.env.XIU_MEDIA_BASE_URL
      ?? (provider === "agnes" ? baseURL : process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1"),
    proxy,
    capabilities,
    ...context,
    agentConcurrency,
    language,
  };
}
