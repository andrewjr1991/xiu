import type { AgentConfig } from "./config.js";
import { createHash } from "node:crypto";
import { createMediaBackend, type MediaBackend } from "./media.js";
import { createProvider } from "./providers.js";
import type { ProviderFeatures } from "./provider-registry.js";
import type { ModelProvider } from "./types.js";
import { SafeRequestCache } from "./request-cache.js";

export type CapabilityProbeState = "supported" | "unsupported" | "unknown" | "not-tested";

export const CAPABILITY_PROBE_PROTOCOL_VERSION = 4;
const capabilityProbeFlights = new SafeRequestCache(0, 100);

export interface ModelCapabilityProbe {
  protocolVersion?: number;
  providerId: string;
  model: string;
  checkedAt: string;
  text: CapabilityProbeState;
  tools: CapabilityProbeState;
  vision: CapabilityProbeState;
  contextWindow?: number;
  contextWindowSource?: "api";
  profileFingerprint?: string;
}

export interface CapabilityProbeOptions {
  provider?: ModelProvider;
  mediaBackend?: MediaBackend;
  includeVision?: boolean;
  timeoutMs?: number;
  now?: () => Date;
}

// Fixed generated color samples. They contain no project or user data. Asking
// about their actual pixels avoids treating an endpoint that silently ignores
// image input as vision-capable.
const VISION_PROBES = [
  { answer: "RED", image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANUlEQVR4nO3QsQ0AMAzDsLT//9yeoCkbeYAN6LzZdZf3x0GSKEmUJEoSJYmSREmiJFGSaMoHo8QBPwYSAhsAAAAASUVORK5CYII=" },
  { answer: "GREEN", image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANklEQVR4nO3RQQ0AAAjDwIF/YchCQl/79QSMpEwuVdudjweYP0AmQiZCJkImQiZCJkImQiYKeQg1AQhIoyrhAAAAAElFTkSuQmCC" },
  { answer: "BLUE", image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOUlEQVR4nO3RQQ0AMAzDwGwIy5/MBsH95OcDkEruybw03ep6PLDgD5CJkImQiZCJkImQiZCJkIlCPmtiAY8E+C3lAAAAAElFTkSuQmCC" },
] as const;

function visionProbeFor(config: AgentConfig): (typeof VISION_PROBES)[number] {
  const key = `${config.providerId}\0${config.model}`;
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return VISION_PROBES[hash % VISION_PROBES.length]!;
}

function failureState(error: unknown): CapabilityProbeState {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:400|404|405|415|422|501)\b|unsupported|not support|does not support|invalid.*(?:image|tool)/i.test(message)
    ? "unsupported"
    : "unknown";
}

async function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Capability probe timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}

async function executeCapabilityProbe(config: AgentConfig, options: CapabilityProbeOptions): Promise<ModelCapabilityProbe> {
  const provider = options.provider ?? createProvider(config);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 120_000));
  let tools: CapabilityProbeState = "not-tested";
  if (provider.probeToolSupport) {
    try { tools = await withTimeout(timeoutMs, (signal) => provider.probeToolSupport!(signal)) ? "supported" : "unsupported"; }
    catch (error) { tools = failureState(error); }
  }

  let vision: CapabilityProbeState = "not-tested";
  if (options.includeVision !== false) {
    const backend = options.mediaBackend ?? createMediaBackend(config);
    if (!backend.analyzeImage) vision = "unsupported";
    else {
      try {
        const sample = visionProbeFor(config);
        const output = await withTimeout(timeoutMs, (signal) => backend.analyzeImage!("Identify the single solid color in this image. Reply with exactly one uppercase English color word and nothing else.", sample.image, signal));
        vision = output.trim().toUpperCase() === sample.answer ? "supported" : "unsupported";
      } catch (error) { vision = failureState(error); }
    }
  }

  return {
    protocolVersion: CAPABILITY_PROBE_PROTOCOL_VERSION,
    providerId: config.providerId,
    model: config.model,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    text: "supported",
    tools,
    vision,
  };
}

export async function probeModelCapabilities(config: AgentConfig, options: CapabilityProbeOptions = {}): Promise<ModelCapabilityProbe> {
  const key = capabilityProbeFlightKey(config, options.includeVision !== false);
  return capabilityProbeFlights.run(key, () => executeCapabilityProbe(config, options), false);
}

export function capabilityProbeFlightKey(config: AgentConfig, includeVision = true): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: config.providerId,
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    proxy: config.proxy,
    apiKeyEnv: config.apiKeyEnv,
    credentialRevision: config.credentialRevision ?? 0,
    includeVision,
  })).digest("hex");
}

export function probeIsFresh(probe: ModelCapabilityProbe | undefined, now = Date.now(), maximumAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  if (!probe) return false;
  if (probe.protocolVersion !== CAPABILITY_PROBE_PROTOCOL_VERSION) return false;
  const checkedAt = Date.parse(probe.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt <= maximumAgeMs;
}

export function applyCapabilityProbe(features: ProviderFeatures, probe?: ModelCapabilityProbe): ProviderFeatures {
  if (!probe) return { ...features };
  const verified = (state: CapabilityProbeState, declared: boolean): boolean => state === "not-tested" ? declared : state === "supported";
  const tools = verified(probe.tools, features.tools);
  return {
    ...features,
    tools,
    // Xiu currently exposes image analysis through an agent tool. A model that
    // accepts images but cannot call tools cannot use that capability in Xiu yet.
    vision: tools && verified(probe.vision, features.vision),
  };
}
