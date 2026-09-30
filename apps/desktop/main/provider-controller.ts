import type { CredentialStore } from "../../../src/credential-store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { selectableCapabilityModels, selectableModels } from "../../../src/model-catalog.js";
import { ProviderRegistry, resolveStartupModel, type ProviderProfile } from "../../../src/provider-registry.js";
import { createProvider, probeProvider } from "../../../src/providers.js";
import { redactSecrets } from "../../../src/secret-redaction.js";
import { createWindowsSystemCredentialStore } from "../../../src/system-credential-store.js";
import { createWorkspaceProviderConfig } from "../../../src/runtime/workspace-agent-host.js";
import type { AvailableModel } from "../../../src/types.js";
import type {
  DesktopProviderCredentialRequest,
  DesktopProviderDeleteRequest,
  DesktopProviderModelsRequest,
  DesktopProviderSelectRequest,
  DesktopProviderSnapshot,
  DesktopProviderTestRequest,
  DesktopProviderTestResult,
  DesktopProviderUpsertRequest,
} from "../shared/protocol.js";

type ProviderRegistryLike = Pick<ProviderRegistry,
  "list" | "get" | "activeId" | "activeModel" | "credentialInfo" | "credentialRevision" | "setActive" | "setCapabilityModel" | "setApiKey" | "migrateApiKeysToSystem" | "cleanupLegacyApiKey" | "upsert" | "remove"
>;

interface ProviderControllerDependencies {
  registry?: ProviderRegistryLike;
  systemCredentialStore?: CredentialStore<string, "provider-api-key">;
  discover?: (profile: ProviderProfile, model: string, workspace: string, revision: number) => Promise<AvailableModel[]>;
  test?: (profile: ProviderProfile, model: string, workspace: string, revision: number) => Promise<number>;
  modelCacheFile?: string;
}

const KEY_OPTIONAL = new Set(["ollama", "lmstudio", "vllm"]);

export class DesktopProviderController {
  private readonly discovered = new Map<string, AvailableModel[]>();

  private constructor(
    private readonly registry: ProviderRegistryLike,
    private readonly systemCredentialStore: ProviderControllerDependencies["systemCredentialStore"],
    private readonly discoverModels: NonNullable<ProviderControllerDependencies["discover"]>,
    private readonly testConnection: NonNullable<ProviderControllerDependencies["test"]>,
    private readonly modelCacheFile?: string,
  ) {}

