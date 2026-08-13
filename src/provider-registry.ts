import fs from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ProviderName } from "./config.js";
import type { CapabilityProbeState, ModelCapabilityProbe } from "./capability-probe.js";
import { LegacyCredentialStore, credentialRef, readEnvironmentCredential, type CredentialBackendStatus, type CredentialRef, type CredentialStore } from "./credential-store.js";
import { isProviderRoutingPhase, type ProviderRoutingPhase, type ProviderRoutingPolicy } from "./provider-routing.js";

export interface ProviderFeatures {
  text: true;
  tools: boolean;
  vision: boolean;
  image: boolean;
  video: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderName;
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  /** Plaintext local credential. Never copy this value into project sessions or terminal output. */
  apiKey?: string;
  proxy?: string;
  contextWindow?: number;
  features: ProviderFeatures;
  builtin?: boolean;
}

export interface ProviderCredentialMigrationReceipt {
  providerId: string;
  from: CredentialRef<"provider-api-key">;
  to: CredentialRef<"provider-api-key">;
  migratedAt: string;
  legacyCopyPresent: boolean;
}

interface ProviderCredentialMigrationIntent {
  providerId: string;
  from: CredentialRef<"provider-api-key">;
  to: CredentialRef<"provider-api-key">;
  preparedAt: string;
}

export interface ProviderCredentialInfo {
  providerId: string;
  providerName: string;
  source: "environment" | "system" | "legacy-file" | "missing";
  legacyCopyPresent: boolean;
  systemCopyPresent: boolean;
  interruptedMigration: boolean;
  migration?: ProviderCredentialMigrationReceipt;
}

interface ProviderFile {
  version: 3;
  active?: string;
  activeModels?: Record<string, string>;
  failoverChains?: Record<string, string[]>;
  routing?: ProviderRoutingPolicy;
  profiles: ProviderProfile[];
  credentials?: Record<string, string>;
  credentialRevisions?: Record<string, number>;
  credentialRefs?: Record<string, CredentialRef<"provider-api-key">>;
  credentialMigrations?: Record<string, ProviderCredentialMigrationReceipt>;
  credentialMigrationIntents?: Record<string, ProviderCredentialMigrationIntent>;
  probes?: ModelCapabilityProbe[];
}

function probeFingerprint(profile: ProviderProfile, model: string): string {
  return createHash("sha256").update(JSON.stringify({
    id: profile.id,
    kind: profile.kind,
    model,
    baseURL: profile.baseURL,
    apiKeyEnv: profile.apiKeyEnv,
    proxy: profile.proxy,
    contextWindow: profile.contextWindow,
    features: profile.features,
  })).digest("hex").slice(0, 24);
}

const textAndTools = (): ProviderFeatures => ({ text: true, tools: true, vision: false, image: false, video: false });

export const BUILTIN_PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: "agnes", name: "Agnes", kind: "agnes", model: "agnes-2.5-flash",
    baseURL: "https://apihub.agnes-ai.com/v1", apiKeyEnv: "AGNES_API_KEY",
    features: { text: true, tools: true, vision: true, image: true, video: true }, builtin: true,
  },
  {
    id: "openai", name: "OpenAI", kind: "openai", model: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
    features: { text: true, tools: true, vision: true, image: false, video: false }, builtin: true,
  },
  {
    id: "anthropic", name: "Anthropic", kind: "anthropic", model: "claude-sonnet-4-20250514",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    features: { text: true, tools: true, vision: true, image: false, video: false }, builtin: true,
  },
  {
    id: "ollama", name: "Ollama (local)", kind: "ollama", model: "local-model",
    baseURL: "http://127.0.0.1:11434/v1", features: textAndTools(), builtin: true,
  },
  {
    id: "lmstudio", name: "LM Studio (local)", kind: "lmstudio", model: "local-model",
    baseURL: "http://127.0.0.1:1234/v1", features: textAndTools(), builtin: true,
  },
  {
    id: "vllm", name: "vLLM (local)", kind: "vllm", model: "local-model",
    baseURL: "http://127.0.0.1:8000/v1", features: textAndTools(), builtin: true,
  },
];

const ALLOWED_KINDS = new Set<ProviderName>(["openai", "anthropic", "agnes", "openai-compatible", "ollama", "lmstudio", "vllm"]);
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const PROBE_STATES = new Set<CapabilityProbeState>(["supported", "unsupported", "unknown", "not-tested"]);

function isValidProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(id) && !RESERVED_IDS.has(id.toLowerCase());
}

export function resolveStartupProviderId(cliProvider?: string, savedProvider?: string, environmentProvider?: string): string {
  return cliProvider ?? savedProvider ?? environmentProvider ?? "openai";
}

export function resolveStartupModel(cliModel: string | undefined, savedModel: string | undefined, environmentModel: string | undefined, profileModel: string): string {
  return cliModel ?? savedModel ?? environmentModel ?? profileModel;
}

function validateProbe(probe: ModelCapabilityProbe, knownIds: Set<string>): ModelCapabilityProbe {
  if (!probe || typeof probe !== "object" || !knownIds.has(probe.providerId)) throw new Error("capability probe references an unknown provider");
  if (typeof probe.model !== "string" || !probe.model.trim() || probe.model.length > 200) throw new Error("capability probe has an invalid model");
  if (typeof probe.checkedAt !== "string" || !Number.isFinite(Date.parse(probe.checkedAt))) throw new Error("capability probe has an invalid timestamp");
  for (const state of [probe.text, probe.tools, probe.vision]) if (!PROBE_STATES.has(state)) throw new Error("capability probe has an invalid state");
  if (probe.contextWindow !== undefined && (!Number.isInteger(probe.contextWindow) || probe.contextWindow < 8_000)) throw new Error("capability probe has an invalid context window");
  if (probe.contextWindowSource !== undefined && probe.contextWindowSource !== "api") throw new Error("capability probe has an invalid context window source");
  if (probe.protocolVersion !== undefined && (!Number.isInteger(probe.protocolVersion) || probe.protocolVersion < 1)) throw new Error("capability probe has an invalid protocol version");
  if (probe.profileFingerprint !== undefined && !/^[a-f0-9]{24}$/.test(probe.profileFingerprint)) throw new Error("capability probe has an invalid profile fingerprint");
  return { ...probe, model: probe.model.trim() };
}

function validateURL(value: string | undefined, label: string): void {
  if (!value) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must use http:// or https://`);
}

export function validateProviderProfile(profile: ProviderProfile): ProviderProfile {
  if (!isValidProviderId(profile.id)) {
    throw new Error("Provider id must be 1-63 letters, numbers, dots, underscores, or hyphens");
  }
  if (!profile.name.trim() || profile.name.length > 80) throw new Error("Provider name must be 1-80 characters");
  if (!ALLOWED_KINDS.has(profile.kind)) throw new Error(`Unsupported provider kind: ${profile.kind}`);
  if (!profile.model.trim() || profile.model.length > 200) throw new Error("Provider model must be 1-200 characters");
  if (profile.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(profile.apiKeyEnv)) throw new Error("apiKeyEnv must be an environment variable name");
  if (profile.apiKey !== undefined && (!profile.apiKey || profile.apiKey.length > 4096 || /[\r\n\0]/.test(profile.apiKey))) {
    throw new Error("apiKey must be 1-4096 characters without line breaks");
  }
  validateURL(profile.baseURL, "baseURL");
  validateURL(profile.proxy, "proxy");
  if (["openai-compatible", "ollama", "lmstudio", "vllm"].includes(profile.kind) && !profile.baseURL) {
    throw new Error(`${profile.kind} profiles require a baseURL`);
  }
  if (profile.contextWindow !== undefined && (!Number.isInteger(profile.contextWindow) || profile.contextWindow < 4_000)) {
    throw new Error("contextWindow must be an integer of at least 4000");
  }
  if (!profile.features || profile.features.text !== true) throw new Error("Provider profiles must support text");
  for (const key of ["tools", "vision", "image", "video"] as const) {
    if (typeof profile.features[key] !== "boolean") throw new Error(`features.${key} must be boolean`);
  }
  if (profile.kind !== "agnes" && (profile.features.image || profile.features.video)) {
    throw new Error("Image and video generation are currently available only through the Agnes adapter");
  }
  return {
    ...profile,
    id: profile.id.trim(), name: profile.name.trim(), model: profile.model.trim(),
    baseURL: profile.baseURL?.replace(/\/$/, ""), apiKeyEnv: profile.apiKeyEnv?.trim(), builtin: Boolean(profile.builtin),
    features: { ...profile.features },
  };
}

