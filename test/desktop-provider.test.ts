import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopProviderController } from "../apps/desktop/main/provider-controller.js";
import { credentialRef, type CredentialBackendStatus, type CredentialRef, type CredentialStore } from "../src/credential-store.js";
import { ProviderRegistry } from "../src/provider-registry.js";

class MemorySystemCredentialStore implements CredentialStore<string, "provider-api-key"> {
  readonly backend = "system" as const;
  readonly kind = "provider-api-key" as const;
  private readonly values = new Map<string, { value: string; revision: number }>();

  get(ref: CredentialRef<"provider-api-key">): string | undefined { return this.values.get(ref.id)?.value; }
  has(ref: CredentialRef<"provider-api-key">): boolean { return this.values.has(ref.id); }
  set(ref: CredentialRef<"provider-api-key">, value: string): CredentialRef<"provider-api-key"> {
    const revision = (this.values.get(ref.id)?.revision ?? ref.revision) + 1;
    this.values.set(ref.id, { value, revision });
    return credentialRef("system", this.kind, ref.id, revision);
  }
  delete(ref: CredentialRef<"provider-api-key">): boolean { return this.values.delete(ref.id); }
  list(): CredentialRef<"provider-api-key">[] { return [...this.values].map(([id, item]) => credentialRef("system", this.kind, id, item.revision)); }
  status(): CredentialBackendStatus { return { backend: "system", available: true, secure: true, entries: this.values.size }; }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-provider-"));
  const registryFile = path.join(root, "providers.json");
  const modelCacheFile = path.join(root, "model-cache.json");
  const system = new MemorySystemCredentialStore();
  const registry = new ProviderRegistry(registryFile, system);
  await registry.load();
  await registry.upsert({
    id: "office", name: "Office Gateway", kind: "openai-compatible", model: "office-default",
    baseURL: "https://models.example.test/v1", capabilityModels: { image: "office-image-default", audio: "office-tts-default" },
    features: { text: true, tools: true, vision: false, image: true, video: false, audio: true },
  });
  const controller = await DesktopProviderController.create({
    registry, systemCredentialStore: system,
    discover: async () => [
      { id: "office-fast", name: "Office Fast", source: "api", contextWindow: 64_000 },
      { id: "office-image-pro", name: "Office Image Pro", source: "api", capabilities: ["image"] },
      { id: "office-tts", name: "Office TTS", source: "api", capabilities: ["audio"] },
    ],
    test: async () => 1, modelCacheFile,
  });
  return { root, registryFile, modelCacheFile, system, registry, controller };
}

test("desktop provider snapshot exposes configuration state without credential material", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const initial = item.controller.snapshot();
  assert.equal(initial.profiles.some((candidate) => candidate.id === "office"), false, "unconfigured cloud providers stay hidden");
  assert.equal(initial.profiles.some((candidate) => candidate.id === "ollama"), false, "unused keyless providers stay hidden");
  const secret = "xiu-canary-provider-secret-48291";
  const saved = await item.controller.saveCredential({ providerId: "office", apiKey: secret });
  const profile = saved.profiles.find((candidate) => candidate.id === "office");
  assert.equal(profile?.credential.source, "system");
  assert.equal(profile?.credential.configured, true);
  assert.equal(saved.profiles[0]?.id, saved.activeProviderId, "the active provider stays first");
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  assert.equal(item.system.get(credentialRef("system", "provider-api-key", "provider:office:api-key", 1)), secret);
  assert.doesNotMatch(await fs.readFile(item.registryFile, "utf8"), new RegExp(secret));
});

test("desktop provider controller discovers models and persists an explicit selection", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const discovered = await item.controller.discover(item.root, { providerId: "office" });
  assert.equal(discovered.modelProviderId, "office");
  assert.ok(discovered.models.some((model) => model.id === "office-fast" && model.source === "api"));
  assert.ok(discovered.modelsByProvider.office?.some((model) => model.id === "office-fast"));
  assert.ok(discovered.capabilityModelsByProvider.office?.image.some((model) => model.id === "office-image-pro"));
  assert.ok(discovered.capabilityModelsByProvider.office?.audio.some((model) => model.id === "office-tts"));
  assert.ok(discovered.modelsByProvider.openai?.length, "other provider catalogs remain available");
  const selected = await item.controller.select({ providerId: "office", model: "office-fast" });
  assert.equal(selected.activeProviderId, "office");
  assert.equal(selected.activeModel, "office-fast");
  assert.equal(item.registry.activeId(), "office");
  assert.equal(item.registry.activeModel("office"), "office-fast");
  const mediaSelected = await item.controller.select({ providerId: "office", model: "office-image-pro", capability: "image" });
  assert.equal(mediaSelected.profiles.find((profile) => profile.id === "office")?.capabilityModels.image, "office-image-pro");
  assert.equal(item.registry.activeCapabilityModel("office", "image"), "office-image-pro");
  assert.deepEqual(await item.controller.test(item.root, { providerId: "office", model: "office-fast" }), {
    ok: true, message: "Office Gateway / office-fast 连接成功。", modelsDiscovered: 1,
  });
  const reloaded = await DesktopProviderController.create({
    registry: item.registry, systemCredentialStore: item.system, modelCacheFile: item.modelCacheFile,
    discover: async () => [], test: async () => 0,
  });
  assert.ok(reloaded.snapshot("office").modelsByProvider.office?.some((model) => model.id === "office-fast"), "discovered models survive controller restart");
  assert.ok(reloaded.snapshot("office").capabilityModelsByProvider.office?.audio.some((model) => model.id === "office-tts"), "discovered capability metadata survives controller restart");
  assert.equal(reloaded.snapshot("office").profiles.find((profile) => profile.id === "office")?.capabilityModels.image, "office-image-pro", "selected capability model survives controller restart");
});

