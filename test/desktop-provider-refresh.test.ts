import assert from "node:assert/strict";
import test from "node:test";
import { DesktopProviderController } from "../apps/desktop/main/provider-controller.js";
import { ProviderRegistry, type ProviderProfile } from "../src/provider-registry.js";
import { ProviderConfigurationError } from "../src/provider-config-migration.js";

// Controller-contract fixture only. Real protected-storage tests remain separate.
function fixture(restored = false) {
  let loads = 0;
  let writes = 0;
  let blocked = false;
  let model = "original";
  const profile: ProviderProfile = { id: "fixture", name: "Fixture", kind: "openai-compatible", model: "original", features: { text: true, tools: true, vision: false, image: false, video: false } };
  const registry = new ProviderRegistry();
  registry.list = () => [profile];
  registry.get = () => profile;
  registry.activeId = () => profile.id;
  registry.activeModel = () => model;
  registry.load = async () => {
    loads += 1;
    if (restored) throw new ProviderConfigurationError("restart", "private-canary");
    blocked = false;
  };
  registry.setActive = async (_id, selected) => {
    if (restored) throw new ProviderConfigurationError("restart", "private-canary");
    if (blocked) throw new ProviderConfigurationError("reload", "private-canary");
    writes += 1;
    if (writes === 1) { blocked = true; throw new ProviderConfigurationError("io", "private-canary"); }
    model = selected!;
  };
  return { registry, state: () => ({ loads, writes, model }) };
}

test("picker refresh enables a new explicit selection, never automatically retries the failed write", async () => {
  const f = fixture();
  const controller = await DesktopProviderController.create({ registry: f.registry });
  await assert.rejects(controller.select({ providerId: "fixture", model: "selected" }), /配置保存失败/);
  await assert.rejects(controller.select({ providerId: "fixture", model: "selected" }), /重新打开模型选择器/);
  assert.deepEqual(f.state(), { loads: 0, writes: 1, model: "original" });
  assert.equal((await controller.refresh()).activeModel, "original");
  assert.deepEqual(f.state(), { loads: 1, writes: 1, model: "original" });
  assert.equal((await controller.select({ providerId: "fixture", model: "selected" })).activeModel, "selected");
  assert.equal(f.state().writes, 2);
});

test("restored configuration rejects both picker refresh and selection until restart", async () => {
  const f = fixture(true);
  const controller = await DesktopProviderController.create({ registry: f.registry });
  await assert.rejects(controller.refresh(), /必须退出.*重新打开/);
  await assert.rejects(controller.select({ providerId: "fixture", model: "selected" }), /必须退出.*重新打开/);
  assert.deepEqual(f.state(), { loads: 1, writes: 0, model: "original" });
});
