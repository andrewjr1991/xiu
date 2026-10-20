import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCapabilityProbe, CAPABILITY_PROBE_PROTOCOL_VERSION, type ModelCapabilityProbe } from "../src/capability-probe.js";
import { createProviderSession, type ProviderSessionContext, type ProviderSessionIo } from "../src/commands/provider-session.js";
import { resolveConfig, type AgentConfig } from "../src/config.js";
import type { UiLanguage } from "../src/i18n.js";
import type { SelectOption } from "../src/interactive-ui.js";
import type { ProviderProfile } from "../src/provider-registry.js";
import type { AgentTool, ModelProvider } from "../src/types.js";

const SECRET = "sk-session-secret-1234567890";

function profile(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return { id, name: id.toUpperCase(), kind: "openai", model: "m1", apiKey: SECRET, features: { text: true, tools: true, vision: false, image: false, video: false }, ...overrides };
}

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  return { logs, errors, restore: () => { console.log = originalLog; console.error = originalError; } };
}

interface Harness {
  context: ProviderSessionContext;
  calls: string[];
  profiles: Map<string, ProviderProfile>;
  probes: Map<string, ModelCapabilityProbe>;
  config: AgentConfig;
  script: { selections: Array<RegExp | undefined>; secrets: string[] };
  io: Partial<ProviderSessionIo>;
}

async function harness(t: test.TestContext, options: { language?: UiLanguage; interactive?: boolean; profiles?: ProviderProfile[] } = {}): Promise<Harness> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-session-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const calls: string[] = [];
  const profiles = new Map((options.profiles ?? [profile("p1"), profile("p2", { model: "m2" })]).map((item) => [item.id, item]));
  const probes = new Map<string, ModelCapabilityProbe>();
  const fakeProvider: ModelProvider = { async complete() { throw new Error("not used"); } };
  const profileConfig = (item: ProviderProfile, model?: string, discoveredContextWindow?: number) => {
    const resolved = resolveConfig({ cwd, provider: item.kind, providerId: item.id, providerLabel: item.name, model: model ?? item.model, apiKey: item.apiKey, contextWindow: discoveredContextWindow ? String(discoveredContextWindow) : undefined });
    if (discoveredContextWindow) resolved.contextWindowSource = "api";
    return resolved;
  };
  const config = profileConfig(profiles.get("p1") ?? profile("p1"));
  const script: Harness["script"] = { selections: [], secrets: [] };
  const io: Partial<ProviderSessionIo> = {
    interactive: () => options.interactive ?? false,
    env: {},
    select: async <T>(title: string, items: SelectOption<T>[]) => {
      calls.push(`select:${title}`);
      const matcher = script.selections.shift();
      if (!matcher) return undefined;
      const option = items.find((item) => matcher.test(item.label));
      assert.ok(option, `no option matching ${matcher} in ${items.map((item) => item.label).join(" | ")}`);
      return option.value;
    },
    ask: async () => "",
    askSecret: async () => { calls.push("askSecret"); return script.secrets.shift() ?? ""; },
    probeProvider: async (candidate) => {
      calls.push(`probe:${candidate.providerId}/${candidate.model}`);
      if (candidate.apiKey === "sk-broken") throw new Error(`401 Unauthorized for key ${candidate.apiKey}`);
      return { provider: fakeProvider, models: candidate.model === "local-model" ? [{ id: "llama-local", source: "api" as const, contextWindow: 32_000 }] : [{ id: candidate.model, source: "api" as const }] };
    },
    probeModelCapabilities: async (candidate) => {
      calls.push(`capabilities:${candidate.providerId}/${candidate.model}`);
      return { protocolVersion: CAPABILITY_PROBE_PROTOCOL_VERSION, providerId: candidate.providerId, model: candidate.model, checkedAt: new Date().toISOString(), text: "supported", tools: "supported", vision: "unsupported" };
    },
    createProvider: (candidate) => { calls.push(`create:${candidate.providerId}/${candidate.model}`); return fakeProvider; },
  };
  const context: ProviderSessionContext = {
    agent: {
      replaceProvider: async (next) => { calls.push(`agent:${next.providerId}/${next.model}`); Object.assign(config, next); },
      replaceTools: (tools) => { calls.push(`tools:${tools.length}`); },
    },
    config,
    language: () => options.language ?? "en-US",
    profileConfig,
    providerRegistry: {
      capabilityProbe: (id, model) => probes.get(`${id}/${model}`),
      setCapabilityProbe: async (probe) => { calls.push(`saveProbe:${probe.providerId}/${probe.model}:${probe.contextWindow ?? "-"}:${probe.contextWindowSource ?? "-"}`); probes.set(`${probe.providerId}/${probe.model}`, probe); },
      setActive: async (id, model) => { calls.push(`active:${id}/${model}`); },
      list: () => [...profiles.values()],
      get: (id) => profiles.get(id),
      setApiKey: async (id, apiKey) => { calls.push(`setApiKey:${id}:${apiKey === SECRET ? "same" : "new"}`); profiles.set(id, { ...profiles.get(id)!, apiKey }); },
      upsert: async (item) => { profiles.set(item.id, item); },
      remove: async (id) => { profiles.delete(id); },
    },
    refreshTools: () => { calls.push("refreshTools"); return [{ name: "t1" }, { name: "t2" }] as unknown as AgentTool[]; },
    runtimeProfile: (item, model = item.model) => ({ ...item, features: applyCapabilityProbe(item.features, probes.get(`${item.id}/${model}`)) }),
    status: { start: (label) => { calls.push(`status:${label}`); }, stop: () => { calls.push("status:stop"); } },
    io,
  };
  return { context, calls, profiles, probes, config, script, io };
}