  static async create(dependencies: ProviderControllerDependencies = {}): Promise<DesktopProviderController> {
    let systemCredentialStore = dependencies.systemCredentialStore;
    if (!dependencies.registry && !systemCredentialStore) {
      try { systemCredentialStore = await createWindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key"); }
      catch { /* Saving new desktop credentials will fail closed; environment and existing legacy credentials remain readable. */ }
    }
    const registry = dependencies.registry ?? new ProviderRegistry(undefined, systemCredentialStore);
    if (!dependencies.registry) await (registry as ProviderRegistry).load();
    const config = (profile: ProviderProfile, model: string, workspace: string, revision: number) =>
      createWorkspaceProviderConfig(profile, model, workspace, revision, "zh-CN");
    const controller = new DesktopProviderController(
      registry,
      systemCredentialStore,
      dependencies.discover ?? (async (profile, model, workspace, revision) => {
        const provider = createProvider(config(profile, model, workspace, revision));
        return provider.listModels ? provider.listModels() : [];
      }),
      dependencies.test ?? (async (profile, model, workspace, revision) => {
        const result = await probeProvider(config(profile, model, workspace, revision));
        return result.models.length;
      }),
      dependencies.modelCacheFile ?? (dependencies.registry ? undefined : path.join(os.homedir(), ".xiu", "desktop-model-catalog.json")),
    );
    await controller.loadModelCache();
    return controller;
  }

  snapshot(providerId?: string, discoveryError?: string): DesktopProviderSnapshot {
    const allProfiles = this.registry.list();
    const activeProviderId = this.registry.activeId() && this.registry.get(this.registry.activeId()!)
      ? this.registry.activeId()!
      : "openai";
    const activeProfile = this.registry.get(activeProviderId) ?? allProfiles[0]!;
    const activeModel = this.registry.activeModel(activeProfile.id) ?? activeProfile.model;
    const modelProfile = this.registry.get(providerId ?? activeProviderId) ?? activeProfile;
    const model = this.registry.activeModel(modelProfile.id) ?? modelProfile.model;
    const credentials = new Map(this.registry.credentialInfo().map((item) => [item.providerId, item]));
    const profiles = allProfiles.filter((profile) => {
      const source = credentials.get(profile.id)?.source ?? "missing";
      const hasCredential = source !== "missing";
      const hasDiscoveredModels = (this.discovered.get(profile.id)?.length ?? 0) > 0;
      return profile.id === activeProviderId
        || hasCredential
        || hasDiscoveredModels
        || (!profile.builtin && KEY_OPTIONAL.has(profile.kind));
    }).sort((left, right) => left.id === activeProviderId ? -1 : right.id === activeProviderId ? 1 : left.name.localeCompare(right.name, "zh-CN"));
    const modelsByProvider = Object.fromEntries(profiles.map((profile) => {
      const selected = this.registry.activeModel(profile.id) ?? profile.model;
      return [profile.id, this.modelOptions(profile, selected)];
    }));
    const capabilityModelsByProvider = Object.fromEntries(profiles.map((profile) => [profile.id, {
      vision: selectableCapabilityModels("vision", profile.capabilityModels?.vision, this.discovered.get(profile.id) ?? []),
      image: selectableCapabilityModels("image", profile.capabilityModels?.image, this.discovered.get(profile.id) ?? []),
      video: selectableCapabilityModels("video", profile.capabilityModels?.video, this.discovered.get(profile.id) ?? []),
      audio: selectableCapabilityModels("audio", profile.capabilityModels?.audio, this.discovered.get(profile.id) ?? []),
    }]));
    const models = modelsByProvider[modelProfile.id] ?? [];
    return {
      activeProviderId,
      activeModel,
      modelProviderId: modelProfile.id,
      models,
      modelsByProvider,
      capabilityModelsByProvider,
      profiles: profiles.map((profile) => {
        const info = credentials.get(profile.id);
        const keyOptional = KEY_OPTIONAL.has(profile.kind);
        const source = keyOptional && (!info || info.source === "missing")
          ? "not-required"
          : info?.source ?? "missing";
        const configured = source !== "missing" && source !== "not-required"
          || (this.discovered.get(profile.id)?.length ?? 0) > 0;
        return {
          id: profile.id, name: profile.name, kind: profile.kind, defaultModel: profile.model,
          selectedModel: this.registry.activeModel(profile.id) ?? profile.model, builtin: Boolean(profile.builtin),
          ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
          ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
          ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {}),
          credential: { source, configured, editable: source !== "environment" && !keyOptional },
          capabilityModels: { ...(profile.capabilityModels ?? {}) },
          features: { tools: profile.features.tools, vision: profile.features.vision, image: profile.features.image, video: profile.features.video, audio: profile.features.audio === true },
        };
      }),
      ...(discoveryError ? { discoveryError } : {}),
    };
  }

  async discover(workspace: string, request: DesktopProviderModelsRequest): Promise<DesktopProviderSnapshot> {
    const profile = this.profile(request?.providerId);
    const model = this.registry.activeModel(profile.id) ?? profile.model;
    try {
      this.discovered.set(profile.id, await this.discoverModels(profile, model, workspace, this.registry.credentialRevision(profile.id)));
      await this.saveModelCache();
      return this.snapshot(profile.id);
    } catch (error) {
      return this.snapshot(profile.id, this.safeError(error, profile));
    }
  }

  async select(request: DesktopProviderSelectRequest): Promise<DesktopProviderSnapshot> {
    const profile = this.profile(request?.providerId);
    const model = this.model(request?.model);
    if (request?.capability) {
      if (!["vision", "image", "video", "audio"].includes(request.capability)) throw new Error("模型能力类型无效。");
      await this.registry.setCapabilityModel(profile.id, request.capability, model);
    } else {
      await this.registry.setActive(profile.id, model);
    }
    return this.snapshot(profile.id);
  }

  async saveCredential(request: DesktopProviderCredentialRequest): Promise<DesktopProviderSnapshot> {
    const profile = this.profile(request?.providerId);
    const apiKey = request?.apiKey;
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error("API Key 必须为 1–4096 个不含换行的字符。");
    const info = this.registry.credentialInfo().find((item) => item.providerId === profile.id);
    if (info?.source === "environment") throw new Error(`当前凭据来自环境变量 ${profile.apiKeyEnv ?? ""}，请在系统环境中修改。`);
    if (!this.systemCredentialStore && info?.source !== "system") throw new Error("Windows Credential Manager 不可用，桌面端拒绝把新凭据降级保存为明文文件。可改用环境变量或 CLI 的显式凭据流程。");
    const previous = profile.apiKey;
    try {
      await this.registry.setApiKey(profile.id, apiKey);
      if (info?.source !== "system") {
        await this.registry.migrateApiKeysToSystem([profile.id], this.systemCredentialStore!);
        await this.registry.cleanupLegacyApiKey(profile.id);
      }
    } catch (error) {
      if (info?.source !== "system") {
        try { await this.registry.setApiKey(profile.id, previous); } catch { /* Preserve the original failure without exposing credential material. */ }
      }
      throw new Error(this.safeError(error, profile));
    }
    return this.snapshot(profile.id);
  }

