import type { AgentConfig } from "../config.js";
import { applyCapabilityProbe } from "../capability-probe.js";
import type { ProviderRegistry, ProviderProfile } from "../provider-registry.js";
import type { ProviderFailoverController } from "../provider-failover.js";
import type { ProviderRoutingController, ProviderRouteCandidate } from "../provider-routing.js";
import { createProvider } from "../providers.js";
import type { AgentTool } from "../types.js";
import { localize, type UiLanguage } from "../i18n.js";

/** Frontends supply composition, not separate provider-selection rules. */
export function createProviderPolicy(registry: ProviderRegistry,
  configFor: (profile: ProviderProfile, model: string) => AgentConfig,
  toolsFor: (config: AgentConfig) => AgentTool[],
  language: UiLanguage = "en-US",
): { failover: ProviderFailoverController; routing: ProviderRoutingController } {
  const candidate = (id: string, tokens: number, tools: boolean): { value?: ProviderRouteCandidate; reason?: string } => {
    const profile = registry.get(id);
    if (!profile) return { reason: localize(language, "目标渠道不存在", "Provider profile not found") };
    const model = registry.activeModel(id) ?? profile.model;
    const probe = registry.capabilityProbe(id, model);
    const features = applyCapabilityProbe(profile.features, probe);
    if (tools && !features.tools) return { reason: localize(language, "请求需要工具能力，目标模型不支持", "The request requires tool support") };
    const config = configFor({ ...profile, features, contextWindow: profile.contextWindow ?? probe?.contextWindow }, model);
    const limit = config.contextLimit ?? Math.floor((config.contextWindow ?? 128_000) * 0.8);
    if (tokens >= limit) return { reason: localize(language, "上下文超出目标模型的安全输入上限", "Context exceeds the target model's safe input limit") };
    return { value: { config, provider: createProvider(config), tools: toolsFor(config), label: profile.name } };
  };
  return {
    failover: { async resolve(request) {
      const skipped: Array<{ providerId: string; reason: string }> = [];
      for (const id of registry.failoverChain(request.originProviderId)) {
        if (request.attemptedProviderIds.includes(id)) { skipped.push({ providerId: id, reason: localize(language, "本任务已尝试该渠道", "Already attempted in this task") }); continue; }
        const target = candidate(id, request.estimatedInputTokens, request.requiresTools);
        if (target.value) return { candidate: target.value, skipped };
        skipped.push({ providerId: id, reason: target.reason! });
      }
      return { skipped, reason: localize(language, "没有符合条件的备用渠道", "No eligible fallback provider") };
    } },
    routing: { async resolve(request) {
      const policy = registry.routingPolicy();
      if (!policy.enabled) return {};
      const targetProviderId = policy.phases[request.phase];
      if (!targetProviderId) return request.currentProviderId === request.defaultProviderId && request.currentModel === request.defaultModel
        ? {} : { useDefault: true, targetProviderId: request.defaultProviderId, reason: localize(language, "阶段未绑定渠道，恢复任务默认模型", "Unassigned stage; restoring task default") };
      const target = candidate(targetProviderId, request.estimatedInputTokens, request.requiresTools);
      if (!target.value) return { targetProviderId, reason: target.reason };
      if (target.value.config.providerId === request.currentProviderId && target.value.config.model === request.currentModel) return {};
      return { candidate: target.value, targetProviderId, reason: localize(language, `用户绑定的 ${request.phase} 阶段`, `User-assigned ${request.phase} stage`) };
    } },
  };
}