test("a keyless provider becomes visible only after successful model discovery", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  assert.equal(item.controller.snapshot().profiles.some((candidate) => candidate.id === "ollama"), false);
  const discovered = await item.controller.discover(item.root, { providerId: "ollama" });
  const local = discovered.profiles.find((candidate) => candidate.id === "ollama");
  assert.equal(local?.credential.source, "not-required");
  assert.equal(local?.credential.configured, true);
});

test("desktop credential save fails closed when a secure system backend is unavailable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-provider-no-keyring-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registryFile = path.join(root, "providers.json");
  const registry = new ProviderRegistry(registryFile);
  await registry.load();
  const controller = await DesktopProviderController.create({ registry, discover: async () => [], test: async () => 0 });
  await assert.rejects(() => controller.saveCredential({ providerId: "openai", apiKey: "must-not-persist" }), /拒绝把新凭据降级保存为明文文件/);
  const onDisk = await fs.readFile(registryFile, "utf8").catch(() => "");
  assert.doesNotMatch(onDisk, /must-not-persist/);
});

test("desktop provider controller creates, edits, and deletes custom channels", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));

  const created = await item.controller.upsert({
    id: "team-gateway",
    name: "Team Gateway",
    kind: "openai-compatible",
    model: "team-default",
    baseURL: "https://team.example.test/v1",
    apiKey: "team-secret",
    features: { tools: true, vision: true, image: false, video: false },
  });
  const profile = created.profiles.find((candidate) => candidate.id === "team-gateway");
  assert.equal(profile?.name, "Team Gateway");
  assert.equal(profile?.credential.source, "system");
  assert.doesNotMatch(JSON.stringify(created), /team-secret/);

  const edited = await item.controller.upsert({
    existingId: "team-gateway",
    id: "team-gateway",
    name: "Team Gateway 2",
    kind: "openai-compatible",
    model: "team-default",
    baseURL: "https://team-2.example.test/v1",
    features: { tools: true, vision: false, image: false, video: false },
  });
  assert.equal(edited.profiles.find((candidate) => candidate.id === "team-gateway")?.name, "Team Gateway 2");

  const removed = await item.controller.delete({ providerId: "team-gateway", confirmed: true });
  assert.equal(removed.profiles.some((candidate) => candidate.id === "team-gateway"), false);
  assert.equal(item.system.has(credentialRef("system", "provider-api-key", "provider:team-gateway:api-key", 1)), false);
});

test("desktop provider controller edits a legacy mixed-case channel without changing its ID or credential", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await item.registry.upsert({
    id: "ChatGPT",
    name: "Legacy Gateway",
    kind: "openai-compatible",
    model: "legacy-model",
    baseURL: "https://legacy.example.test/v1",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  });
  await item.controller.saveCredential({ providerId: "ChatGPT", apiKey: "legacy-secret" });

  const edited = await item.controller.upsert({
    existingId: "ChatGPT",
    id: "ChatGPT",
    name: "Legacy Gateway 2",
    kind: "openai-compatible",
    model: "legacy-model",
    baseURL: "https://legacy-2.example.test/v1",
    features: { tools: true, vision: false, image: false, video: false },
  });

  assert.equal(edited.profiles.find((candidate) => candidate.id === "ChatGPT")?.name, "Legacy Gateway 2");
  assert.equal(item.system.get(credentialRef("system", "provider-api-key", "provider:ChatGPT:api-key", 1)), "legacy-secret");
  await assert.rejects(() => item.controller.upsert({
    existingId: "ChatGPT",
    id: "chatgpt",
    name: "Renamed Gateway",
    kind: "openai-compatible",
    model: "legacy-model",
    baseURL: "https://legacy-2.example.test/v1",
    features: { tools: true, vision: false, image: false, video: false },
  }), /Provider ID/);
});

test("desktop provider controller persists vendor-neutral media capability models", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const saved = await item.controller.upsert({
    id: "media-gateway",
    name: "Media Gateway",
    kind: "openai-compatible",
    model: "vendor-chat",
    baseURL: "https://media.example.test/v1",
    apiKey: "media-secret",
    capabilityModels: { vision: "vendor-vision", image: "vendor-image", video: "vendor-video", audio: "vendor-tts" },
    features: { tools: true, vision: true, image: true, video: true, audio: true },
  });
  const profile = saved.profiles.find((candidate) => candidate.id === "media-gateway");
  assert.deepEqual(profile?.capabilityModels, { vision: "vendor-vision", image: "vendor-image", video: "vendor-video", audio: "vendor-tts" });
  assert.deepEqual(profile?.features, { tools: true, vision: true, image: true, video: true, audio: true });
  assert.doesNotMatch(JSON.stringify(saved), /media-secret/);
});

test("desktop provider mutations protect built-in and active channels", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await assert.rejects(() => item.controller.upsert({
    existingId: "openai",
    id: "openai",
    name: "Replaced",
    kind: "openai-compatible",
    model: "gpt-test",
    features: { tools: true, vision: false, image: false, video: false },
  }), /内置(?: Provider|渠道)/);
  await assert.rejects(() => item.controller.delete({ providerId: "openai", confirmed: true }), /当前正在使用|内置(?: Provider|渠道)/);
});
