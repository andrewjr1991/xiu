import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILTIN_PROVIDER_PROFILES, ProviderRegistry, resolveStartupModel, resolveStartupProviderId, validateProviderProfile } from "../src/provider-registry.js";
import { WindowsSystemCredentialStore } from "../src/system-credential-store.js";

class FakeCredentialEntry {
  static values = new Map<string, string>();
  static failWriteFor: string | undefined;
  static failDeleteFor: string | undefined;
  private readonly key: string;
  constructor(service: string, username: string) { this.key = `${service}\0${username}`; }
  setPassword(value: string): void {
    if (this.key.endsWith(`\0${FakeCredentialEntry.failWriteFor}`)) throw new Error("simulated backend failure containing secret-should-not-leak");
    FakeCredentialEntry.values.set(this.key, value);
  }
  getPassword(): string | null { return FakeCredentialEntry.values.get(this.key) ?? null; }
  deleteCredential(): boolean {
    if (this.key.endsWith(`\0${FakeCredentialEntry.failDeleteFor}`)) throw new Error("simulated delete failure");
    return FakeCredentialEntry.values.delete(this.key);
  }
}

function fakeSystemStore(): WindowsSystemCredentialStore<string, "provider-api-key"> {
  return new WindowsSystemCredentialStore("provider-api-key", FakeCredentialEntry);
}

test("provider registry includes cloud and local built-in profiles", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-providers-"));
  const registry = new ProviderRegistry(path.join(directory, "providers.json"));
  await registry.load();
  assert.deepEqual(registry.list().map((profile) => profile.id), ["agnes", "openai", "anthropic", "ollama", "lmstudio", "vllm"]);
  assert.equal(registry.get("ollama")?.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(registry.get("lmstudio")?.baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(registry.get("vllm")?.baseURL, "http://127.0.0.1:8000/v1");
});

test("provider registry can persist a local credential separately from shareable profile metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-save-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  await registry.upsert({
    id: "office-gateway", name: "Office Gateway", kind: "openai-compatible", model: "coder",
    baseURL: "https://models.example.test/v1/", apiKeyEnv: "OFFICE_MODEL_KEY", apiKey: "saved-local-secret", contextWindow: 64_000,
    features: { text: true, tools: true, vision: false, image: false, video: false },
  });
  await registry.setActive("office-gateway", "coder-v2");
  const saved = await fs.readFile(filename, "utf8");
  assert.match(saved, /OFFICE_MODEL_KEY/);
  assert.match(saved, /"credentials"/);
  assert.match(saved, /"credentialRevisions"/);
  assert.match(saved, /saved-local-secret/);
  assert.doesNotMatch(saved, /"apiKey"/);

  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.equal(restored.activeId(), "office-gateway");
  assert.equal(restored.activeModel("office-gateway"), "coder-v2");
  assert.equal(restored.get("office-gateway")?.baseURL, "https://models.example.test/v1");
  assert.equal(restored.get("office-gateway")?.apiKey, "saved-local-secret");
  assert.equal(restored.credentialRevision("office-gateway"), 1);
  assert.deepEqual(restored.credentialStatus(), {
    backend: "legacy-file", available: true, secure: false, location: filename, entries: 1,
  });

  await restored.upsert({
    ...restored.get("office-gateway")!, name: "Edited Gateway", apiKey: undefined,
  });
  assert.equal(restored.get("office-gateway")?.name, "Edited Gateway");
  assert.equal(restored.get("office-gateway")?.apiKey, "saved-local-secret");
});

test("saved interactive provider and model override legacy environment defaults", () => {
  assert.equal(resolveStartupProviderId(undefined, "office-gateway", "agnes"), "office-gateway");
  assert.equal(resolveStartupProviderId("openai", "office-gateway", "agnes"), "openai");
  assert.equal(resolveStartupProviderId(undefined, undefined, "agnes"), "agnes");
  assert.equal(resolveStartupModel(undefined, "coder-v2", "agnes-2.5-flash", "coder"), "coder-v2");
  assert.equal(resolveStartupModel("coder-v3", "coder-v2", "agnes-2.5-flash", "coder"), "coder-v3");
});

