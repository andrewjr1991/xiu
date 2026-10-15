import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import { type ProviderProfile, type ProviderRegistry, providerTemplates, UNCONFIGURED_PROVIDER_PROFILE } from "../provider-registry.js";
import { isProviderRoutingPhase, PROVIDER_ROUTING_PHASES } from "../provider-routing.js";
import { probeProvider } from "../providers.js";
import type { StatusLine } from "../status.js";
import { askQuestion, askSecret } from "../terminal-prompts.js";

export interface ProviderCommandContext {
  agent: Agent;
  attachMcpTools: () => void;
  compactCapabilityProbeSummary: (profile: ProviderProfile, model?: string) => string;
  config: AgentConfig;
  featureNames: (profile: ProviderProfile, model?: string) => string;
  language: UiLanguage;
  profileConfig: (profile: ProviderProfile, model?: string, discoveredContextWindow?: number) => AgentConfig;
  providerRegistry: ProviderRegistry;
  rebuildBaseTools: () => void;
  startupProfile: ProviderProfile;
  status: StatusLine;
  switchProviderProfile: (profile: ProviderProfile, persist?: boolean, preferredModel?: string, forceCapabilityProbe?: boolean) => Promise<boolean>;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleProviderCommand(task: string, ctx: ProviderCommandContext): Promise<boolean> {
  const { agent, attachMcpTools, compactCapabilityProbeSummary, config, featureNames, language, profileConfig, providerRegistry, rebuildBaseTools, startupProfile, status, switchProviderProfile } = ctx;
  if (task === "/providers") {
    const profiles = providerRegistry.list();
    const selected = await selectTerminalOption(localize(language, "选择 Provider", "Choose a provider"), profiles.map((profile) => ({
      label: `${profile.name}${profile.id === config.providerId ? localize(language, "（当前）", " (current)") : ""}`,
      description: `${profile.id} · ${profile.kind} · ${profile.model} · ${featureNames(profile)} · ${compactCapabilityProbeSummary(profile)}`,
      value: profile.id,
    })), language);
    if (!selected) console.log(chalk.dim(localize(language, "已取消 Provider 选择。\n", "Provider selection cancelled.\n")));
    else if (selected === config.providerId) console.log(chalk.dim(localize(language, `当前已是 ${selected}。\n`, `${selected} is already active.\n`)));
    else await switchProviderProfile(providerRegistry.get(selected)!);
    return true;
  }
  if (task === "/routing" || task.startsWith("/routing ")) {
    const action = task.slice("/routing".length).trim();
    const phaseLabels: Record<string, string> = {
      planning: localize(language, "规划", "planning"),
      implementation: localize(language, "实现", "implementation"),
      verification: localize(language, "验证", "verification"),
    };
    if (!action) {
      const policy = providerRegistry.routingPolicy();
      console.log(chalk.cyan(localize(language, `阶段路由：${policy.enabled ? "已启用" : "已停用"}`, `Stage routing: ${policy.enabled ? "enabled" : "disabled"}`)));
      for (const phase of PROVIDER_ROUTING_PHASES) {
        const id = policy.phases[phase];
        const profile = id ? providerRegistry.get(id) : undefined;
        console.log(`  ${phaseLabels[phase]}: ${profile ? `${profile.name} (${id}/${providerRegistry.activeModel(id!) ?? profile.model})` : localize(language, "跟随当前 Provider", "use the current provider")}`);
      }
      console.log(chalk.dim(localize(language, "自动路由只在模型请求边界切换；能力或上下文不满足时会保留当前模型。任务结束后恢复用户手动选择。\n", "Automatic routing only switches at model-request boundaries. Xiu keeps the current model when capabilities or context are insufficient, and restores the user's manual selection after the task.\n")));
      return true;
    }
    if (action === "on" || action === "off") {
      await providerRegistry.setRoutingEnabled(action === "on");
      console.log(chalk.green(localize(language, `阶段路由已${action === "on" ? "启用" : "停用"}。\n`, `Stage routing ${action === "on" ? "enabled" : "disabled"}.\n`)));
      return true;
    }
    const match = /^(set|clear)\s+(planning|implementation|verification)$/.exec(action);
    if (match) {
      const operation = match[1]!;
      const phase = match[2]!;
      if (!isProviderRoutingPhase(phase)) return true;
      if (operation === "clear") {
        await providerRegistry.setRoutingPhase(phase);
        console.log(chalk.green(localize(language, `已清除${phaseLabels[phase]}阶段的 Provider。\n`, `Cleared the provider for the ${phase} stage.\n`)));
        return true;
      }
      const selected = await selectTerminalOption(localize(language, `为${phaseLabels[phase]}阶段选择 Provider`, `Choose a provider for the ${phase} stage`), providerRegistry.list().map((profile) => ({
        label: profile.name,
        description: `${profile.id} · ${providerRegistry.activeModel(profile.id) ?? profile.model} · ${featureNames(profile)}`,
        value: profile.id,
      })), language);
      if (!selected) console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n")));
      else {
        await providerRegistry.setRoutingPhase(phase, selected);
        console.log(chalk.green(localize(language, `已将${phaseLabels[phase]}阶段绑定到 ${selected}。使用 /routing on 启用。\n`, `Assigned the ${phase} stage to ${selected}. Enable it with /routing on.\n`)));
      }
      return true;
    }
    console.log(chalk.yellow(localize(language, "用法：/routing [on|off|set <planning|implementation|verification>|clear <planning|implementation|verification>]\n", "Usage: /routing [on|off|set <planning|implementation|verification>|clear <planning|implementation|verification>]\n")));
    return true;
  }
  if (task === "/provider test" || task === "/provider capabilities") {
    const profile = providerRegistry.get(config.providerId) ?? startupProfile;
    await switchProviderProfile(profile, true, agent.status().model, true);
    return true;
  }
  if (task === "/provider fallback" || task.startsWith("/provider fallback ")) {
    const primaryId = config.providerId;
    const action = task.slice("/provider fallback".length).trim();
    const chain = providerRegistry.failoverChain(primaryId);
    if (!action) {
      console.log(chalk.cyan(localize(language, `主 Provider：${primaryId}`, `Primary provider: ${primaryId}`)));
      console.log(chain.length
        ? `${chain.map((id, index) => `${index + 1}. ${providerRegistry.get(id)?.name ?? id} (${id})`).join("\n")}\n`
        : chalk.dim(localize(language, "尚未配置备用链。使用 /provider fallback add 添加。\n", "No failover chain is configured. Add one with /provider fallback add.\n")));
      return true;
    }
    if (action === "clear") {
      await providerRegistry.setFailoverChain(primaryId, []);
      console.log(chalk.green(localize(language, `已清空 ${primaryId} 的备用链。\n`, `Cleared the failover chain for ${primaryId}.\n`)));
      return true;
    }
    if (action === "add") {
      const candidates = providerRegistry.list().filter((profile) => profile.id !== primaryId && !chain.includes(profile.id));
      if (!candidates.length) {
        console.log(chalk.dim(localize(language, "没有可添加的 Provider。\n", "There are no providers available to add.\n")));
        return true;
      }
      const selected = await selectTerminalOption(localize(language, "选择要追加的备用 Provider", "Choose a fallback provider to append"), candidates.map((profile) => ({
        label: profile.name,
        description: `${profile.id} · ${profile.model} · ${featureNames(profile)} · ${compactCapabilityProbeSummary(profile)}`,
        value: profile.id,
      })), language);
      if (!selected) console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n")));
      else {
        await providerRegistry.setFailoverChain(primaryId, [...chain, selected]);
        console.log(chalk.green(localize(language, `已将 ${selected} 添加为第 ${chain.length + 1} 顺位备用 Provider。\n`, `Added ${selected} as fallback provider #${chain.length + 1}.\n`)));
      }
      return true;
    }
    if (action === "remove") {
      if (!chain.length) {
        console.log(chalk.dim(localize(language, "备用链为空。\n", "The failover chain is empty.\n")));
        return true;
      }
      const selected = await selectTerminalOption(localize(language, "移除哪个备用 Provider？", "Remove which fallback provider?"), chain.map((id, index) => ({
        label: providerRegistry.get(id)?.name ?? id,
        description: localize(language, `第 ${index + 1} 顺位 · ${id}`, `Position ${index + 1} · ${id}`),
        value: id,
      })), language);
      if (!selected) console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n")));
      else {
        await providerRegistry.setFailoverChain(primaryId, chain.filter((id) => id !== selected));
        console.log(chalk.green(localize(language, `已从备用链移除 ${selected}。\n`, `Removed ${selected} from the failover chain.\n`)));
      }
      return true;
    }
    console.log(chalk.yellow(localize(language, "用法：/provider fallback [add|remove|clear]\n", "Usage: /provider fallback [add|remove|clear]\n")));
    return true;
  }
  if (task === "/provider key") {
    const profiles = providerRegistry.list();
    const selected = await selectTerminalOption(localize(language, "为哪个 Provider 保存 Key？", "Save a key for which provider?"), profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.id} · ${profile.apiKey ? localize(language, "已有本地 Key", "local key saved") : profile.apiKeyEnv ? `${localize(language, "环境变量", "environment")}: ${profile.apiKeyEnv}` : localize(language, "未配置 Key", "no key configured")}`,
      value: profile.id,
    })), language);
    if (!selected) {
      console.log(chalk.dim(localize(language, "已取消 Key 配置。\n", "Key configuration cancelled.\n")));
      return true;
    }
    try {
      const apiKey = await askSecret(localize(language, "输入 API Key（输入内容不会显示）：", "API key (input is hidden): "));
      if (!apiKey) throw new Error(localize(language, "API Key 不能为空。", "API key cannot be empty."));
      await providerRegistry.setApiKey(selected, apiKey);
      console.log(chalk.green(localize(language, `Key 已保存到本机 Xiu 配置，正在测试 ${selected}……`, `Key saved in the local Xiu configuration. Testing ${selected}...`)));
      if (selected === config.providerId) await switchProviderProfile(providerRegistry.get(selected)!, true, config.model);
      else console.log(chalk.dim(localize(language, "切换到该 Provider 时会使用此 Key。\n", "This key will be used when that provider is selected.\n")));
    } catch (error) {
      console.error(chalk.red(`${localize(language, "保存 Key 失败", "Could not save key")}: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  if (task === "/provider add") {
    console.log(chalk.cyan(localize(language, "添加 Provider（Key 可保存在本机配置，也可使用环境变量）", "Add a provider (save the key locally or use an environment variable)")));
    try {
      // Generic kinds first, then hosted OpenAI-compatible vendor presets, then a blank compatible endpoint.
      const templates = providerTemplates();
      const choice = await selectTerminalOption<string>(localize(language, "渠道类型或厂商模板", "Provider type or vendor template"), [
        ...templates.map((template) => ({
          label: template.preset === "vendor" ? `${template.name}（OpenAI 兼容）` : template.kind,
          description: template.preset === "vendor" ? `${template.baseURL} · ${template.model}` : template.baseURL ?? template.model,
          value: template.id,
        })),
        { label: "openai-compatible", description: localize(language, "自定义 OpenAI 兼容地址", "Custom OpenAI-compatible endpoint"), value: "openai-compatible" },
      ], language);
      if (!choice) return true;
      const template = templates.find((item) => item.id === choice);
      const kind = template?.kind ?? "openai-compatible";
      const suggestedId = template && !providerRegistry.get(template.id) ? template.id : "";
      const id = (await askQuestion(localize(language, `Provider ID${suggestedId ? ` [${suggestedId}]` : ""}：`, `Provider ID${suggestedId ? ` [${suggestedId}]` : ""}: `))).trim() || suggestedId;
      if (!id) throw new Error(localize(language, "Provider ID 不能为空。", "Provider ID is required."));
      if (providerRegistry.get(id)) throw new Error(localize(language, "Provider ID 已存在。", "Provider ID already exists."));
      const name = (await askQuestion(localize(language, `显示名称 [${template?.name ?? id}]：`, `Display name [${template?.name ?? id}]: `))).trim() || template?.name || id;
      const baseURL = (await askQuestion(localize(language, `API Base URL [${template?.baseURL ?? "默认"}]：`, `API base URL [${template?.baseURL ?? "default"}]: `))).trim() || template?.baseURL;
      const model = (await askQuestion(localize(language, `默认模型 ID [${template?.model ?? ""}]：`, `Default model ID [${template?.model ?? ""}]: `))).trim() || template?.model || "";
      // Generic kinds stay free of environment variables, as in the desktop onboarding; vendor presets suggest the usual name.
      const envDefault = template?.preset === "vendor" ? template.apiKeyEnv : undefined;
      const envText = (await askQuestion(localize(language, `密钥环境变量名${envDefault ? ` [${envDefault}]` : "（本地无认证可留空）"}：`, `API-key environment variable${envDefault ? ` [${envDefault}]` : " (blank for unauthenticated local servers)"}: `))).trim();
      const apiKeyEnv = envText === "-" ? undefined : envText || envDefault;
      const apiKey = await askSecret(localize(language, "本地保存的 API Key（可留空，输入内容不会显示）：", "Locally saved API key (optional; input is hidden): ")) || undefined;
      const contextText = (await askQuestion(localize(language, "上下文窗口 Token 数（留空使用 128K）：", "Context-window tokens (blank for 128K): "))).trim();
      const visionText = (await askQuestion(localize(language, "该端点和模型确认支持视觉？[y/N]：", "Does this endpoint and model definitely support vision? [y/N]: "))).trim();
      const profile: ProviderProfile = {
        id, name, kind, model, baseURL, apiKeyEnv, apiKey,
        contextWindow: contextText ? Number(contextText) : template?.contextWindow,
        capabilityModels: template?.capabilityModels,
        features: { ...(template?.features ?? { text: true, tools: true, image: false, video: false }), vision: /^(y|yes)$/i.test(visionText) },
      };
      await providerRegistry.upsert(profile);
      if (!providerRegistry.activeId()) await providerRegistry.setActive(id, model);
      console.log(chalk.green(localize(language, `已保存 Provider ${id}。正在进行连接测试……`, `Saved provider ${id}. Testing the connection...`)));
      await switchProviderProfile(providerRegistry.get(id)!);
    } catch (error) {
      console.error(chalk.red(`${localize(language, "添加 Provider 失败", "Could not add provider")}: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  if (task === "/provider edit") {
    const editable = providerRegistry.list().filter((profile) => !profile.builtin);
    if (!editable.length) {
      console.log(chalk.dim(localize(language, "没有可编辑的自定义 Provider。请先使用 /provider add 添加。\n", "There are no custom providers to edit. Add one with /provider add first.\n")));
      return true;
    }
    const selected = await selectTerminalOption(localize(language, "编辑哪个 Provider？", "Edit which provider?"), editable.map((profile) => ({
      label: profile.name, description: `${profile.id} · ${profile.model} · ${profile.baseURL ?? ""}`, value: profile.id,
    })), language);
    if (!selected) {
      console.log(chalk.dim(localize(language, "已取消编辑。\n", "Editing cancelled.\n")));
      return true;
    }
    const current = providerRegistry.get(selected)!;
    console.log(chalk.cyan(localize(language, "直接回车保留当前值；环境变量名或上下文窗口输入 - 可清空。本地 Key 请使用 /provider key 单独修改。", "Press Enter to keep the current value. Enter - to clear the environment variable or context window. Use /provider key to change the local key.")));
    try {
      const nameText = (await askQuestion(localize(language, `显示名称 [${current.name}]：`, `Display name [${current.name}]: `))).trim();
      const baseURLText = (await askQuestion(localize(language, `API Base URL [${current.baseURL ?? ""}]：`, `API base URL [${current.baseURL ?? ""}]: `))).trim();
      const modelText = (await askQuestion(localize(language, `默认模型 ID [${current.model}]：`, `Default model ID [${current.model}]: `))).trim();
      const envText = (await askQuestion(localize(language, `密钥环境变量名 [${current.apiKeyEnv ?? "未设置"}]：`, `API-key environment variable [${current.apiKeyEnv ?? "not set"}]: `))).trim();
      const contextText = (await askQuestion(localize(language, `上下文窗口 Token 数 [${current.contextWindow ?? "默认"}]：`, `Context-window tokens [${current.contextWindow ?? "default"}]: `))).trim();
      const visionDefault = current.features.vision ? "Y/n" : "y/N";
      const visionText = (await askQuestion(localize(language, `确认支持视觉？[${visionDefault}]：`, `Confirmed vision support? [${visionDefault}]: `))).trim();
      const updated: ProviderProfile = {
        ...current,
        name: nameText || current.name,
        baseURL: baseURLText || current.baseURL,
        model: modelText || current.model,
        apiKeyEnv: envText === "-" ? undefined : envText || current.apiKeyEnv,
        contextWindow: contextText === "-" ? undefined : contextText ? Number(contextText) : current.contextWindow,
        features: {
          ...current.features,
          vision: visionText ? /^(y|yes)$/i.test(visionText) : current.features.vision,
        },
      };
      await providerRegistry.upsert(updated);
      const saved = providerRegistry.get(selected)!;
      console.log(chalk.green(localize(language, `已更新 Provider ${selected}，本地 Key 保持不变。正在测试连接……`, `Updated provider ${selected}; the local key was preserved. Testing the connection...`)));
      if (selected === config.providerId) await switchProviderProfile(saved, true, saved.model);
      else {
        status.start(localize(language, `正在测试 ${saved.name} 连接`, `Testing ${saved.name}`));
        const probe = await probeProvider(profileConfig(saved));
        status.stop();
        console.log(chalk.green(localize(language, `连接成功：${saved.name}。`, `Connected successfully: ${saved.name}.`)));
        if (probe.discoveryError) console.log(chalk.dim(localize(language, "模型列表接口不可用；已通过最小聊天请求验证连接。\n", "The model-list endpoint is unavailable; connection verified with a minimal chat request.\n")));
        else console.log();
      }
    } catch (error) {
      status.stop();
      console.error(chalk.red(`${localize(language, "编辑 Provider 失败", "Could not edit provider")}: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  if (task === "/provider remove") {
    const removable = providerRegistry.list().filter((profile) => !profile.builtin);
    if (!removable.length) {
      console.log(chalk.dim(localize(language, "没有可删除的自定义 Provider。\n", "There are no custom providers to remove.\n")));
      return true;
    }
    const selected = await selectTerminalOption(localize(language, "删除哪个 Provider？", "Remove which provider?"), removable.map((profile) => ({
      label: profile.name, description: `${profile.id} · ${profile.baseURL ?? ""}`, value: profile.id,
    })), language);
    if (!selected) {
      console.log(chalk.dim(localize(language, "已取消删除。\n", "Removal cancelled.\n")));
      return true;
    }
    const confirmed = await askQuestion(localize(language, `确认删除 ${selected} 的渠道配置和本机凭据？[y/N]：`, `Remove ${selected} and its local credential? [y/N]: `));
    if (!/^(y|yes)$/i.test(confirmed.trim())) return true;
    await providerRegistry.remove(selected);
    if (selected === config.providerId) {
      const nextConfig = profileConfig(UNCONFIGURED_PROVIDER_PROFILE);
      await agent.replaceProvider(nextConfig, { async complete(): Promise<never> { throw new Error(localize(language, "请使用 /provider add 或 /providers 配置渠道。", "Use /provider add or /providers to configure a Provider.")); } });
      rebuildBaseTools();
      attachMcpTools();
    }
    console.log(chalk.green(localize(language, `已删除 Provider ${selected}。\n`, `Removed provider ${selected}.\n`)));
    return true;
  }
  return false;
}
