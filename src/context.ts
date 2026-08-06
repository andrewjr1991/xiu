import type { AgentConfig, ProviderName } from "./config.js";

export type ContextWindowSource = "official" | "configured" | "fallback";

export interface ContextProfile {
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
  contextLimit: number;
  contextLimitMode: "automatic" | "configured";
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const AUTO_COMPACT_RATIO = 0.8;
const MAX_COMPACT_RATIO = 0.9;

function officialContextWindow(provider: ProviderName, model: string): number | undefined {
  // Agnes 2.5 Flash documentation lists a 512K context window and 65.5K maximum output.
  if (provider === "agnes" && model.toLowerCase() === "agnes-2.5-flash") return 512_000;
  return undefined;
}

export function resolveContextProfile(input: {
  provider: ProviderName;
  model: string;
  contextWindow?: string | number;
  contextLimit?: string | number;
}): ContextProfile {
  const configuredWindow = input.contextWindow === undefined ? undefined : Number(input.contextWindow);
  if (configuredWindow !== undefined && (!Number.isInteger(configuredWindow) || configuredWindow < 8_000)) {
    throw new Error("context-window must be an integer of at least 8000 tokens");
  }
  const officialWindow = officialContextWindow(input.provider, input.model);
  const contextWindow = configuredWindow ?? officialWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextWindowSource: ContextWindowSource = configuredWindow !== undefined
    ? "configured"
    : officialWindow !== undefined ? "official" : "fallback";
  const maximumSafeLimit = Math.floor(contextWindow * MAX_COMPACT_RATIO);
  const configuredLimit = input.contextLimit === undefined ? undefined : Number(input.contextLimit);
  if (configuredLimit !== undefined && (!Number.isInteger(configuredLimit) || configuredLimit < 4_000)) {
    throw new Error("context-limit must be an integer of at least 4000 tokens");
  }
  if (configuredLimit !== undefined && configuredLimit > maximumSafeLimit) {
    throw new Error(`context-limit must not exceed 90% of the ${contextWindow.toLocaleString()} token context window (${maximumSafeLimit.toLocaleString()})`);
  }
  return {
    contextWindow,
    contextWindowSource,
    contextLimit: configuredLimit ?? Math.floor(contextWindow * AUTO_COMPACT_RATIO),
    contextLimitMode: configuredLimit === undefined ? "automatic" : "configured",
  };
}

export function refreshModelContext(config: AgentConfig, model: string): void {
  const profile = resolveContextProfile({
    provider: config.provider,
    model,
    contextWindow: config.contextWindowSource === "configured" ? config.contextWindow : undefined,
    contextLimit: config.contextLimitMode === "configured" ? config.contextLimit : undefined,
  });
  config.contextWindow = profile.contextWindow;
  config.contextWindowSource = profile.contextWindowSource;
  config.contextLimit = profile.contextLimit;
  config.contextLimitMode = profile.contextLimitMode;
}