test("approved plugin provider model selection survives loading before plugin discovery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-plugin-active-"));
  const filename = path.join(directory, "providers.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 3,
    active: "plugin-gateway",
    activeModels: { "plugin-gateway": "coder-large", "__proto__": "unsafe" },
    profiles: [],
  }), "utf8");

  const registry = new ProviderRegistry(filename);
  await registry.load();
  assert.equal(registry.activeId(), "plugin-gateway");
  assert.equal(registry.activeModel("plugin-gateway"), "coder-large");
  assert.equal(registry.activeModel("__proto__"), undefined);

  registry.setPluginProfiles([{
    id: "plugin-gateway", name: "Plugin Gateway", kind: "openai-compatible", model: "coder-default",
    baseURL: "https://plugin.example.test/v1", apiKeyEnv: "PLUGIN_GATEWAY_KEY", contextWindow: 1_000_000,
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }]);
  assert.equal(registry.get("plugin-gateway")?.model, "coder-default");
  assert.equal(registry.activeModel("plugin-gateway"), "coder-large");
});

test("saved credentials also work for built-in providers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-key-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  await registry.setApiKey("agnes", "agnes-local-key");
  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.equal(restored.get("agnes")?.apiKey, "agnes-local-key");
});

test("provider validation rejects unsafe ids, URLs, and secret-shaped fields", () => {
  const base = {
    id: "custom", name: "Custom", kind: "openai-compatible" as const, model: "coder",
    features: { text: true as const, tools: true, vision: false, image: false, video: false },
  };
  assert.throws(() => validateProviderProfile({ ...base, id: "__proto__" }), /Provider id/);
  assert.throws(() => validateProviderProfile({ ...base, baseURL: "file:///secret" }), /http:\/\//);
  assert.throws(() => validateProviderProfile({ ...base, apiKeyEnv: "actual secret" }), /environment variable/);
  assert.throws(() => validateProviderProfile({ ...base, baseURL: "https://example.test/v1", features: { ...base.features, image: true } }), /only through the Agnes/);
  assert.throws(() => validateProviderProfile(base), /require a baseURL/);
  assert.ok(BUILTIN_PROVIDER_PROFILES.every((profile) => profile.builtin));
});

test("built-in provider profiles cannot be replaced or removed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-builtins-"));
  const registry = new ProviderRegistry(path.join(directory, "providers.json"));
  await registry.load();
  await assert.rejects(registry.upsert({ ...BUILTIN_PROVIDER_PROFILES[0]!, name: "Fake" }), /cannot be replaced/);
  await assert.rejects(registry.remove("openai"), /cannot be removed/);
});

test("provider capability probes persist per model and configuration changes invalidate them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-probes-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  const profile = {
    id: "gateway", name: "Gateway", kind: "openai-compatible" as const, model: "coder-a", baseURL: "https://one.example.test/v1",
    features: { text: true as const, tools: true, vision: true, image: false, video: false },
  };
  await registry.upsert(profile);
  await registry.setCapabilityProbe({ providerId: "gateway", model: "coder-a", checkedAt: "2026-08-10T00:00:00.000Z", text: "supported", tools: "supported", vision: "unsupported", contextWindow: 1_000_000, contextWindowSource: "api" });
  await registry.setCapabilityProbe({ providerId: "gateway", model: "coder-b", checkedAt: "2026-08-10T00:01:00.000Z", text: "supported", tools: "unsupported", vision: "supported" });

  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.equal(restored.capabilityProbe("gateway", "coder-a")?.tools, "supported");
  assert.equal(restored.capabilityProbe("gateway", "coder-a")?.contextWindow, 1_000_000);
  assert.equal(restored.capabilityProbe("gateway", "coder-b")?.tools, "unsupported");

  await restored.upsert({ ...profile, baseURL: "https://two.example.test/v1" });
  assert.equal(restored.capabilityProbe("gateway", "coder-a"), undefined);
  assert.equal(restored.capabilityProbe("gateway", "coder-b"), undefined);
});

test("provider registry migrates version 1 settings and discards untrusted legacy probe cache", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-migrate-"));
  const filename = path.join(directory, "providers.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    profiles: [{
      id: "legacy", name: "Legacy", kind: "openai-compatible", model: "coder", baseURL: "https://legacy.example/v1",
      features: { text: true, tools: true, vision: false, image: false, video: false },
    }],
    probes: [{ providerId: "legacy", model: "coder", checkedAt: "2026-08-10T00:00:00.000Z", text: "supported", tools: "supported", vision: "unsupported" }],
  }), "utf8");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  assert.equal(registry.get("legacy")?.model, "coder");
  assert.equal(registry.capabilityProbe("legacy", "coder"), undefined);
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).version, 3);
});