  async test(workspace: string, request: DesktopProviderTestRequest): Promise<DesktopProviderTestResult> {
    const profile = this.profile(request?.providerId);
    const model = this.model(request?.model ?? this.registry.activeModel(profile.id) ?? profile.model);
    try {
      const modelsDiscovered = await this.testConnection(profile, model, workspace, this.registry.credentialRevision(profile.id));
      return { ok: true, message: `${profile.name} / ${model} 连接成功。`, modelsDiscovered };
    } catch (error) {
      throw new Error(this.safeError(error, profile));
    }
  }

  async upsert(request: DesktopProviderUpsertRequest): Promise<DesktopProviderSnapshot> {
    const existingId = request?.existingId?.trim();
    const previous = existingId ? this.profile(existingId) : undefined;
    const requestedId = request?.id?.trim();
    if (existingId && existingId !== requestedId) throw new Error("编辑渠道时不能修改 Provider ID。");
    // ProviderRegistry historically accepted mixed-case IDs. Keep an existing ID
    // verbatim so those profiles remain editable without moving credential keys.
    const id = previous ? previous.id : this.providerId(request?.id);
    if (previous?.builtin) throw new Error("内置渠道不能覆盖；请新增一个自定义渠道。");
    if (!previous && this.registry.get(id)) throw new Error("Provider ID 已存在。");
    const name = this.shortText(request?.name, "渠道名称", 100);
    const model = this.model(request?.model);
    const kind = request?.kind;
    if (!["openai", "anthropic", "agnes", "openai-compatible", "ollama", "lmstudio", "vllm"].includes(kind)) throw new Error("Provider 类型无效。");
    const baseURL = this.baseURL(request?.baseURL, kind);
    const apiKeyEnv = request?.apiKeyEnv?.trim() ? this.environmentName(request.apiKeyEnv) : undefined;
    if (apiKeyEnv && request.apiKey) throw new Error("环境变量凭据和直接输入 Key 不能同时配置。");
    const contextWindow = request?.contextWindow === undefined ? undefined : this.contextWindow(request.contextWindow);
    const features = request?.features;
    if (!features || [features.tools, features.vision, features.image, features.video].some((value) => typeof value !== "boolean") || (features.audio !== undefined && typeof features.audio !== "boolean")) throw new Error("渠道能力配置无效。");
    const normalizedFeatures = { ...features, audio: features.audio === true };
    const capabilityModelEntries = Object.entries(request.capabilityModels ?? {});
    if (capabilityModelEntries.some(([capability, value]) => !["vision", "image", "video", "audio"].includes(capability) || typeof value !== "string")) throw new Error("能力模型配置无效。");
    const capabilityModels = Object.fromEntries(capabilityModelEntries.map(([capability, value]) => [capability, this.model(value as string)])) as ProviderProfile["capabilityModels"];
    for (const capability of ["vision", "image", "video", "audio"] as const) {
      if (normalizedFeatures[capability] && !capabilityModels?.[capability] && capability !== "vision") throw new Error(`请为 ${capability} 能力选择模型。`);
    }
    const profile: ProviderProfile = {
      id, name, kind, model, ...(baseURL ? { baseURL } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(contextWindow ? { contextWindow } : {}), ...(Object.keys(capabilityModels ?? {}).length ? { capabilityModels } : {}), features: { text: true, ...normalizedFeatures },
    };
    try {
      await this.registry.upsert(profile);
      if (request.apiKey) await this.saveCredential({ providerId: id, apiKey: request.apiKey });
    } catch (error) {
      try { if (previous) await this.registry.upsert(previous); else await this.registry.remove(id); } catch { /* Keep the original safe failure. */ }
      throw new Error(this.safeError(error, previous ?? profile));
    }
    return this.snapshot(id);
  }

  async delete(request: DesktopProviderDeleteRequest): Promise<DesktopProviderSnapshot> {
    if (request?.confirmed !== true) throw new Error("删除渠道需要明确确认。");
    const profile = this.profile(request?.providerId);
    if (profile.builtin) throw new Error("内置渠道不能删除。");
    if (this.registry.activeId() === profile.id) throw new Error("请先切换到其他渠道，再删除当前渠道。");
    await this.registry.remove(profile.id);
    this.discovered.delete(profile.id);
    await this.saveModelCache();
    return this.snapshot();
  }

  private profile(id: string | undefined): ProviderProfile {
    if (typeof id !== "string" || id.length > 63) throw new Error("Provider ID 无效。");
    const profile = this.registry.get(id);
    if (!profile) throw new Error("Provider 不存在或已被移除。");
    return profile;
  }

  private model(value: string | undefined): string {
    if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error("模型 ID 必须为 1–200 个字符。");
    return value.trim();
  }

  private providerId(value: string | undefined): string {
    const id = value?.trim();
    if (!id || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(id)) throw new Error("Provider ID 只能使用小写字母、数字、点、横线和下划线，最长 63 个字符。");
    return id;
  }

  private shortText(value: string | undefined, label: string, maximum: number): string {
    const text = value?.trim();
    if (!text || text.length > maximum || /[\r\n\0]/.test(text)) throw new Error(`${label}必须为 1–${maximum} 个字符。`);
    return text;
  }

  private environmentName(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error("环境变量名称无效。");
    return value;
  }

  private contextWindow(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 10_000_000) throw new Error("上下文窗口必须为 1,000–10,000,000 的整数。");
    return value;
  }