test("feature names and probe summaries read the cached capability probe in the session language", async (t) => {
  const en = await harness(t);
  const session = createProviderSession(en.context);
  const p1 = en.profiles.get("p1")!;
  assert.equal(session.featureNames(p1), "text/tools");
  assert.equal(session.capabilityProbeSummary(p1), "capabilities not tested");
  assert.equal(session.compactCapabilityProbeSummary(p1), "not tested");
  en.probes.set("p1/m1", { providerId: "p1", model: "m1", checkedAt: "2026-10-20T10:00:00.000Z", text: "supported", tools: "supported", vision: "supported", contextWindow: 32_000, contextWindowSource: "api" });
  assert.equal(session.featureNames(p1), "text/tools/vision", "a verified probe adds the vision the profile did not declare");
  assert.match(session.capabilityProbeSummary(p1), /^Probe: tools supported · vision supported · context 32,000 \(API\) · /);
  assert.equal(session.compactCapabilityProbeSummary(p1), "tools supported / vision supported");
  en.probes.set("p1/m1", { ...en.probes.get("p1/m1")!, tools: "unsupported" });
  assert.equal(session.featureNames(p1), "text", "without tool calls the probe's vision cannot be used either");
  const zh = await harness(t, { language: "zh-CN" });
  zh.probes.set("p1/m1", en.probes.get("p1/m1")!);
  const zhSession = createProviderSession(zh.context);
  assert.equal(zhSession.featureNames(zh.profiles.get("p1")!), "文本");
  assert.equal(zhSession.compactCapabilityProbeSummary(zh.profiles.get("p1")!), "工具 不支持 / 视觉 支持");
});

test("switching a provider probes the connection, refreshes stale capabilities, swaps the agent's provider and tools, and persists only when asked", async (t) => {
  const h = await harness(t);
  const console_ = captureConsole();
  t.after(console_.restore);
  const session = createProviderSession(h.context);
  const p2 = h.profiles.get("p2")!;
  assert.equal(await session.switchProviderProfile(p2), true, console_.errors.join("\n"));
  assert.deepEqual(h.calls, [
    "status:Testing P2", "probe:p2/m2",
    "status:Probing tool and vision capabilities for m2", "capabilities:p2/m2", "saveProbe:p2/m2:-:-",
    "agent:p2/m2", "refreshTools", "tools:2", "active:p2/m2", "status:stop",
  ]);
  assert.equal(h.config.providerId, "p2");
  assert.match(console_.logs[0] ?? "", /Provider changed to P2, model m2\./);
  assert.match(console_.logs.join("\n"), /Capabilities: text\/tools · discovered 1 models/);
  // A fresh probe is reused and persist=false leaves the saved choice alone; forceCapabilityProbe runs it again.
  h.calls.length = 0;
  assert.equal(await session.switchProviderProfile(p2, false, "m2"), true);
  assert.ok(!h.calls.some((call) => call.startsWith("capabilities:")) && !h.calls.some((call) => call.startsWith("active:")), h.calls.join(","));
  h.calls.length = 0;
  assert.equal(await session.switchProviderProfile(p2, false, "m2", true), true);
  assert.ok(h.calls.includes("capabilities:p2/m2"));
  // A local server with no fixed model takes the first discovered one, recreates the provider for it, and keeps the API context window.
  h.calls.length = 0;
  const local = profile("local", { model: "local-model", apiKey: undefined });
  assert.equal(await session.switchProviderProfile(local), true);
  assert.ok(h.calls.includes("create:local/llama-local") && h.calls.includes("saveProbe:local/llama-local:32000:api") && h.calls.includes("agent:local/llama-local") && h.calls.includes("active:local/llama-local"), h.calls.join(","));
  assert.match(console_.logs.join("\n"), /Context: 32,000 · compact at 25,600 \(api\)/);
  assert.equal(console_.errors.length, 0);
});