export class ProviderRegistry {
  private file: ProviderFile = { version: 3, profiles: [] };
  private pluginProfiles: ProviderProfile[] = [];
  private credentials: LegacyCredentialStore<string, "provider-api-key">;
  private saveOperation: Promise<void> = Promise.resolve();
  private saveSequence = 0;

  constructor(
    private readonly filename = path.join(os.homedir(), ".xiu", "providers.json"),
    private systemCredentials?: CredentialStore<string, "provider-api-key">,
  ) {
    this.credentials = new LegacyCredentialStore({ kind: "provider-api-key", location: filename });
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, "utf8")) as Partial<ProviderFile>;
      if (![1, 2, 3].includes(Number(parsed.version)) || !Array.isArray(parsed.profiles)) throw new Error("unsupported provider configuration format");
      const sourceVersion = Number(parsed.version);
      if (parsed.profiles.length > 100) throw new Error("provider configuration contains more than 100 profiles");
      const legacyCredentials: Record<string, string> = {};
      const profiles = parsed.profiles.map((profile) => {
        const normalized = validateProviderProfile({ ...profile, builtin: false } as ProviderProfile);
        if (normalized.apiKey) legacyCredentials[normalized.id] = normalized.apiKey;
        const { apiKey: _secret, ...safeProfile } = normalized;
        return safeProfile as ProviderProfile;
      });
      const ids = new Set<string>();
      for (const profile of profiles) {
        if (ids.has(profile.id) || BUILTIN_PROVIDER_PROFILES.some((builtin) => builtin.id === profile.id)) throw new Error(`duplicate or reserved provider id: ${profile.id}`);
        ids.add(profile.id);
      }
      const rawCredentials = parsed.credentials && typeof parsed.credentials === "object" ? parsed.credentials : {};
      const credentials: Record<string, string> = { ...legacyCredentials };
      for (const [id, value] of Object.entries(rawCredentials)) {
        if (typeof value !== "string" || !value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`invalid saved credential for ${id}`);
        if (!BUILTIN_PROVIDER_PROFILES.some((profile) => profile.id === id) && !profiles.some((profile) => profile.id === id)) throw new Error(`credential references unknown provider: ${id}`);
        credentials[id] = value;
      }
      const knownIds = new Set([...BUILTIN_PROVIDER_PROFILES.map((profile) => profile.id), ...profiles.map((profile) => profile.id)]);
      const credentialRefs: Record<string, CredentialRef<"provider-api-key">> = {};
      if (sourceVersion >= 3 && parsed.credentialRefs && typeof parsed.credentialRefs === "object") {
        for (const [id, rawRef] of Object.entries(parsed.credentialRefs)) {
          if (!knownIds.has(id) || !rawRef || typeof rawRef !== "object") throw new Error(`credential reference is invalid for ${id}`);
          const candidate = rawRef as Partial<CredentialRef<"provider-api-key">>;
          if (candidate.backend !== "system" || candidate.kind !== "provider-api-key" || candidate.id !== `provider:${id}:api-key`) throw new Error(`credential reference is invalid for ${id}`);
          credentialRefs[id] = credentialRef("system", "provider-api-key", candidate.id, candidate.revision);
        }
      }
      const credentialMigrations: Record<string, ProviderCredentialMigrationReceipt> = {};
      if (sourceVersion >= 3 && parsed.credentialMigrations && typeof parsed.credentialMigrations === "object") {
        for (const [id, rawReceipt] of Object.entries(parsed.credentialMigrations)) {
          if (!knownIds.has(id) || !rawReceipt || typeof rawReceipt !== "object") continue;
          const receipt = rawReceipt as ProviderCredentialMigrationReceipt;
          if (receipt.providerId !== id || receipt.from?.backend !== "legacy-file" || receipt.from.kind !== "provider-api-key" || receipt.to?.backend !== "system" || receipt.to.kind !== "provider-api-key" || typeof receipt.migratedAt !== "string" || !Number.isFinite(Date.parse(receipt.migratedAt)) || typeof receipt.legacyCopyPresent !== "boolean") continue;
          credentialMigrations[id] = structuredClone(receipt);
        }
      }
      const credentialMigrationIntents: Record<string, ProviderCredentialMigrationIntent> = {};
      if (sourceVersion >= 3 && parsed.credentialMigrationIntents && typeof parsed.credentialMigrationIntents === "object") {
        for (const [id, rawIntent] of Object.entries(parsed.credentialMigrationIntents)) {
          if (!knownIds.has(id) || !rawIntent || typeof rawIntent !== "object") continue;
          const intent = rawIntent as ProviderCredentialMigrationIntent;
          if (intent.providerId !== id || intent.from?.backend !== "legacy-file" || intent.from.kind !== "provider-api-key" || intent.to?.backend !== "system" || intent.to.kind !== "provider-api-key" || intent.to.id !== `provider:${id}:api-key` || typeof intent.preparedAt !== "string" || !Number.isFinite(Date.parse(intent.preparedAt))) continue;
          credentialMigrationIntents[id] = structuredClone(intent);
        }
      }
      const rawProbes = sourceVersion >= 2 && Array.isArray(parsed.probes) ? parsed.probes : [];
      if (rawProbes.length > 500) throw new Error("provider configuration contains more than 500 capability probes");
      const uniqueProbes = new Map<string, ModelCapabilityProbe>();
      for (const rawProbe of rawProbes) {
        const probe = validateProbe(rawProbe as ModelCapabilityProbe, knownIds);
        const profile = [...BUILTIN_PROVIDER_PROFILES, ...profiles].find((item) => item.id === probe.providerId);
        if (profile && probe.profileFingerprint === probeFingerprint(profile, probe.model)) uniqueProbes.set(`${probe.providerId}\0${probe.model}`, probe);
      }
      const rawActiveModels = parsed.activeModels && typeof parsed.activeModels === "object" ? parsed.activeModels : {};
      const activeModels: Record<string, string> = {};
      for (const [id, model] of Object.entries(rawActiveModels)) {
        // An approved plugin provider is installed only after workspace trust is
        // established. Preserve its bounded model choice until that profile is
        // contributed later in startup, while still rejecting unsafe keys.
        if (!isValidProviderId(id) || typeof model !== "string" || !model.trim() || model.length > 200) continue;
        activeModels[id] = model.trim();
      }
      const failoverChains: Record<string, string[]> = {};
      if (parsed.failoverChains && typeof parsed.failoverChains === "object") {
        for (const [primaryId, rawChain] of Object.entries(parsed.failoverChains)) {
          if (!knownIds.has(primaryId) || !Array.isArray(rawChain)) continue;
          const chain = rawChain.filter((id): id is string => typeof id === "string" && knownIds.has(id) && id !== primaryId);
          failoverChains[primaryId] = [...new Set(chain)].slice(0, 8);
        }
      }
      const routing: ProviderRoutingPolicy = { enabled: false, phases: {} };
      if (parsed.routing && typeof parsed.routing === "object") {
        routing.enabled = parsed.routing.enabled === true;
        if (parsed.routing.phases && typeof parsed.routing.phases === "object") {
          for (const [phase, providerId] of Object.entries(parsed.routing.phases)) {
            if (isProviderRoutingPhase(phase) && typeof providerId === "string" && knownIds.has(providerId)) routing.phases[phase] = providerId;
          }
        }
      }
      this.credentials = new LegacyCredentialStore({
        kind: "provider-api-key", location: this.filename, values: credentials,
        revisions: parsed.credentialRevisions && typeof parsed.credentialRevisions === "object" ? parsed.credentialRevisions : undefined,
      });
      this.file = { version: 3, active: typeof parsed.active === "string" ? parsed.active : undefined, activeModels, failoverChains, routing, profiles, credentialRefs, credentialMigrations, credentialMigrationIntents, probes: [...uniqueProbes.values()] };
      // Keep an unresolved active id in memory: an approved plugin may contribute
      // that provider after workspace trust is established later in startup.
      if (sourceVersion < 3) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.file = { version: 3, profiles: [] };
        this.credentials = new LegacyCredentialStore({ kind: "provider-api-key", location: this.filename });
        return;
      }
      throw new Error(`Could not read Xiu provider settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  list(): ProviderProfile[] {
    return [...BUILTIN_PROVIDER_PROFILES, ...this.file.profiles, ...this.pluginProfiles].map((profile) => ({
      ...profile,
      apiKey: this.resolveStoredCredential(profile.id),
      features: { ...profile.features },
    }));
  }

  /** Install validated, in-memory profiles contributed by approved plugins. */
  setPluginProfiles(profiles: ProviderProfile[]): void {
    const reserved = new Set([...BUILTIN_PROVIDER_PROFILES, ...this.file.profiles].map((profile) => profile.id));
    const seen = new Set<string>();
    this.pluginProfiles = profiles.map((profile) => {
      const normalized = validateProviderProfile({ ...profile, apiKey: undefined, builtin: false });
      if (reserved.has(normalized.id) || seen.has(normalized.id)) throw new Error(`Plugin provider id conflicts with an existing provider: ${normalized.id}`);
      seen.add(normalized.id);
      return normalized;
    });
  }

  get(id: string): ProviderProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  activeId(): string | undefined { return this.file.active; }

  activeModel(id: string): string | undefined {
    const models = this.file.activeModels;
    return models && Object.hasOwn(models, id) ? models[id] : undefined;
  }

  credentialRevision(id: string): number { return this.file.credentialRefs?.[id]?.revision ?? this.credentials.ref(id).revision; }

  credentialStatus(): CredentialBackendStatus { return this.credentials.status(); }

  attachSystemCredentialStore(store: CredentialStore<string, "provider-api-key">): void { this.systemCredentials = store; }

  credentialInfo(): ProviderCredentialInfo[] {
    return [...BUILTIN_PROVIDER_PROFILES, ...this.file.profiles].map((profile) => {
      const ref = this.file.credentialRefs?.[profile.id];
      const legacyCopyPresent = this.credentials.has(this.credentials.ref(profile.id));
      let systemCopyPresent = false;
      if (ref && this.systemCredentials) {
        try { systemCopyPresent = this.systemCredentials.has(ref); }
        catch { systemCopyPresent = false; }
      }
      return {
        providerId: profile.id,
        providerName: profile.name,
        source: readEnvironmentCredential(profile.apiKeyEnv) !== undefined ? "environment" : ref ? "system" : legacyCopyPresent ? "legacy-file" : "missing",
        legacyCopyPresent,
        systemCopyPresent,
        interruptedMigration: Boolean(this.file.credentialMigrationIntents?.[profile.id]),
        migration: this.file.credentialMigrations?.[profile.id] ? structuredClone(this.file.credentialMigrations[profile.id]) : undefined,
      };
    });
  }

  migrationCandidates(): ProviderCredentialInfo[] {
    return this.credentialInfo().filter((item) => item.legacyCopyPresent && !this.file.credentialRefs?.[item.providerId]);
  }

  async migrateApiKeysToSystem(ids: string[], store: CredentialStore<string, "provider-api-key">): Promise<ProviderCredentialInfo[]> {
    const selected = [...new Set(ids)];
    if (!selected.length) throw new Error("No Provider credentials were selected for migration");
    const known = new Set(this.list().map((profile) => profile.id));
    const values = new Map<string, string>();
    const targets = new Map<string, CredentialRef<"provider-api-key">>();
    for (const id of selected) {
      if (!known.has(id)) throw new Error(`Provider profile not found: ${id}`);
      if (this.file.credentialRefs?.[id]) throw new Error(`Provider credential is already migrated: ${id}`);
      const value = this.credentials.get(this.credentials.ref(id));
      if (!value) throw new Error(`Provider has no legacy local API key: ${id}`);
      const target = credentialRef("system", "provider-api-key", `provider:${id}:api-key`);
      const intent = this.file.credentialMigrationIntents?.[id];
      if (store.has(target) && !intent) throw new Error(`A system credential already exists for ${id}; use /credentials forget before retrying`);
      if (intent && (intent.to.id !== target.id || intent.from.id !== id)) throw new Error(`Provider has an incompatible interrupted migration record: ${id}`);
      values.set(id, value);
      targets.set(id, target);
    }
    const previousIntents = structuredClone(this.file.credentialMigrationIntents ?? {});
    this.file.credentialMigrationIntents ??= {};
    const preparedAt = new Date().toISOString();
    for (const id of selected) this.file.credentialMigrationIntents[id] = {
      providerId: id, from: this.credentials.ref(id), to: targets.get(id)!, preparedAt,
    };
    try { await this.save(); }
    catch (error) {
      this.file.credentialMigrationIntents = previousIntents;
      throw error;
    }
    const attempted: CredentialRef<"provider-api-key">[] = [];
    try {
      for (const id of selected) {
        const target = targets.get(id)!;
        const interruptedCopy = store.get(target);
        if (interruptedCopy !== undefined && !sameSecret(interruptedCopy, values.get(id)!)) throw new Error(`Interrupted system credential does not match the legacy key for ${id}; explicit cleanup is required`);
        attempted.push(target);
        const writtenRef = store.set(target, values.get(id)!);
        const restored = store.get(writtenRef);
        if (restored === undefined || !sameSecret(restored, values.get(id)!)) throw new Error(`System credential verification failed for ${id}`);
        targets.set(id, writtenRef);
      }
      const previousRefs = structuredClone(this.file.credentialRefs ?? {});
      const previousMigrations = structuredClone(this.file.credentialMigrations ?? {});
      const migratedAt = new Date().toISOString();
      this.file.credentialRefs ??= {};
      this.file.credentialMigrations ??= {};
      for (const id of selected) {
        const to = targets.get(id)!;
        this.file.credentialRefs[id] = to;
        this.file.credentialMigrations[id] = {
          providerId: id, from: this.credentials.ref(id), to, migratedAt, legacyCopyPresent: true,
        };
        delete this.file.credentialMigrationIntents?.[id];
      }
      try { await this.save(); }
      catch (error) {
        this.file.credentialRefs = previousRefs;
        this.file.credentialMigrations = previousMigrations;
        throw error;
      }
      this.systemCredentials = store;
      return this.credentialInfo().filter((item) => selected.includes(item.providerId));
    } catch (error) {
      let cleaned = true;
      for (const ref of attempted.reverse()) {
        try { if (store.has(ref) && !store.delete(ref)) cleaned = false; }
        catch { cleaned = false; }
      }
      if (cleaned) this.file.credentialMigrationIntents = previousIntents;
      try { await this.save(); } catch { /* The durable prepared intent remains a recovery marker. */ }
      throw error;
    }
  }

  async cleanupLegacyApiKey(id: string): Promise<void> {
    const ref = this.file.credentialRefs?.[id];
    const receipt = this.file.credentialMigrations?.[id];
    if (!ref || !receipt || !this.systemCredentials) throw new Error(`Provider credential is not in a cleanable migrated state: ${id}`);
    const legacy = this.credentials.get(this.credentials.ref(id));
    const system = this.systemCredentials.get(ref);
    if (!legacy) return;
    if (!system || receipt.to.id !== ref.id || receipt.to.revision !== ref.revision) throw new Error(`The active system credential could not be verified for ${id}; cleanup was refused`);
    const previousReceipt = structuredClone(receipt);
    this.credentials.delete(this.credentials.ref(id));
    receipt.legacyCopyPresent = false;
    try { await this.save(); }
    catch (error) {
      this.credentials.set(this.credentials.ref(id), legacy);
      this.file.credentialMigrations![id] = previousReceipt;
      throw error;
    }
  }

  async rollbackSystemApiKey(id: string): Promise<boolean> {
    const ref = this.file.credentialRefs?.[id];
    const receipt = this.file.credentialMigrations?.[id];
    if (!ref || !receipt) throw new Error(`Provider credential is not migrated: ${id}`);
    const legacyRef = this.credentials.ref(id);
    const hasLegacy = receipt.legacyCopyPresent && this.credentials.has(legacyRef);
    let restoredFromSystem = false;
    if (!hasLegacy) {
      if (!this.systemCredentials) throw new Error(`Windows Credential Manager is unavailable; ${id} could not be restored`);
      const systemValue = this.systemCredentials.get(ref);
      if (!systemValue) throw new Error(`The active system credential could not be read for rollback: ${id}`);
      this.credentials.set(legacyRef, systemValue);
      restoredFromSystem = true;
    }
    const previousRef = structuredClone(ref);
    const previousReceipt = structuredClone(receipt);
    delete this.file.credentialRefs?.[id];
    delete this.file.credentialMigrations?.[id];
    delete this.file.credentialMigrationIntents?.[id];
    try { await this.save(); }
    catch (error) {
      if (restoredFromSystem) this.credentials.delete(this.credentials.ref(id));
      (this.file.credentialRefs ??= {})[id] = previousRef;
      (this.file.credentialMigrations ??= {})[id] = previousReceipt;
      throw error;
    }
    if (!this.systemCredentials) return false;
    try { return this.systemCredentials.delete(ref); }
    catch { return false; }
  }

  async forgetLocalApiKey(id: string): Promise<void> {
    if (!this.get(id)) throw new Error(`Provider profile not found: ${id}`);
    const ref = this.file.credentialRefs?.[id];
    if (ref) {
      if (!this.systemCredentials) throw new Error("Windows Credential Manager is unavailable; the system credential was not changed");
      this.systemCredentials.delete(ref);
      delete this.file.credentialRefs?.[id];
      delete this.file.credentialMigrations?.[id];
    } else if (this.systemCredentials) {
      // Explicit forget also removes a deterministic orphan left by an interrupted
      // migration or a rollback whose post-switch system cleanup failed.
      this.systemCredentials.delete(credentialRef("system", "provider-api-key", `provider:${id}:api-key`));
    }
    delete this.file.credentialMigrationIntents?.[id];
    this.credentials.delete(this.credentials.ref(id));
    this.file.probes = (this.file.probes ?? []).filter((probe) => probe.providerId !== id);
    await this.save();
  }

  private resolveStoredCredential(id: string): string | undefined {
    const ref = this.file.credentialRefs?.[id];
    if (!ref) return this.credentials.get(this.credentials.ref(id));
    if (!this.systemCredentials) return undefined;
    try { return this.systemCredentials.get(ref); }
    catch { return undefined; }
  }

  failoverChain(id: string): string[] { return [...(this.file.failoverChains?.[id] ?? [])]; }

  routingPolicy(): ProviderRoutingPolicy {
    return { enabled: this.file.routing?.enabled === true, phases: { ...(this.file.routing?.phases ?? {}) } };
  }

  async setRoutingEnabled(enabled: boolean): Promise<void> {
    (this.file.routing ??= { enabled: false, phases: {} }).enabled = enabled;
    await this.save();
  }

  async setRoutingPhase(phase: ProviderRoutingPhase, providerId?: string): Promise<void> {
    if (providerId !== undefined && !this.get(providerId)) throw new Error(`Provider profile not found: ${providerId}`);
    const routing = (this.file.routing ??= { enabled: false, phases: {} });
    if (providerId) routing.phases[phase] = providerId;
    else delete routing.phases[phase];
    await this.save();
  }

  async setFailoverChain(id: string, chain: string[]): Promise<void> {
    if (!this.get(id)) throw new Error(`Provider profile not found: ${id}`);
    if (chain.length > 8) throw new Error("A failover chain can contain at most 8 providers");
    const normalized = [...new Set(chain)];
    if (normalized.includes(id)) throw new Error("The primary provider cannot be its own fallback");
    for (const fallbackId of normalized) if (!this.get(fallbackId)) throw new Error(`Provider profile not found: ${fallbackId}`);
    (this.file.failoverChains ??= {})[id] = normalized;
    await this.save();
  }

  capabilityProbe(providerId: string, model: string): ModelCapabilityProbe | undefined {
    const probe = this.file.probes?.find((item) => item.providerId === providerId && item.model === model);
    const profile = this.get(providerId);
    return probe && profile && probe.profileFingerprint === probeFingerprint(profile, model) ? { ...probe } : undefined;
  }

  async setCapabilityProbe(probe: ModelCapabilityProbe): Promise<void> {
    if (!this.get(probe.providerId)) throw new Error(`Provider profile not found: ${probe.providerId}`);
    const profile = this.get(probe.providerId)!;
    const normalized = validateProbe({ ...probe, profileFingerprint: probeFingerprint(profile, probe.model) }, new Set(this.list().map((profile) => profile.id)));
    this.file.probes = (this.file.probes ?? []).filter((item) => item.providerId !== normalized.providerId || item.model !== normalized.model);
    this.file.probes.push(normalized);
    if (this.file.probes.length > 500) this.file.probes.splice(0, this.file.probes.length - 500);
    await this.save();
  }

  async setActive(id: string, model?: string): Promise<void> {
    if (!this.get(id)) throw new Error(`Provider profile not found: ${id}`);
    if (model !== undefined && (!model.trim() || model.length > 200)) throw new Error("Active model must be 1-200 characters");
    this.file.active = id;
    if (model) (this.file.activeModels ??= {})[id] = model.trim();
    await this.save();
  }

  async upsert(profile: ProviderProfile): Promise<void> {
    const normalized = validateProviderProfile({ ...profile, builtin: false });
    if (BUILTIN_PROVIDER_PROFILES.some((item) => item.id === normalized.id)) throw new Error(`Built-in provider id cannot be replaced: ${normalized.id}`);
    const { apiKey, ...storedProfile } = normalized;
    const existing = this.file.profiles.findIndex((item) => item.id === normalized.id);
    const previous = existing >= 0 ? this.file.profiles[existing] : undefined;
    if (existing >= 0) this.file.profiles[existing] = storedProfile as ProviderProfile;
    else this.file.profiles.push(storedProfile as ProviderProfile);
    if (apiKey) this.credentials.set(this.credentials.ref(normalized.id), apiKey);
    if (apiKey || !previous || probeFingerprint(previous, previous.model) !== probeFingerprint(normalized, normalized.model)) {
      this.file.probes = (this.file.probes ?? []).filter((probe) => probe.providerId !== normalized.id);
    }
    await this.save();
  }

  async setApiKey(id: string, apiKey?: string): Promise<void> {
    if (!this.get(id)) throw new Error(`Provider profile not found: ${id}`);
    if (apiKey !== undefined && (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey))) throw new Error("apiKey must be 1-4096 characters without line breaks");
    const systemRef = this.file.credentialRefs?.[id];
    if (systemRef) {
      if (!this.systemCredentials) throw new Error("Windows Credential Manager is unavailable; the credential was not changed");
      if (apiKey) {
        const updatedRef = this.systemCredentials.set(systemRef, apiKey);
        this.file.credentialRefs![id] = updatedRef;
        if (this.file.credentialMigrations?.[id]) {
          this.file.credentialMigrations[id]!.to = updatedRef;
          this.file.credentialMigrations[id]!.migratedAt = new Date().toISOString();
        }
      } else {
        await this.forgetLocalApiKey(id);
        return;
      }
    } else if (apiKey) this.credentials.set(this.credentials.ref(id), apiKey);
    else this.credentials.delete(this.credentials.ref(id));
    this.file.probes = (this.file.probes ?? []).filter((probe) => probe.providerId !== id);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    if (BUILTIN_PROVIDER_PROFILES.some((item) => item.id === id)) throw new Error("Built-in providers cannot be removed");
    const next = this.file.profiles.filter((profile) => profile.id !== id);
    if (next.length === this.file.profiles.length) throw new Error(`Provider profile not found: ${id}`);
    this.file.profiles = next;
    this.credentials.delete(this.credentials.ref(id));
    const systemRef = this.file.credentialRefs?.[id];
    if (systemRef && this.systemCredentials) this.systemCredentials.delete(systemRef);
    delete this.file.credentialRefs?.[id];
    delete this.file.credentialMigrations?.[id];
    delete this.file.credentialMigrationIntents?.[id];
    if (this.file.activeModels) delete this.file.activeModels[id];
    if (this.file.failoverChains) {
      delete this.file.failoverChains[id];
      for (const [primaryId, chain] of Object.entries(this.file.failoverChains)) this.file.failoverChains[primaryId] = chain.filter((item) => item !== id);
    }
    if (this.file.routing) {
      for (const phase of Object.keys(this.file.routing.phases) as ProviderRoutingPhase[]) {
        if (this.file.routing.phases[phase] === id) delete this.file.routing.phases[phase];
      }
    }
    this.file.probes = (this.file.probes ?? []).filter((probe) => probe.providerId !== id);
    if (this.file.active === id) this.file.active = undefined;
    await this.save();
  }

  private async save(): Promise<void> {
    const operation = this.saveOperation.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${process.pid}.${++this.saveSequence}.tmp`;
      const safeFile: ProviderFile = {
        version: 3,
        active: this.file.active,
        activeModels: { ...this.file.activeModels },
        failoverChains: Object.fromEntries(Object.entries(this.file.failoverChains ?? {}).map(([id, chain]) => [id, [...chain]])),
        routing: { enabled: this.file.routing?.enabled === true, phases: { ...(this.file.routing?.phases ?? {}) } },
        profiles: this.file.profiles.map(({ apiKey: _secret, ...profile }) => ({ ...profile, builtin: false } as ProviderProfile)),
        credentials: this.credentials.exportLegacyValues(),
        credentialRevisions: this.credentials.exportRevisions(),
        credentialRefs: structuredClone(this.file.credentialRefs ?? {}),
        credentialMigrations: structuredClone(this.file.credentialMigrations ?? {}),
        credentialMigrationIntents: structuredClone(this.file.credentialMigrationIntents ?? {}),
        probes: [...(this.file.probes ?? [])],
      };
      await fs.writeFile(temporary, `${JSON.stringify(safeFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      try { await fs.rename(temporary, this.filename); }
      catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.saveOperation = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
