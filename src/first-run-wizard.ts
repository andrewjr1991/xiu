import type { ProviderName } from "./config.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { SelectOption } from "./interactive-ui.js";
import { type ProviderProfile, type ProviderRegistry, type ProviderTemplate, providerTemplates } from "./provider-registry.js";
import type { AvailableModel } from "./types.js";
import { formatUserFacingError } from "./user-facing-errors.js";

/**
 * Three-step first-run wizard shown when the CLI starts without any provider.
 *
 * Nothing is written to `providers.json` until the connection test has passed,
 * so cancelling at any step (Esc, blank answer, Ctrl-C) leaves no half-finished
 * channel behind. The wizard never reads an API key from the environment on its
 * own: an environment variable is only used when the user picks the matching
 * "detected" entry, and even then only the variable name is stored.
 */

export interface FirstRunWizardIo {
  select<T>(title: string, options: SelectOption<T>[]): Promise<T | undefined>;
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  log(line: string): void;
}

export interface FirstRunWizardProbe {
  models: AvailableModel[];
  discoveryError?: string;
}

export interface FirstRunWizardOptions {
  language: UiLanguage;
  registry: Pick<ProviderRegistry, "get" | "upsert" | "setActive" | "remove">;
  env: NodeJS.ProcessEnv;
  /** Verifies an unsaved profile; throws on failure. */
  probe: (profile: ProviderProfile) => Promise<FirstRunWizardProbe>;
  /** Switches the running session to the saved profile; returns false when that fails. */
  activate: (profile: ProviderProfile, model: string) => Promise<boolean>;
  io: FirstRunWizardIo;
  templates?: ProviderTemplate[];
}

export type FirstRunWizardResult =
  | { status: "configured"; providerId: string; model: string }
  | { status: "skipped" }
  | { status: "cancelled" };

type Choice = { type: "template"; template: ProviderTemplate; useEnv: boolean } | { type: "custom" } | { type: "later" };

const LOCAL_KINDS = new Set<ProviderName>(["ollama", "lmstudio", "vllm"]);
const CUSTOM_ID = "custom";

function stepTitle(language: UiLanguage, step: number, zh: string, en: string): string {
  return localize(language, `第 ${step}/3 步 · ${zh}`, `Step ${step}/3 · ${en}`);
}

