import type { AgentConfig } from "./config.js";
import type { AgentTool, ModelProvider } from "./types.js";
import { redactSecrets } from "./secret-redaction.js";
import { classifyRetryError } from "./retry-policy.js";

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
  return ["rate-limit", "timeout", "transport", "server"].includes(classifyRetryError(error));
}

export function safeProviderErrorMessage(error: unknown, sensitiveValues: readonly string[] = []): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(collapseHtmlBody(raw), sensitiveValues).slice(0, 500);
}

/** A gateway in front of the provider answers 502/503 with an HTML page; keep its title, not the markup. */
function collapseHtmlBody(message: string): string {
  const start = message.search(/<!doctype\s+html|<html[\s>]/i);
  if (start < 0) return message;
  const html = message.slice(start);
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  const head = message.slice(0, start).trim();
  const summary = title && !(head && title.startsWith(head)) ? `${head} ${title}`.trim() : title || head;
  return `${summary || "HTML error page"} (HTML error page from the gateway; body omitted)`;
}
