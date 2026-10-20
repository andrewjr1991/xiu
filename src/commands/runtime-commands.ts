import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import type { StatusLine } from "../status.js";

export interface RuntimeCommandContext {
  agent: Pick<Agent, "listModels" | "status">;
  /** Applies a chosen interface language (persisting it) and redraws the screen. */
  applyRuntimeLanguage: (selected: UiLanguage, redrawScreen: boolean) => Promise<void>;
  /** Capability-probe line for a profile/model pair, as the CLI formats it. */
  capabilityProbeSummary: (profile: ProviderProfile, model?: string) => string;
  /** Resolves `/language [zh-CN|en-US]` to a language, prompting when no argument was given; undefined means cancelled. */
  chooseRuntimeLanguage: (command: string) => Promise<UiLanguage | undefined>;
  /** The live runtime config: `/models` lists the provider that is current when it runs. */
  config: Pick<AgentConfig, "providerId">;
  /** Feature names for a profile/model pair, as the CLI formats them. */
  featureNames: (profile: ProviderProfile, model?: string) => string;
  language: UiLanguage;
  providerRegistry: Pick<ProviderRegistry, "get">;
  startupProfile: ProviderProfile;
  status: Pick<StatusLine, "start" | "stop">;
  /** Switches to a profile/model and persists the choice; `/models` passes the current profile and the chosen model. */
  switchProviderProfile: (profile: ProviderProfile, persist: boolean, preferredModel?: string) => Promise<boolean>;
}

/**
 * The runtime selection slash commands moved out of the interactive loop in cli.ts (`/models`, `/language`);
 * returns false when `task` is not one of them. Output and prompts are unchanged: without a terminal the model
 * selector counts as cancelled and nothing is switched.
 */
export async function handleRuntimeCommand(task: string, ctx: RuntimeCommandContext): Promise<boolean> {
  const { agent, applyRuntimeLanguage, capabilityProbeSummary, chooseRuntimeLanguage, config, featureNames, language, providerRegistry, startupProfile, status, switchProviderProfile } = ctx;
  if (task === "/models") {
    status.start(localize(language, "正在发现可用模型", "Discovering available models"));
    const available = await agent.listModels();
    status.stop();
    if (available.discoveryError) console.log(chalk.yellow(localize(language, `无法在线发现模型：${available.discoveryError}\n改为显示内置模型。\n`, `Live model discovery unavailable: ${available.discoveryError}\nShowing built-in models instead.\n`)));
    const current = agent.status().model;
    const currentProfile = providerRegistry.get(config.providerId) ?? startupProfile;
    const selected = await selectTerminalOption(localize(language, "选择模型", "Choose a model"), available.models.map((model) => ({
      label: `${model.id}${model.id === current ? localize(language, "（当前）", " (current)") : ""}`,
      description: [
        model.name && model.name !== model.id ? model.name : "",
        featureNames(currentProfile, model.id),
        capabilityProbeSummary(currentProfile, model.id),
        model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K ctx` : "",
        model.providerId,
        model.description ?? "",
        model.source,
      ].filter(Boolean).join("  ·  "),
      value: model.id,
    })), language);
    if (!selected || selected === current) console.log(chalk.dim(selected ? localize(language, `模型保持为 ${current}。\n`, `Model remains ${current}.\n`) : localize(language, "已取消模型选择。\n", "Model selection cancelled.\n")));
    else {
      await switchProviderProfile(currentProfile, true, selected);
    }
    return true;
  }
  if (task === "/language" || task.startsWith("/language ")) {
    const selected = await chooseRuntimeLanguage(task);
    if (!selected) {
      console.log(chalk.dim(localize(language, "已取消语言选择。\n", "Language selection cancelled.\n")));
      return true;
    }
    await applyRuntimeLanguage(selected, true);
    return true;
  }
  return false;
}