function uniqueProviderId(registry: FirstRunWizardOptions["registry"], base: string): string {
  if (!registry.get(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!registry.get(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function describeTemplate(template: ProviderTemplate): string {
  if (template.preset === "vendor") return `${template.baseURL} · ${template.model}`;
  if (LOCAL_KINDS.has(template.kind)) return template.baseURL ?? template.model;
  return template.baseURL ? `${template.baseURL} · ${template.model}` : template.model;
}

async function chooseChannel(options: FirstRunWizardOptions, templates: ProviderTemplate[]): Promise<Choice | undefined> {
  const { language, env, io } = options;
  const detected = templates.filter((template) => template.apiKeyEnv && env[template.apiKeyEnv]);
  const entries: SelectOption<string>[] = [
    ...detected.map((template) => ({
      label: localize(language, `${template.name} · 检测到 ${template.apiKeyEnv}`, `${template.name} · ${template.apiKeyEnv} detected`),
      description: localize(language, "直接使用这个环境变量，不保存 Key", "Use this environment variable; no key is saved"),
      value: `env:${template.id}`,
    })),
    ...templates.map((template) => ({
      label: template.preset === "vendor" ? localize(language, `${template.name}（OpenAI 兼容）`, `${template.name} (OpenAI-compatible)`) : template.name,
      description: describeTemplate(template),
      value: `template:${template.id}`,
    })),
    { label: localize(language, "自定义 OpenAI 兼容服务", "Custom OpenAI-compatible service"), description: localize(language, "自己填写地址与模型", "Enter the base URL and model yourself"), value: CUSTOM_ID },
    { label: localize(language, "稍后配置", "Configure later"), description: localize(language, "先进入 xiu>，之后用 /provider add 添加", "Go to xiu> now and add a provider later with /provider add"), value: "later" },
  ];
  const picked = await io.select(stepTitle(language, 1, "选择渠道（Esc 退出向导）", "Choose a provider (Esc leaves the wizard)"), entries);
  if (!picked) return undefined;
  if (picked === "later") return { type: "later" };
  if (picked === CUSTOM_ID) return { type: "custom" };
  const [mode, id] = picked.split(":", 2);
  const template = templates.find((item) => item.id === id);
  if (!template) return undefined;
  return { type: "template", template, useEnv: mode === "env" };
}

interface Draft {
  profile: ProviderProfile;
  /** Chat models the user may pick from after discovery when the template has no fixed default. */
  pickModel: boolean;
}

async function fillConnection(options: FirstRunWizardOptions, choice: Exclude<Choice, { type: "later" }>): Promise<Draft | undefined> {
  const { language, io, registry } = options;
  const title = stepTitle(language, 2, "填写连接信息（直接回车返回上一步）", "Connection details (press Enter on an empty line to go back)");
  io.log(title);
  if (choice.type === "custom") {
    const baseURL = (await io.ask(localize(language, "API Base URL（例如 https://example.com/v1）：", "API base URL (for example https://example.com/v1): "))).trim();
    if (!baseURL) return undefined;
    const model = (await io.ask(localize(language, "模型 ID：", "Model ID: "))).trim();
    if (!model) return undefined;
    const apiKey = (await io.askSecret(localize(language, "API Key（可留空，输入内容不会显示）：", "API key (optional; input is hidden): "))).trim() || undefined;
    return {
      pickModel: false,
      profile: { id: uniqueProviderId(registry, CUSTOM_ID), name: localize(language, "自定义服务", "Custom service"), kind: "openai-compatible", model, baseURL, apiKey, features: { text: true, tools: true, vision: false, image: false, video: false } },
    };
  }
  const { template, useEnv } = choice;
  const base: ProviderProfile = {
    id: uniqueProviderId(registry, template.id),
    name: template.name,
    kind: template.kind,
    model: template.model,
    baseURL: template.baseURL,
    contextWindow: template.contextWindow,
    capabilityModels: template.capabilityModels,
    features: { ...template.features },
  };
  if (LOCAL_KINDS.has(template.kind)) {
    const answer = (await io.ask(localize(language, `服务地址 [${template.baseURL}]（输入 - 返回）：`, `Server URL [${template.baseURL}] (type - to go back): `))).trim();
    if (answer === "-") return undefined;
    return { pickModel: true, profile: { ...base, baseURL: answer || template.baseURL } };
  }
  if (useEnv && template.apiKeyEnv) {
    io.log(localize(language, `将使用环境变量 ${template.apiKeyEnv}，Xiu 只记录变量名。`, `Xiu will read ${template.apiKeyEnv} at startup and store only the variable name.`));
    return { pickModel: false, profile: { ...base, apiKeyEnv: template.apiKeyEnv } };
  }
  const apiKey = (await io.askSecret(localize(language, `${template.name} 的 API Key（输入内容不会显示，直接回车返回上一步）：`, `API key for ${template.name} (input is hidden; press Enter to go back): `))).trim();
  if (!apiKey) return undefined;
  return { pickModel: false, profile: { ...base, apiKey } };
}

async function chooseModel(options: FirstRunWizardOptions, draft: Draft, models: AvailableModel[]): Promise<string | undefined> {
  const { language, io } = options;
  const ids = [...new Set(models.map((model) => model.id).filter(Boolean))];
  const placeholder = draft.profile.model === "local-model";
  if (!ids.length) return placeholder ? undefined : draft.profile.model;
  if (!draft.pickModel && ids.includes(draft.profile.model)) return draft.profile.model;
  if (ids.length === 1 && placeholder) return ids[0];
  const entries: SelectOption<string>[] = [
    ...(placeholder ? [] : [{ label: localize(language, `保留 ${draft.profile.model}`, `Keep ${draft.profile.model}`), description: localize(language, "模板默认模型，不在服务返回的列表里", "Template default; not in the list the service returned"), value: draft.profile.model }]),
    ...ids.map((id) => ({ label: id, value: id })),
  ];
  return io.select(stepTitle(language, 3, `选择模型（服务返回了 ${ids.length} 个）`, `Choose a model (${ids.length} returned by the service)`), entries);
}

async function afterFailure(options: FirstRunWizardOptions): Promise<"retry" | "reselect" | "later" | undefined> {
  const { language, io } = options;
  return io.select<"retry" | "reselect" | "later">(localize(language, "连接没有成功，未保存任何配置", "The connection failed; nothing was saved"), [
    { label: localize(language, "重新输入", "Enter the details again"), description: localize(language, "回到第 2 步", "Back to step 2"), value: "retry" },
    { label: localize(language, "换一个渠道", "Choose another provider"), description: localize(language, "回到第 1 步", "Back to step 1"), value: "reselect" },
    { label: localize(language, "稍后配置", "Configure later"), description: localize(language, "先进入 xiu>，之后用 /provider add 添加", "Go to xiu> now and add a provider later with /provider add"), value: "later" },
  ]);
}

export async function runFirstRunWizard(options: FirstRunWizardOptions): Promise<FirstRunWizardResult> {
  const { language, io, registry } = options;
  const templates = options.templates ?? providerTemplates();
  io.log(localize(language,
    "欢迎使用 Xiu。还没有任何模型渠道，三步即可开始：选择渠道 → 填写连接信息 → 自动测试连接并拉取模型列表。",
    "Welcome to Xiu. No model provider is configured yet. Three steps get you started: choose a provider → enter the connection details → Xiu tests the connection and lists the models."));
  try {
    let choice: Choice | undefined;
    for (;;) {
      choice ??= await chooseChannel(options, templates);
      if (!choice) return { status: "cancelled" };
      if (choice.type === "later") return { status: "skipped" };
      const draft = await fillConnection(options, choice);
      if (!draft) { choice = undefined; continue; }

      io.log(stepTitle(language, 3, `正在测试 ${draft.profile.name} 连接……`, `Testing the connection to ${draft.profile.name}…`));
      let probe: FirstRunWizardProbe;
      try {
        probe = await options.probe(draft.profile);
      } catch (error) {
        io.log(formatUserFacingError(localize(language, "连接测试失败", "Connection test failed"), error, language, { sensitive: draft.profile.apiKey ? [draft.profile.apiKey] : [], diagnostic: "/provider test" }));
        const next = await afterFailure(options);
        if (next === "retry") continue;
        if (next === "reselect") { choice = undefined; continue; }
        return next === "later" ? { status: "skipped" } : { status: "cancelled" };
      }

      const model = await chooseModel(options, draft, probe.models);
      if (!model) {
        io.log(localize(language, "服务没有返回可用模型，请确认已加载模型后重试。", "The service returned no models; load a model and try again."));
        const next = await afterFailure(options);
        if (next === "retry") continue;
        if (next === "reselect") { choice = undefined; continue; }
        return next === "later" ? { status: "skipped" } : { status: "cancelled" };
      }

      const profile: ProviderProfile = { ...draft.profile, model };
      await registry.upsert(profile);
      await registry.setActive(profile.id, model);
      const saved = registry.get(profile.id) ?? profile;
      if (!(await options.activate(saved, model))) {
        await registry.remove(profile.id).catch(() => undefined);
        io.log(localize(language, "切换到新渠道失败，已撤销刚保存的配置。", "Switching to the new provider failed; the configuration just saved was removed."));
        const next = await afterFailure(options);
        if (next === "retry") continue;
        if (next === "reselect") { choice = undefined; continue; }
        return next === "later" ? { status: "skipped" } : { status: "cancelled" };
      }
      if (probe.discoveryError) io.log(localize(language, "该服务没有模型列表接口，已通过最小聊天请求验证连接。", "The service has no model-list endpoint; the connection was verified with a minimal chat request."));
      io.log(localize(language,
        `渠道 ${profile.name}（${profile.id}）已保存并设为当前渠道。以后可用 /providers 切换、/provider key 更新 Key、/provider add 再添加。`,
        `Provider ${profile.name} (${profile.id}) is saved and active. Use /providers to switch, /provider key to update the key, and /provider add to add more.`));
      return { status: "configured", providerId: profile.id, model };
    }
  } catch (error) {
    // Ctrl-C inside the hidden key prompt rejects; treat every unexpected prompt failure as leaving the wizard.
    if (error instanceof Error && /cancelled/i.test(error.message)) return { status: "cancelled" };
    throw error;
  }
}
