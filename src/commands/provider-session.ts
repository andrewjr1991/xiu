import chalk from "chalk";
import type { Agent } from "../agent.js";
import { probeIsFresh, probeModelCapabilities, type CapabilityProbeState, type ModelCapabilityProbe } from "../capability-probe.js";
import type { AgentConfig } from "../config.js";
import { runFirstRunWizard } from "../first-run-wizard.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption, type SelectOption } from "../interactive-ui.js";
import { formatLocalTime } from "../local-time.js";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import { createProvider, probeProvider, type ProviderProbeResult } from "../providers.js";
import type { StatusLine } from "../status.js";
import { askQuestion, askSecret } from "../terminal-prompts.js";
import type { AgentTool, ModelProvider } from "../types.js";
import { formatUserFacingError } from "../user-facing-errors.js";

/** Terminal I/O and network probes the session uses; the defaults are the real ones, tests inject scripted ones. */
export interface ProviderSessionIo {
  /** Whether a person is at the terminal; piped sessions get hints only, never a prompt in front of their input. */
  interactive: () => boolean;
  select: <T>(title: string, options: SelectOption<T>[], language: UiLanguage) => Promise<T | undefined>;
  ask: (prompt: string) => Promise<string>;
  askSecret: (prompt: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  probeProvider: (config: AgentConfig) => Promise<ProviderProbeResult>;
  probeModelCapabilities: (config: AgentConfig, options: { provider: ModelProvider }) => Promise<ModelCapabilityProbe>;
  createProvider: (config: AgentConfig) => ModelProvider;
}

export interface ProviderSessionContext {
  agent: Pick<Agent, "replaceProvider" | "replaceTools">;
  /** The live runtime config, which `agent.replaceProvider` updates in place; read when the startup provider is reported. */
  config: Pick<AgentConfig, "providerId" | "providerLabel" | "model">;
  /** Read at call time, because `/language` changes it during the session. */
  language: () => UiLanguage;
  /** Resolves the runtime config for a profile and model, with the API-reported context window when one was discovered. */
  profileConfig: (profile: ProviderProfile, model?: string, discoveredContextWindow?: number) => AgentConfig;
  providerRegistry: Pick<ProviderRegistry, "capabilityProbe" | "setCapabilityProbe" | "setActive" | "list" | "get" | "setApiKey" | "upsert" | "remove">;
  /** Rebuilds the agent's tool list after a switch: the base tools for the new config plus the connected MCP tools. */
  refreshTools: () => AgentTool[];
  /** The profile with its cached capability probe applied, which decides the feature names shown. */
  runtimeProfile: (profile: ProviderProfile, model?: string) => ProviderProfile;
  status: Pick<StatusLine, "start" | "stop">;
  io?: Partial<ProviderSessionIo>;
}

export interface ProviderSession {
  /** `text/tools/vision/…` for the profile as the capability probe left it. */
  featureNames: (profile: ProviderProfile, model?: string) => string;
  capabilityProbeSummary: (profile: ProviderProfile, model?: string) => string;
  compactCapabilityProbeSummary: (profile: ProviderProfile, model?: string) => string;
  /**
   * Tests the connection, refreshes a stale (or forced) capability probe, swaps the agent's provider and tools, and
   * persists the choice unless told not to; false (with the failure printed) leaves the current provider in place.
   */
  switchProviderProfile: (profile: ProviderProfile, persist?: boolean, preferredModel?: string, forceCapabilityProbe?: boolean) => Promise<boolean>;
  /**
   * Startup without a working provider: with no channel at all a terminal gets the three-step wizard and a pipe the
   * one-line hint; with channels the session stays open in setup mode and a terminal may save a key or pick another
   * provider now. True when the session has a working provider afterwards.
   */
  configureStartupProvider: (startupError: Error) => Promise<boolean>;
}

const defaultIo: ProviderSessionIo = {
  interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  select: selectTerminalOption,
  ask: askQuestion,
  askSecret,
  env: process.env,
  probeProvider: (config) => probeProvider(config),
  probeModelCapabilities,
  createProvider,
};

/**
 * The provider half of the interactive session moved out of cli.ts: capability wording, switching the active
 * provider/model, and the startup flow when the configured provider cannot be used. Output and persistence are
 * unchanged; the terminal I/O and probes are injectable so the flows have contract tests.
 */
export function createProviderSession(ctx: ProviderSessionContext): ProviderSession {
  const { agent, config, profileConfig, providerRegistry, refreshTools, runtimeProfile, status } = ctx;
  const io: ProviderSessionIo = { ...defaultIo, ...ctx.io };

  const featureNames = (profile: ProviderProfile, model = profile.model): string => {
    const language = ctx.language();
    profile = runtimeProfile(profile, model);
    const names = [localize(language, "文本", "text")];
    if (profile.features.tools) names.push(localize(language, "工具", "tools"));
    if (profile.features.vision) names.push(localize(language, "视觉", "vision"));
    if (profile.features.image) names.push(localize(language, "生图", "image"));
    if (profile.features.video) names.push(localize(language, "视频", "video"));
    if (profile.features.audio) names.push(localize(language, "音频", "audio"));
    return names.join("/");
  };
  const capabilityStateName = (state: CapabilityProbeState, language: UiLanguage): string => ({
    supported: localize(language, "支持", "supported"),
    unsupported: localize(language, "不支持", "unsupported"),
    unknown: localize(language, "未知", "unknown"),
    "not-tested": localize(language, "未测试", "not tested"),
  })[state];
  const capabilityProbeSummary = (profile: ProviderProfile, model = profile.model): string => {
    const language = ctx.language();
    const probe = providerRegistry.capabilityProbe(profile.id, model);
    if (!probe) return localize(language, "能力未探测", "capabilities not tested");
    const context = probe.contextWindow ? localize(language, ` · 上下文 ${probe.contextWindow.toLocaleString()}（API）`, ` · context ${probe.contextWindow.toLocaleString()} (API)`) : "";
    return localize(language,
      `探测：工具 ${capabilityStateName(probe.tools, language)} · 视觉 ${capabilityStateName(probe.vision, language)}${context} · ${formatLocalTime(probe.checkedAt)}`,
      `Probe: tools ${capabilityStateName(probe.tools, language)} · vision ${capabilityStateName(probe.vision, language)}${context} · ${formatLocalTime(probe.checkedAt)}`);
  };
  const compactCapabilityProbeSummary = (profile: ProviderProfile, model = profile.model): string => {
    const language = ctx.language();
    const probe = providerRegistry.capabilityProbe(profile.id, model);
    if (!probe) return localize(language, "未探测", "not tested");
    return localize(language,
      `工具 ${capabilityStateName(probe.tools, language)} / 视觉 ${capabilityStateName(probe.vision, language)}`,
      `tools ${capabilityStateName(probe.tools, language)} / vision ${capabilityStateName(probe.vision, language)}`);
  };

  const switchProviderProfile = async (profile: ProviderProfile, persist = true, preferredModel?: string, forceCapabilityProbe = false): Promise<boolean> => {
    const language = ctx.language();
    status.start(localize(language, `正在测试 ${profile.name} 连接`, `Testing ${profile.name}`));
    try {
      let targetModel = preferredModel ?? profile.model;
      let candidateConfig = profileConfig(profile, targetModel);
      const connectionModel = candidateConfig.model;
      const connection = await io.probeProvider(candidateConfig);
      let nextProvider = connection.provider;
      const discovered = connection.models;
      if (candidateConfig.model === "local-model" && discovered[0]?.id) {
        targetModel = discovered[0].id;
      }
      let capabilityProbe = providerRegistry.capabilityProbe(profile.id, targetModel);
      const discoveredWindow = discovered.find((model) => model.id === targetModel)?.contextWindow;
      const apiContextWindow = discoveredWindow ?? capabilityProbe?.contextWindow;
      candidateConfig = profileConfig(profile, targetModel, apiContextWindow);
      if (candidateConfig.model !== connectionModel) nextProvider = io.createProvider(candidateConfig);
      if (forceCapabilityProbe || !probeIsFresh(capabilityProbe)) {
        status.start(localize(language, `正在探测 ${targetModel} 的工具与视觉能力`, `Probing tool and vision capabilities for ${targetModel}`));
        capabilityProbe = await io.probeModelCapabilities(candidateConfig, { provider: nextProvider });
        if (apiContextWindow) {
          capabilityProbe.contextWindow = apiContextWindow;
          capabilityProbe.contextWindowSource = "api";
        }
        await providerRegistry.setCapabilityProbe(capabilityProbe);
      }
      const nextConfig = profileConfig(profile, targetModel, apiContextWindow);
      await agent.replaceProvider(nextConfig, nextProvider);
      agent.replaceTools(refreshTools());
      if (persist) await providerRegistry.setActive(profile.id, targetModel);
      status.stop();
      const activeContextWindow = nextConfig.contextWindow ?? 128_000;
      const activeContextLimit = nextConfig.contextLimit ?? Math.floor(activeContextWindow * 0.8);
      console.log(chalk.green(localize(language, `Provider 已切换为 ${profile.name}，模型 ${nextConfig.model}。`, `Provider changed to ${profile.name}, model ${nextConfig.model}.`)));
      console.log(chalk.dim(localize(language, `上下文：${activeContextWindow.toLocaleString()} · 压缩点 ${activeContextLimit.toLocaleString()}（${nextConfig.contextWindowSource ?? "fallback"}）`, `Context: ${activeContextWindow.toLocaleString()} · compact at ${activeContextLimit.toLocaleString()} (${nextConfig.contextWindowSource ?? "fallback"})`)));
      console.log(chalk.dim(localize(language, `能力：${featureNames(profile, targetModel)}${discovered.length ? ` · 发现 ${discovered.length} 个模型` : ""}`, `Capabilities: ${featureNames(profile, targetModel)}${discovered.length ? ` · discovered ${discovered.length} models` : ""}`)));
      console.log(chalk.dim(`${capabilityProbeSummary(profile, targetModel)}\n`));
      if (connection.discoveryError) console.log(chalk.dim(localize(language, "该服务未提供兼容的模型列表接口；已通过最小聊天请求验证连接。\n", "The service has no compatible model-list endpoint; connection verified with a minimal chat request.\n")));
      return true;
    } catch (error) {
      status.stop();
      console.error(chalk.red(`${formatUserFacingError(localize(language, "Provider 连接失败", "Provider connection failed"), error, language, { sensitive: profile.apiKey ? [profile.apiKey] : [] })}\n`));
      return false;
    }
  };

  const configureStartupProvider = async (startupError: Error): Promise<boolean> => {
    const language = ctx.language();
    if (!providerRegistry.list().length) {
      // Piped sessions keep the one-line hint so scripts stay predictable; a terminal gets the three-step wizard.
      // The wizard saves nothing until its connection test passes, so leaving it never creates a half-finished channel.
      if (io.interactive()) {
        const outcome = await runFirstRunWizard({
          language,
          registry: providerRegistry,
          env: io.env,
          probe: async (profile) => {
            const probed = await io.probeProvider(profileConfig(profile));
            return { models: probed.models, discoveryError: probed.discoveryError };
          },
          activate: (profile, model) => switchProviderProfile(profile, true, model),
          io: {
            select: (title, options) => io.select(title, options, language),
            ask: io.ask,
            askSecret: io.askSecret,
            log: (line) => console.log(`${line}\n`),
          },
        });
        if (outcome.status === "configured") return true;
      }
      console.log(chalk.yellow(localize(language, "尚未添加任何渠道。请输入 /provider add，选择 Agnes、OpenAI、本地模型或兼容服务；无需先设置环境变量。\n", "No Providers added. Enter /provider add to choose Agnes, OpenAI, a local model, or a compatible service. Environment variables are optional.\n")));
      return false;
    }
    console.log(chalk.yellow(localize(language,
      `当前 Provider ${config.providerLabel ?? config.providerId} 尚未配置（${startupError.message}）。Xiu 已进入配置模式，不会退出。`,
      `The current provider ${config.providerLabel ?? config.providerId} is not configured (${startupError.message}). Xiu is staying open in setup mode.`)));
    console.log(chalk.dim(localize(language,
      "你可以现在完成引导，也可以稍后使用 /provider key 保存 Key，或使用 /providers 切换服务。\n",
      "You can finish the guided setup now, or later use /provider key to save a key or /providers to switch services.\n")));

    // Piped/non-interactive sessions must remain scriptable. They receive the
    // same setup guidance, but no prompt is forced in front of their input.
    if (!io.interactive()) return false;

    const action = await io.select(localize(language, "首次使用配置", "First-run setup"), [
      {
        label: localize(language, `配置 ${config.providerLabel ?? config.providerId} 的 API Key`, `Configure the API key for ${config.providerLabel ?? config.providerId}`),
        description: localize(language, "Key 仅保存在本机凭证配置中，输入内容不会显示", "The key stays in local credential storage and input is hidden"),
        value: "key" as const,
      },
      {
        label: localize(language, "选择其他 Provider", "Choose another provider"),
        description: localize(language, "可选择 Agnes、本地模型或已经配置的服务", "Choose Agnes, a local model, or another configured service"),
        value: "provider" as const,
      },
      {
        label: localize(language, "稍后配置", "Configure later"),
        description: localize(language, "先进入 xiu>，不会关闭程序", "Continue to xiu> without closing the program"),
        value: "later" as const,
      },
    ], language);

    if (action === "key") {
      try {
        const apiKey = await io.askSecret(localize(language, "输入 API Key（输入内容不会显示，直接回车取消）：", "API key (input is hidden; press Enter to cancel): "));
        if (!apiKey) return false;
        await providerRegistry.setApiKey(config.providerId, apiKey);
        const saved = providerRegistry.get(config.providerId);
        if (!saved) throw new Error(localize(language, "Provider 配置不存在。", "Provider profile not found."));
        return switchProviderProfile(saved, true, config.model);
      } catch (error) {
        console.error(chalk.red(`${formatUserFacingError(localize(language, "配置 Provider 失败", "Could not configure provider"), error, language)}\n`));
      }
      return false;
    }

    if (action === "provider") {
      const profiles = providerRegistry.list();
      const selected = await io.select(localize(language, "选择 Provider", "Choose a provider"), profiles.map((profile) => ({
        label: profile.name,
        description: `${profile.id} · ${profile.kind} · ${profile.model} · ${featureNames(profile)}`,
        value: profile.id,
      })), language);
      return Boolean(selected) && switchProviderProfile(providerRegistry.get(selected!)!);
    }
    return false;
  };

  return { featureNames, capabilityProbeSummary, compactCapabilityProbeSummary, switchProviderProfile, configureStartupProvider };
}
