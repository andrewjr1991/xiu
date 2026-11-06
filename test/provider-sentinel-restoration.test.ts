import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { applyRestoredSession, type RestoredSessionConfigDeps } from "../src/commands/session-commands.js";
import { UNCONFIGURED_PROVIDER_PROFILE } from "../src/provider-registry.js";
import { loadSession } from "../src/session.js";

async function fixture(t: test.TestContext, providerId = UNCONFIGURED_PROVIDER_PROFILE.id, model = UNCONFIGURED_PROVIDER_PROFILE.model) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-sentinel-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "saved.jsonl");
  const body = `${JSON.stringify({ type: "task", task: "past task", config: { providerId: "old", provider: "openai", model: "old-model" } })}\n${JSON.stringify({ type: "provider_changed", provider: "openai", providerId, model })}\n`;
  await fs.writeFile(file, body, { mode: 0o600 });
  const restored = await loadSession(cwd, "saved");
  const config: AgentConfig = { cwd, provider: "openai", providerId: "current", model: "selected-model", autoApprove: false,
    capabilities: { text: "selected-model", vision: "selected-vision" }, contextWindow: 64000, contextWindowSource: "configured", contextLimit: 48000, contextLimitMode: "configured" };
  const provider = { async complete() { return { text: "done", toolCalls: [], raw: {} }; } };
  return { cwd, file, body, restored, config, provider };
}

for (const providerOverridden of [false, true]) {
  test(`CLI restoration ignores the inactive host's provider/model preference (override ${providerOverridden})`, async (t) => {
    const f = await fixture(t), before = structuredClone(f.config), lookups: string[] = [];
    const deps: RestoredSessionConfigDeps = { providerOverridden, providerRegistry: { get: (id) => { lookups.push(id); return undefined; } },
      profileConfig: () => { throw new Error("inactive host must not select a real profile"); } };
    applyRestoredSession(f.config, f.restored, deps);
    assert.deepEqual(f.config, before);
    assert.deepEqual(lookups, []);
  });
}

test("constructing a shared Agent from inactive history preserves the currently selected model and capabilities", async (t) => {
  const f = await fixture(t), before = structuredClone(f.config);
  const agent = new Agent({ config: f.config, provider: f.provider, tools: [], approve: async () => false, restored: f.restored });
  assert.deepEqual(f.config, before);
  assert.equal(agent.status().model, "selected-model");
  assert.equal(agent.status().sessionId, "saved");
});

test("restoring inactive history into an idle Agent does not replace its selected model", async (t) => {
  const f = await fixture(t), before = structuredClone(f.config);
  const agent = new Agent({ config: f.config, provider: f.provider, tools: [], approve: async () => false });
  agent.restoreSession(f.restored);
  assert.deepEqual(f.config, before);
  assert.equal(agent.status().model, "selected-model");
});

test("restoring an inactive history does not configure a host that is still inactive", async (t) => {
  const f = await fixture(t);
  f.config.providerId = UNCONFIGURED_PROVIDER_PROFILE.id;
  f.config.model = UNCONFIGURED_PROVIDER_PROFILE.model;
  f.config.capabilities = { text: "unconfigured", vision: "" };
  const agent = new Agent({ config: f.config, provider: { async complete() { throw new Error("configure before use"); } }, tools: [], approve: async () => false, restored: f.restored });
  assert.equal(agent.currentModel().providerId, UNCONFIGURED_PROVIDER_PROFILE.id);
  await assert.rejects(agent.run("answer only"), /configure before use/);
});

test("a real provider may use the literal model name unconfigured", async (t) => {
  const f = await fixture(t, "real-provider", "unconfigured");
  const agent = new Agent({ config: f.config, provider: f.provider, tools: [], approve: async () => false });
  agent.restoreSession(f.restored);
  assert.equal(agent.status().model, "unconfigured");
  assert.equal(f.config.capabilities?.text, "unconfigured");
  const target = { ...f.config, model: "selected-model" };
  applyRestoredSession(target, f.restored, { providerOverridden: true, providerRegistry: { get: () => undefined }, profileConfig: () => { throw new Error("not used"); } });
  assert.equal(target.model, "unconfigured");
});

test("inactive marker metadata remains available without rewriting its history", async (t) => {
  const f = await fixture(t);
  assert.equal(f.restored.providerId, UNCONFIGURED_PROVIDER_PROFILE.id);
  assert.equal(f.restored.model, UNCONFIGURED_PROVIDER_PROFILE.model);
  new Agent({ config: f.config, provider: f.provider, tools: [], approve: async () => false, restored: f.restored });
  assert.equal(await fs.readFile(f.file, "utf8"), f.body);
});
