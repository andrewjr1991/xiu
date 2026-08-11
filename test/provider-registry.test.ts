import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILTIN_PROVIDER_PROFILES, ProviderRegistry, resolveStartupModel, resolveStartupProviderId, validateProviderProfile } from "../src/provider-registry.js";

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
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).version, 2);
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
  assert.equal(stored.version, 2);
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