test("a failed connection keeps the current provider, stops the status line and never prints the key", async (t) => {
  const h = await harness(t);
  const console_ = captureConsole();
  t.after(console_.restore);
  const session = createProviderSession(h.context);
  const broken = profile("p3", { apiKey: "sk-broken" });
  assert.equal(await session.switchProviderProfile(broken), false);
  assert.equal(h.calls.at(-1), "status:stop");
  assert.ok(!h.calls.some((call) => call.startsWith("agent:")), "the agent keeps its provider");
  assert.equal(h.config.providerId, "p1");
  assert.match(console_.errors[0] ?? "", /Provider connection failed/);
  assert.doesNotMatch(console_.errors.join("\n"), /sk-broken/);
});

test("startup without a usable provider: pipes get hints only, a terminal can save a key or pick another provider, and leaving keeps setup mode", async (t) => {
  const piped = await harness(t);
  const console_ = captureConsole();
  t.after(console_.restore);
  const error = new Error("missing credentials");
  assert.equal(await createProviderSession(piped.context).configureStartupProvider(error), false);
  assert.match(console_.logs[0] ?? "", /The current provider P1 is not configured \(missing credentials\)\. Xiu is staying open in setup mode\./);
  assert.ok(!piped.calls.some((call) => call.startsWith("select:")), "a piped session is never prompted");

  const empty = await harness(t, { profiles: [] });
  assert.equal(await createProviderSession(empty.context).configureStartupProvider(error), false);
  assert.match(console_.logs.at(-1) ?? "", /No Providers added\. Enter \/provider add/);

  const terminal = await harness(t, { interactive: true });
  const session = createProviderSession(terminal.context);
  terminal.script.selections.push(/Configure later/);
  assert.equal(await session.configureStartupProvider(error), false);
  assert.equal(terminal.calls.filter((call) => call.startsWith("select:")).length, 1);

  terminal.calls.length = 0;
  terminal.script.selections.push(/Configure the API key for P1/);
  terminal.script.secrets.push("sk-new-key-123456789012");
  assert.equal(await session.configureStartupProvider(error), true, console_.errors.join("\n"));
  assert.ok(terminal.calls.includes("askSecret") && terminal.calls.includes("setApiKey:p1:new") && terminal.calls.includes("agent:p1/m1") && terminal.calls.includes("active:p1/m1"), terminal.calls.join(","));

  terminal.calls.length = 0;
  terminal.script.selections.push(/Configure the API key/);
  terminal.script.secrets.push("");
  assert.equal(await session.configureStartupProvider(error), false, "an empty key cancels without touching the registry");
  assert.ok(!terminal.calls.some((call) => call.startsWith("setApiKey:")));

  terminal.calls.length = 0;
  terminal.script.selections.push(/Choose another provider/, /^P2$/);
  assert.equal(await session.configureStartupProvider(error), true, console_.errors.join("\n"));
  assert.ok(terminal.calls.includes("agent:p2/m2") && terminal.calls.includes("active:p2/m2"), terminal.calls.join(","));

  terminal.calls.length = 0;
  terminal.script.selections.push(/Choose another provider/, undefined);
  assert.equal(await session.configureStartupProvider(error), false, "Esc in the provider list changes nothing");
  assert.ok(!terminal.calls.some((call) => call.startsWith("agent:")));
  assert.equal(console_.errors.length, 0);
});

test("startup with no channel in a terminal runs the wizard, and leaving it falls back to the hint", async (t) => {
  const h = await harness(t, { interactive: true, profiles: [] });
  const console_ = captureConsole();
  t.after(console_.restore);
  h.script.selections.push(undefined);
  assert.equal(await createProviderSession(h.context).configureStartupProvider(new Error("none")), false);
  assert.ok(h.calls.some((call) => call.startsWith("select:")), "the wizard's first step was shown");
  assert.match(console_.logs.at(-1) ?? "", /No Providers added\. Enter \/provider add/);
});
