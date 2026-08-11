import type { AgentConfig } from "./config.js";
import type { AgentTool, ModelProvider } from "./types.js";
import { redactSecrets } from "./secret-redaction.js";

export interface ProviderFailoverRequest {
  originProviderId: string;
  currentProviderId: string;
  currentModel: string;
  attemptedProviderIds: readonly string[];
  error: unknown;
  estimatedInputTokens: number;
  requiresTools: boolean;
}

export interface ProviderFailoverCandidate {
  config: AgentConfig;
  provider: ModelProvider;
  tools: AgentTool[];
  label: string;
}

export interface ProviderFailoverResolution {
  candidate?: ProviderFailoverCandidate;
  skipped?: Array<{ providerId: string; reason: string }>;
  reason?: string;
}

export interface ProviderFailoverController {
  resolve(request: ProviderFailoverRequest): Promise<ProviderFailoverResolution>;
}

export function isTransientProviderError(error: unknown): boolean {
  const value = error as { status?: number; statusCode?: number; code?: string; name?: string; message?: string; cause?: unknown };
  const status = value.status ?? value.statusCode;
  if (value.name === "AbortError") return false;
  if (status === 408 || status === 425 || status === 429 || (typeof status === "number" && status >= 500 && status <= 599)) return true;
  if (typeof status === "number" && status >= 400 && status <= 499) return false;
  const cause = value.cause as { code?: string; name?: string; message?: string } | undefined;
  const detail = `${value.name ?? ""} ${value.code ?? ""} ${value.message ?? ""} ${cause?.name ?? ""} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  return /APIConnection(?:Error|TimeoutError)|APITimeoutError|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET)|fetch failed|connection error|network error|connection (?:reset|refused|closed|terminated|timed? ?out)|connect timeout|temporar|rate limit|socket hang up/i.test(detail);
}

export function safeProviderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, 500);
}
