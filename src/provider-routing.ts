import type { AgentConfig } from "./config.js";
import type { AgentTool, ModelProvider } from "./types.js";

export const PROVIDER_ROUTING_PHASES = ["planning", "implementation", "verification"] as const;
export type ProviderRoutingPhase = typeof PROVIDER_ROUTING_PHASES[number];

export interface ProviderRoutingPolicy {
  enabled: boolean;
  phases: Partial<Record<ProviderRoutingPhase, string>>;
}

export interface ProviderRouteRequest {
  phase: ProviderRoutingPhase;
  currentProviderId: string;
  currentModel: string;
  defaultProviderId: string;
  defaultModel: string;
  estimatedInputTokens: number;
  requiresTools: boolean;
}

export interface ProviderRouteCandidate {
  config: AgentConfig;
  provider: ModelProvider;
  tools: AgentTool[];
  label: string;
}

export interface ProviderRouteResolution {
  candidate?: ProviderRouteCandidate;
  useDefault?: boolean;
  targetProviderId?: string;
  reason?: string;
}

export interface ProviderRoutingController {
  resolve(request: ProviderRouteRequest): Promise<ProviderRouteResolution>;
}

export interface ProviderRoutingDecision {
  phase: ProviderRoutingPhase;
  reason: "plan_mode" | "initial_analysis" | "completion_gate" | "verification_step" | "implementation";
}

export function determineProviderRoutingPhase(input: {
  turn: number;
  planMode: boolean;
  completionGateActive: boolean;
  activePlanStep?: string;
}): ProviderRoutingDecision {
  if (input.planMode) return { phase: "planning", reason: "plan_mode" };
  if (input.turn === 1) return { phase: "planning", reason: "initial_analysis" };
  if (input.completionGateActive) return { phase: "verification", reason: "completion_gate" };
  if (/(?:verify|test|lint|build|check|validation|verification|验收|验证|测试|检查|校验|构建|编译)/i.test(input.activePlanStep ?? "")) {
    return { phase: "verification", reason: "verification_step" };
  }
  return { phase: "implementation", reason: "implementation" };
}

export function isProviderRoutingPhase(value: string): value is ProviderRoutingPhase {
  return (PROVIDER_ROUTING_PHASES as readonly string[]).includes(value);
}
