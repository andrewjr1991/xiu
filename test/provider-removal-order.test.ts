import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { handleProviderCommand, type ProviderCommandContext } from "../src/commands/provider-commands.js";
import { ProviderRegistry, UNCONFIGURED_PROVIDER_PROFILE } from "../src/provider-registry.js";
import { StatusLine } from "../src/status.js";

async function fixture(t: test.TestContext, answer = "yes\n") {
  t.mock.method(console, "log", () => {});
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-removal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const filename = path.join(root, "state", "providers.json");
  await fs.mkdir(path.dirname(filename), { mode: 0o700 });
  const registry = new ProviderRegistry(filename);
  await registry.load();
  const profile = { id: "old", name: "Offline fixture", kind: "openai" as const, model: "old-model",
    features: { text: true as const, tools: false, vision: false, image: false, video: false }, builtin: false };
  await registry.upsert(profile);
  await registry.setApiKey("old", "removal-credential-canary-L5_Sb29");
  await registry.setActive("old", "old-model");
  const config: AgentConfig = { cwd, provider: "openai", providerId: "old", model: "old-model", autoApprove: true, apiKey: "removal-credential-canary-L5_Sb29" };
  const agent = new Agent({ config, provider: { async complete() { return { text: "done", toolCalls: [], raw: {} }; } }, tools: [], approve: async () => false });
  await agent.run("answer only");
  const session = path.join(cwd, ".xiu", "sessions", `${agent.status().sessionId}.jsonl`);
  const calls: string[] = [];
  const ctx: ProviderCommandContext = {
    agent, config, providerRegistry: registry, language: "en-US", startupProfile: profile,
    profileConfig: () => ({ cwd, provider: "openai", providerId: UNCONFIGURED_PROVIDER_PROFILE.id, model: "unconfigured", autoApprove: false, apiKey: undefined, apiKeyEnv: undefined } satisfies AgentConfig),
    rebuildBaseTools: () => { calls.push("tools"); }, attachMcpTools: () => { calls.push("mcp"); },
    compactCapabilityProbeSummary: () => "", featureNames: () => "", status: new StatusLine(),
    switchProviderProfile: async () => { throw new Error("unexpected provider picker"); },
    removalPromptStreams: { input: Readable.from([answer]), output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }) },
  };
  return { root, cwd, filename, registry, agent, config, session, ctx, calls };
}

test("failed runtime deactivation preserves the selected provider and credential file", async (t) => {
  const f = await fixture(t), before = await fs.readFile(f.filename, "utf8");
  await fs.rename(f.session, `${f.session}.backup`);
  await fs.mkdir(f.session);
  await assert.rejects(handleProviderCommand("/provider remove", f.ctx));
  assert.equal(await fs.readFile(f.filename, "utf8"), before);
  assert.equal(f.registry.get("old")?.id, "old");
  assert.equal(f.agent.currentModel().providerId, "old");
  assert.deepEqual(f.calls, []);
});

test("selected provider transport and tools are disabled before credential removal starts", async (t) => {
  const f = await fixture(t), original = f.registry.remove.bind(f.registry);
  t.mock.method(f.registry, "remove", async (id: string) => {
    assert.equal(f.agent.currentModel().providerId, UNCONFIGURED_PROVIDER_PROFILE.id);
    assert.equal(f.config.apiKey, undefined);
    assert.deepEqual(f.calls, ["tools", "mcp"]);
    await assert.rejects(f.agent.currentModel().provider.complete("", [], []), /configure a Provider/);
    return original(id);
  });
  assert.equal(await handleProviderCommand("/provider remove", f.ctx), true);
  assert.equal(f.registry.get("old"), undefined);
});

test("credential removal failure leaves the runtime inert and does not reactivate its old transport", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.registry, "remove", async () => { throw new Error("fixture registry removal failed"); });
  await assert.rejects(handleProviderCommand("/provider remove", f.ctx), /fixture registry removal failed/);
  assert.equal(f.agent.currentModel().providerId, UNCONFIGURED_PROVIDER_PROFILE.id);
  assert.equal(f.config.apiKey, undefined);
  assert.equal(f.registry.get("old")?.id, "old");
});

for (const answer of ["no\n", "\n"]) {
  test(`provider removal still needs a typed yes even with autoApprove (${JSON.stringify(answer)})`, async (t) => {
    const f = await fixture(t, answer), before = await fs.readFile(f.filename, "utf8");
    assert.equal(await handleProviderCommand("/provider remove", f.ctx), true);
    assert.equal(await fs.readFile(f.filename, "utf8"), before);
    assert.equal(f.agent.currentModel().providerId, "old");
    assert.deepEqual(f.calls, []);
  });
}

test("EOF before a typed confirmation preserves the selected provider and credential", async (t) => {
  const f = await fixture(t, ""), before = await fs.readFile(f.filename, "utf8");
  await assert.rejects(handleProviderCommand("/provider remove", f.ctx), { code: "input/ended" });
  assert.equal(await fs.readFile(f.filename, "utf8"), before);
  assert.equal(f.agent.currentModel().providerId, "old");
  assert.deepEqual(f.calls, []);
});

test("removing a different profile does not disable the currently selected transport", async (t) => {
  const f = await fixture(t);
  await f.registry.upsert({ id: "live", name: "Zulu active fixture", kind: "openai", model: "live-model",
    features: { text: true, tools: false, vision: false, image: false, video: false }, builtin: false });
  await f.agent.replaceProvider({ ...f.config, providerId: "live", model: "live-model", apiKey: "live-credential-canary" }, { async complete() { return { text: "live done", toolCalls: [], raw: {} }; } });
  await handleProviderCommand("/provider remove", f.ctx);
  assert.equal(f.registry.get("old"), undefined);
  assert.equal(f.registry.get("live")?.id, "live");
  assert.equal(f.agent.currentModel().providerId, "live");
  assert.deepEqual(f.calls, []);
});
