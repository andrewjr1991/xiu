import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILTIN_PROVIDER_PROFILES, ProviderRegistry, validateProviderProfile } from "../src/provider-registry.js";

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
  await registry.setActive("office-gateway");
  const saved = await fs.readFile(filename, "utf8");
  assert.match(saved, /OFFICE_MODEL_KEY/);
  assert.match(saved, /"credentials"/);
  assert.match(saved, /saved-local-secret/);
  assert.doesNotMatch(saved, /"apiKey"/);

  const restored = new ProviderRegistry(filename);
  await restored.load();
  assert.equal(restored.activeId(), "office-gateway");
  assert.equal(restored.get("office-gateway")?.baseURL, "https://models.example.test/v1");
  assert.equal(restored.get("office-gateway")?.apiKey, "saved-local-secret");

  await restored.upsert({
    ...restored.get("office-gateway")!, name: "Edited Gateway", apiKey: undefined,
  });
  assert.equal(restored.get("office-gateway")?.name, "Edited Gateway");
  assert.equal(restored.get("office-gateway")?.apiKey, "saved-local-secret");
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