  private baseURL(value: string | undefined, kind: DesktopProviderUpsertRequest["kind"]): string | undefined {
    if (!value?.trim()) {
      if (["openai-compatible", "ollama", "lmstudio", "vllm"].includes(kind)) throw new Error("该渠道类型必须配置 Base URL。");
      return undefined;
    }
    let parsed: URL;
    try { parsed = new URL(value.trim()); } catch { throw new Error("Base URL 格式无效。"); }
    if (parsed.username || parsed.password || parsed.hash) throw new Error("Base URL 不能包含凭据或片段。");
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("Base URL 必须使用 HTTPS；仅本机回环地址允许 HTTP。");
    return parsed.toString().replace(/\/$/, "");
  }

  private safeError(error: unknown, profile: ProviderProfile): string {
    return redactSecrets(error instanceof Error ? error.message : String(error), profile.apiKey ? [profile.apiKey] : []).slice(0, 800);
  }

  private modelOptions(profile: ProviderProfile, selected: string) {
    return selectableModels(profile.kind, selected, this.discovered.get(profile.id) ?? [], "zh-CN")
      .map(({ id, name, description, source, contextWindow }) => ({ id, name, description, source, contextWindow }));
  }

  private async loadModelCache(): Promise<void> {
    if (!this.modelCacheFile) return;
    try {
      const stat = await fs.lstat(this.modelCacheFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) return;
      const parsed = JSON.parse(await fs.readFile(this.modelCacheFile, "utf8")) as { version?: unknown; providers?: unknown };
      if (parsed.version !== 1 || !parsed.providers || typeof parsed.providers !== "object") return;
      for (const [providerId, value] of Object.entries(parsed.providers as Record<string, unknown>)) {
        if (!this.registry.get(providerId) || !Array.isArray(value)) continue;
        const models = value.slice(0, 500).flatMap((item): AvailableModel[] => {
          if (!item || typeof item !== "object") return [];
          const model = item as Partial<AvailableModel>;
          if (typeof model.id !== "string" || !model.id || model.id.length > 200) return [];
          const capabilities = Array.isArray(model.capabilities)
            ? [...new Set(model.capabilities.filter((item): item is string => typeof item === "string" && ["text", "vision", "image", "video", "audio"].includes(item)))].slice(0, 5)
            : undefined;
          return [{ id: model.id, ...(typeof model.name === "string" ? { name: model.name.slice(0, 200) } : {}), ...(typeof model.description === "string" ? { description: model.description.slice(0, 500) } : {}), source: "api", ...(capabilities?.length ? { capabilities } : {}), ...(Number.isSafeInteger(model.contextWindow) && model.contextWindow! > 0 ? { contextWindow: model.contextWindow } : {}) }];
        });
        if (models.length) this.discovered.set(providerId, models);
      }
    } catch { /* A missing or invalid public model cache is safely ignored. */ }
  }

  private async saveModelCache(): Promise<void> {
    if (!this.modelCacheFile) return;
    const directory = path.dirname(this.modelCacheFile);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await fs.lstat(this.modelCacheFile).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("模型目录缓存路径不安全。");
    const providers = Object.fromEntries([...this.discovered].map(([id, models]) => [id, models.slice(0, 500)]));
    const temporary = path.join(directory, `.${path.basename(this.modelCacheFile)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, providers })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.modelCacheFile);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}