test("versioned capability cache is fingerprinted and invalidated when credentials change", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-fingerprint-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  await registry.upsert({
    id: "fingerprint", name: "Fingerprint", kind: "openai-compatible", model: "coder", baseURL: "https://cache.example/v1", apiKey: "first-key",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  });
  await registry.setCapabilityProbe({ providerId: "fingerprint", model: "coder", checkedAt: "2026-08-11T00:00:00.000Z", text: "supported", tools: "supported", vision: "unsupported" });
  const stored = JSON.parse(await fs.readFile(filename, "utf8")) as { version: number; probes: Array<{ profileFingerprint?: string }> };
  assert.equal(stored.version, 3);
  assert.match(stored.probes[0]?.profileFingerprint ?? "", /^[a-f0-9]{24}$/);
  assert.equal(registry.capabilityProbe("fingerprint", "coder")?.tools, "supported");
  await registry.setApiKey("fingerprint", "second-key");
  assert.equal(registry.capabilityProbe("fingerprint", "coder"), undefined);
  await registry.setCapabilityProbe({ providerId: "fingerprint", model: "coder", checkedAt: "2026-08-11T00:01:00.000Z", text: "supported", tools: "supported", vision: "unsupported" });
  await registry.upsert({
    id: "fingerprint", name: "Fingerprint", kind: "openai-compatible", model: "coder", baseURL: "https://cache.example/v1", apiKey: "third-key",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  });
  assert.equal(registry.capabilityProbe("fingerprint", "coder"), undefined);
});

test("provider registry persists ordered failover chains and removes stale references", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-failover-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  await registry.upsert({
    id: "backup-one", name: "Backup One", kind: "openai-compatible", model: "backup-model", baseURL: "http://127.0.0.1:9001/v1",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  });
  await registry.setFailoverChain("agnes", ["backup-one", "openai"]);

  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.deepEqual(restored.failoverChain("agnes"), ["backup-one", "openai"]);
  await restored.remove("backup-one");
  assert.deepEqual(restored.failoverChain("agnes"), ["openai"]);
});

test("provider registry serializes concurrent writes without corrupting the compatibility file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-concurrent-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  await Promise.all(["one", "two"].map((id) => registry.upsert({
    id, name: id, kind: "openai-compatible", model: "coder", baseURL: `http://127.0.0.1:${id === "one" ? 9010 : 9020}/v1`,
    features: { text: true, tools: true, vision: false, image: false, video: false },
  })));
  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.ok(restored.get("one"));
  assert.ok(restored.get("two"));
});

test("provider registry persists stage routing and removes stale targets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-routing-"));
  const filename = path.join(directory, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  await registry.upsert({
    id: "fast-planner", name: "Fast Planner", kind: "openai-compatible", model: "planner", baseURL: "http://127.0.0.1:9010/v1",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  });
  await registry.setRoutingPhase("planning", "fast-planner");
  await registry.setRoutingPhase("verification", "openai");
  await registry.setRoutingEnabled(true);

  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.deepEqual(restored.routingPolicy(), { enabled: true, phases: { planning: "fast-planner", verification: "openai" } });
  await restored.remove("fast-planner");
  assert.deepEqual(restored.routingPolicy(), { enabled: true, phases: { verification: "openai" } });
});

test("provider API key migration verifies the system copy before switching and cleanup is separate", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-migrate-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("ollama", "migrate-this-secret");

  const migrated = await registry.migrateApiKeysToSystem(["ollama"], store);
  assert.equal(migrated[0]?.source, "system");
  assert.equal(migrated[0]?.legacyCopyPresent, true);
  assert.equal(registry.get("ollama")?.apiKey, "migrate-this-secret");
  const afterMigration = await fs.readFile(filename, "utf8");
  assert.match(afterMigration, /migrate-this-secret/);
  assert.match(afterMigration, /provider:ollama:api-key/);

  const restored = new ProviderRegistry(filename, store);
  await restored.load();
  assert.equal(restored.get("ollama")?.apiKey, "migrate-this-secret");
  await restored.cleanupLegacyApiKey("ollama");
  const cleaned = await fs.readFile(filename, "utf8");
  assert.doesNotMatch(cleaned, /migrate-this-secret/);
  assert.equal(restored.get("ollama")?.apiKey, "migrate-this-secret");
  assert.equal(restored.credentialInfo().find((item) => item.providerId === "ollama")?.legacyCopyPresent, false);
});

test("batch Provider migration rolls back every system write when one copy fails", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-rollback-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("agnes", "first-secret");
  await registry.setApiKey("openai", "second-secret");
  FakeCredentialEntry.failWriteFor = "provider:openai:api-key";
  await assert.rejects(registry.migrateApiKeysToSystem(["agnes", "openai"], store), /Windows Credential Manager write failed/);
  FakeCredentialEntry.failWriteFor = undefined;

  assert.equal(store.has(store.ref("provider:agnes:api-key")), false);
  assert.equal(registry.get("agnes")?.apiKey, "first-secret");
  assert.equal(registry.get("openai")?.apiKey, "second-secret");
  const saved = JSON.parse(await fs.readFile(filename, "utf8")) as { credentialRefs?: Record<string, unknown> };
  assert.deepEqual(saved.credentialRefs ?? {}, {});
});

test("a system credential reference never silently falls back to retained plaintext", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-no-fallback-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("ollama", "retained-legacy-secret");
  await registry.migrateApiKeysToSystem(["ollama"], store);

  const unavailable = new ProviderRegistry(filename);
  await unavailable.load();
  assert.equal(unavailable.get("ollama")?.apiKey, undefined);
  assert.equal(unavailable.credentialInfo().find((item) => item.providerId === "ollama")?.source, "system");
});

test("forget removes both system and retained legacy Provider credentials", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-forget-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("agnes", "forget-this-secret");
  await registry.migrateApiKeysToSystem(["agnes"], store);
  await registry.forgetLocalApiKey("agnes");

  assert.equal(store.has(store.ref("provider:agnes:api-key")), false);
  assert.equal(registry.get("agnes")?.apiKey, undefined);
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /forget-this-secret/);
});

test("rollback atomically restores the retained legacy Provider credential", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-explicit-rollback-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("ollama", "rollback-secret");
  await registry.migrateApiKeysToSystem(["ollama"], store);

  assert.equal(await registry.rollbackSystemApiKey("ollama"), true);
  assert.equal(registry.get("ollama")?.apiKey, "rollback-secret");
  assert.equal(store.has(store.ref("provider:ollama:api-key")), false);
  const restored = new ProviderRegistry(filename, store);
  await restored.load();
  assert.equal(restored.credentialInfo().find((item) => item.providerId === "ollama")?.source, "legacy-file");
});

test("rollback can explicitly restore a cleaned legacy copy from the active system credential", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-cleaned-rollback-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("ollama", "recover-after-cleanup");
  await registry.migrateApiKeysToSystem(["ollama"], store);
  await registry.cleanupLegacyApiKey("ollama");

  assert.equal(await registry.rollbackSystemApiKey("ollama"), true);
  assert.equal(registry.get("ollama")?.apiKey, "recover-after-cleanup");
  assert.equal(store.has(store.ref("provider:ollama:api-key")), false);
  const restored = new ProviderRegistry(filename, store);
  await restored.load();
  assert.equal(restored.get("ollama")?.apiKey, "recover-after-cleanup");
  assert.equal(restored.credentialInfo().find((item) => item.providerId === "ollama")?.source, "legacy-file");
});

test("rotating a migrated key updates its system revision and still permits legacy cleanup", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-rotate-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("ollama", "old-secret");
  await registry.migrateApiKeysToSystem(["ollama"], store);
  const previousRevision = registry.credentialRevision("ollama");

  await registry.setApiKey("ollama", "rotated-secret");
  assert.ok(registry.credentialRevision("ollama") > previousRevision);
  assert.equal(registry.get("ollama")?.apiKey, "rotated-secret");
  await registry.cleanupLegacyApiKey("ollama");
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /old-secret/);
  assert.equal(registry.get("ollama")?.apiKey, "rotated-secret");
});

test("an interrupted migration keeps a non-secret intent and safely resumes", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-credential-resume-"));
  const filename = path.join(directory, "providers.json");
  const store = fakeSystemStore();
  const registry = new ProviderRegistry(filename, store);
  await registry.load();
  await registry.setApiKey("ollama", "resume-secret");
  FakeCredentialEntry.failDeleteFor = "provider:ollama:api-key";
  class WriteThenThrowEntry extends FakeCredentialEntry {
    override setPassword(value: string): void { super.setPassword(value); throw new Error("simulated interruption"); }
  }
  const interruptedStore = new WindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key", WriteThenThrowEntry);
  await assert.rejects(registry.migrateApiKeysToSystem(["ollama"], interruptedStore), /write failed/);
  const interrupted = JSON.parse(await fs.readFile(filename, "utf8")) as { credentialMigrationIntents?: Record<string, unknown>; credentials?: Record<string, string> };
  assert.ok(interrupted.credentialMigrationIntents?.ollama);
  assert.equal(interrupted.credentials?.ollama, "resume-secret");

  FakeCredentialEntry.failDeleteFor = undefined;
  const resumed = new ProviderRegistry(filename, store);
  await resumed.load();
  await resumed.migrateApiKeysToSystem(["ollama"], store);
  assert.equal(resumed.get("ollama")?.apiKey, "resume-secret");
  const completed = JSON.parse(await fs.readFile(filename, "utf8")) as { credentialMigrationIntents?: Record<string, unknown> };
  assert.deepEqual(completed.credentialMigrationIntents ?? {}, {});
});
