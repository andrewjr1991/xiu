import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillRegistry } from "../src/skills.js";
import { WorkspaceManagementService } from "../src/runtime/workspace-management.js";
import { createProviderPolicy } from "../src/runtime/provider-policy.js";
import { resolveConfig } from "../src/config.js";
import type { ProviderProfile, ProviderRegistry } from "../src/provider-registry.js";
import { SettingsStore, XIU_BETA_SEARCH_AUTH_ENDPOINT, XIU_BETA_SEARXNG_ENDPOINT, XIU_BETA_SEARXNG_TOKEN_ENV, type XiuSettings } from "../src/settings.js";
import { zipFixture } from "./helpers/skill-zip.js";

function fixture(realSkills?: SkillRegistry, initial?: XiuSettings) {
  let settings: XiuSettings = initial ?? { webSearch: { enabled: false, provider: "searxng", baseURL: "https://search.example.test", blockedDomains: ["blocked.test"], timeoutMs: 4_000 } };
  let routing = { enabled: false, phases: {} as Record<string, string> };
  const chains: Record<string, string[]> = { primary: ["unsupported", "fallback"] };
  const profiles: ProviderProfile[] = ["primary", "unsupported", "fallback"].map((id) => ({ id, name: id, model: "fixture-model", kind: "openai", apiKey: "inert-canary-no-request", features: { text: true, tools: id !== "unsupported", vision: false, image: false, video: false } }));
  const registry = {
    list: () => profiles, get: (id: string) => profiles.find((item) => item.id === id), activeModel: () => undefined, capabilityProbe: () => undefined,
    routingPolicy: () => structuredClone(routing), failoverChain: (id: string) => chains[id] ?? [],
    setRoutingEnabled: async (enabled: boolean) => { routing.enabled = enabled; },
    setRoutingPhase: async (phase: string, id?: string) => { if (id && !profiles.some((item) => item.id === id)) throw new Error("Missing provider"); if (id) routing.phases[phase] = id; else delete routing.phases[phase]; },
    setFailoverChain: async (id: string, chain: string[]) => { chains[id] = chain; },
  } as unknown as ProviderRegistry;
  const store = { load: async () => structuredClone(settings), save: async (value: XiuSettings) => { settings = structuredClone(value); } } as unknown as SettingsStore;
  const skills = { list: () => [{ name: "fixture", description: "inert-canary-no-request", scope: "global", permissions: ["instructions:load"], permissionWarnings: [] }] } as unknown as SkillRegistry;
  return { service: new WorkspaceManagementService(registry, realSkills ?? skills, store), registry, settings: () => settings };
}

test("local skill preview copies immutable bytes, requires confirmation and never overwrites", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-management-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  const source = path.join(root, "source");
  const installed = path.join(root, "installed");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: fixture-install\ndescription: first\n---\nFirst staged content");
  const marker = path.join(root, "must-not-execute");
  await fs.writeFile(path.join(source, "install.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`);
  const skills = new SkillRegistry(root, installed);
  const { service } = fixture(skills);
  t.after(() => service.close());
  const preview = await service.prepareSkill(source);
  assert.equal(JSON.stringify(preview).includes(source), false);
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(installed));
  await fs.writeFile(path.join(source, "SKILL.md"), "changed after preview");
  await service.change({ action: "skill-install", revision: preview.revision, token: preview.token, confirmed: true });
  assert.match(await fs.readFile(path.join(installed, "fixture-install", "SKILL.md"), "utf8"), /First staged content/);
  await assert.rejects(fs.stat(marker));
  await assert.rejects(service.change({ action: "skill-install", revision: preview.revision, token: preview.token, confirmed: true }));
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: fixture-install\n---\nSecond content");
  await assert.rejects(service.prepareSkill(source), /already exists/);
});

test("skill preview cancellation and wrong token leave installed directory untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-management-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const installed = path.join(root, "installed");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: fixture-cancel\n---\nNever execute");
  const { service } = fixture(new SkillRegistry(root, installed));
  t.after(() => service.close());
  const first = await service.prepareSkill(source);
  await service.cancelSkillPreview();
  await assert.rejects(service.change({ action: "skill-install", revision: first.revision, token: first.token, confirmed: true }));
  const second = await service.prepareSkill(source);
  await assert.rejects(service.change({ action: "skill-install", revision: second.revision, token: "wrong", confirmed: true }));
  await assert.rejects(service.change({ action: "skill-install", revision: second.revision, token: second.token, confirmed: true }));
  await assert.rejects(fs.stat(installed));
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: inert-canary-no-request\n---\nMetadata must not expose a known credential");
  const safe = await service.prepareSkill(source);
  assert.equal(JSON.stringify(safe).includes("inert-canary-no-request"), false);
});

test("ZIP and standalone skill previews install only staged bytes after explicit confirmation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-management-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  const installed = path.join(root, "installed");
  const { service } = fixture(new SkillRegistry(root, installed));
  t.after(() => service.close());
  const source = path.join(root, "bundle.zip");
  await fs.writeFile(source, zipFixture([{ name: "bundle/SKILL.md", data: "---\nname: zipped\n---\nOriginal bytes", method: 8 },
    { name: "bundle/references/help.md", data: "Original resource" }]));
  const preview = await service.prepareSkill(source);
  assert.deepEqual(preview.skills.map((item) => item.name), ["zipped"]);
  assert.equal(JSON.stringify(preview).includes(source), false);
  await assert.rejects(fs.stat(installed));
  await fs.writeFile(source, "changed archive after preview");
  await assert.rejects(service.change({ action: "skill-install", token: preview.token, revision: preview.revision, confirmed: false as never }));
  const freshSource = path.join(root, "single");
  await fs.mkdir(freshSource);
  await fs.writeFile(path.join(freshSource, "SKILL.md"), "---\nname: standalone\n---\nSelected file");
  await fs.writeFile(path.join(freshSource, "private.txt"), "Do not import");
  const single = await service.prepareSkill(path.join(freshSource, "SKILL.md"));
  await service.change({ action: "skill-install", token: single.token, revision: single.revision, confirmed: true });
  assert.deepEqual(await fs.readdir(path.join(installed, "standalone")), ["SKILL.md"]);
  await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: "---\nname: zipped\n---\nOriginal bytes" },
    { name: "references/help.md", data: "Original resource" }]));
  const zip = await service.prepareSkill(source);
  await fs.unlink(source);
  await service.change({ action: "skill-install", token: zip.token, revision: zip.revision, confirmed: true });
  assert.match(await fs.readFile(path.join(installed, "zipped/SKILL.md"), "utf8"), /Original bytes/);
  assert.equal(await fs.readFile(path.join(installed, "zipped/references/help.md"), "utf8"), "Original resource");
  await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: "---\nname: zipped\n---\nReplacement" }]));
  await assert.rejects(service.prepareSkill(source), /already exists/);
});

test("invalid ZIP leaves no staged preview or installed files and permits retry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-management-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { service } = fixture(new SkillRegistry(root, path.join(root, "installed")));
  t.after(() => service.close());
  const source = path.join(root, "bad.zip");
  const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("xiu-skill-preview-")));
  await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: "---\nname: safe\n---\nValid" }, { name: "../escape", data: "bad" }]));
  await assert.rejects(service.prepareSkill(source));
  assert.deepEqual(new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("xiu-skill-preview-"))), before);
  await assert.rejects(fs.stat(path.join(root, "installed")));
  await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: "---\nname: safe\n---\nValid" }]));
  const retry = await service.prepareSkill(source);
  await service.cancelSkillPreview();
  await assert.rejects(service.change({ action: "skill-install", token: retry.token, revision: retry.revision, confirmed: true }));
});

test("management snapshots contain bounded metadata, not known provider credentials or source paths", async () => {
  const { service } = fixture();
  const snapshot = await service.snapshot();
  assert.equal(JSON.stringify(snapshot).includes("inert-canary-no-request"), false);
  assert.equal(JSON.stringify(snapshot).includes('"apiKey"'), false);
  assert.equal(JSON.stringify(snapshot).includes('"file"'), false);
});

test("disabling implicit beta search remains disabled after settings reload", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-management-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(path.join(root, "settings.json"), { [XIU_BETA_SEARXNG_TOKEN_ENV]: "inert-value" });
  await store.save({ webSearch: { enabled: false, provider: "searxng", baseURL: XIU_BETA_SEARXNG_ENDPOINT, apiKeyEnv: XIU_BETA_SEARXNG_TOKEN_ENV } });
  assert.equal((await store.load()).webSearch?.enabled, false);
});

test("management mutations reject stale revisions and malformed route fields", async () => {
  const { service } = fixture();
  const initial = await service.snapshot();
  await service.change({ action: "routing", revision: initial.revision, enabled: true });
  await assert.rejects(service.change({ action: "routing", revision: initial.revision, enabled: false }), /刷新/);
  const latest = await service.snapshot();
  await assert.rejects(service.change({ action: "stage", revision: latest.revision, phase: "invalid" as never }), /Invalid/);
  await assert.rejects(service.change({ action: "routing", revision: latest.revision, enabled: "true" as never }), /Invalid/);
});

test("explicit web configuration retains domain/timeout controls and refuses URL credentials and raw keys", async () => {
  const { service, settings } = fixture();
  const revision = (await service.snapshot()).revision;
  const draft = { action: "web" as const, revision, enabled: true, provider: "brave" as const, endpoint: "https://search.example.test" };
  await assert.rejects(service.change({ ...draft, endpoint: "https://user:secret@search.example.test" }));
  await assert.rejects(service.change({ ...draft, endpoint: "https://search.example.test/?token=secret" }));
  await assert.rejects(service.change({ ...draft, apiKeyEnv: "a-secret-value!" }));
  await service.change({ ...draft, apiKeyEnv: "BRAVE_API_KEY" });
  assert.deepEqual(settings().webSearch?.blockedDomains, ["blocked.test"]);
  assert.equal(settings().webSearch?.timeoutMs, 4_000);
  assert.equal(settings().webSearch?.managedAuth, undefined);
});

test("desktop explicitly selects pinned managed search without clearing domain/timeout/proxy policy", async () => {
  const { service, settings } = fixture(undefined, { webSearch: { enabled: true, provider: "searxng", baseURL: XIU_BETA_SEARXNG_ENDPOINT,
    apiKeyEnv: "SEARCH_MCP_TOKEN", blockedDomains: ["blocked.test"], timeoutMs: 4_000, proxy: "http://127.0.0.1:8888" } });
  const request = { action: "web" as const, revision: (await service.snapshot()).revision, mode: "managed" as const,
    enabled: true, provider: "searxng" as const, endpoint: XIU_BETA_SEARXNG_ENDPOINT };
  await assert.rejects(service.change({ ...request, endpoint: "https://other.example.test" }), /固定/);
  await assert.rejects(service.change({ ...request, apiKeyEnv: "SEARCH_MCP_TOKEN" }), /无需/);
  await assert.rejects(service.change({ ...request, mode: "invalid" as never }), /Invalid/);
  await service.change(request);
  assert.deepEqual(settings().webSearch, { enabled: true, provider: "searxng", baseURL: `${XIU_BETA_SEARXNG_ENDPOINT}/`,
    apiKeyEnv: undefined, managedAuth: "xiu-device", authBaseURL: XIU_BETA_SEARCH_AUTH_ENDPOINT,
    blockedDomains: ["blocked.test"], timeoutMs: 4_000, proxy: "http://127.0.0.1:8888" });
  assert.equal((await service.snapshot()).web.managed, true);
  assert.doesNotMatch(JSON.stringify(await service.snapshot()), /deviceSecret|accessToken|authBaseURL/);
  // Old clients can re-save/disable, but cannot silently replace managed auth.
  const revision = (await service.snapshot()).revision;
  await assert.rejects(service.change({ ...request, revision, mode: undefined, endpoint: "https://other.example.test" }), /明确/);
  await service.change({ ...request, revision, mode: undefined, enabled: false });
  assert.equal(settings().webSearch?.managedAuth, "xiu-device");
  assert.equal(settings().webSearch?.enabled, false);
  await service.change({ ...request, revision: (await service.snapshot()).revision, mode: "custom", endpoint: "https://custom.example.test", apiKeyEnv: "CUSTOM_SEARCH_KEY" });
  assert.equal(settings().webSearch?.managedAuth, undefined);
  assert.equal(settings().webSearch?.authBaseURL, undefined);
  assert.equal(settings().webSearch?.apiKeyEnv, "CUSTOM_SEARCH_KEY");
});

test("shared policy skips unsupported or attempted fallback models and refuses oversized context", async () => {
  const { registry } = fixture();
  const policy = createProviderPolicy(registry, (profile, model) => resolveConfig({ provider: profile.kind, providerId: profile.id, model, apiKey: profile.apiKey, contextWindow: "8192" }), () => []);
  const request = { originProviderId: "primary", currentProviderId: "primary", attemptedProviderIds: ["primary"], error: new Error("fixture"), estimatedInputTokens: 100, requiresTools: true };
  assert.equal((await policy.failover.resolve(request)).candidate?.config.providerId, "fallback");
  assert.equal((await policy.failover.resolve({ ...request, attemptedProviderIds: ["primary", "fallback"] })).candidate, undefined);
  assert.equal((await policy.failover.resolve({ ...request, estimatedInputTokens: 100_000 })).candidate, undefined);
});

test("shared stage routing restores default when the next phase is unassigned", async () => {
  const { registry } = fixture();
  await registry.setRoutingEnabled(true);
  const policy = createProviderPolicy(registry, (profile, model) => resolveConfig({ provider: profile.kind, providerId: profile.id, model, apiKey: profile.apiKey }), () => []);
  const resolution = await policy.routing.resolve({ phase: "implementation", currentProviderId: "fallback", currentModel: "fixture-model", defaultProviderId: "primary", defaultModel: "fixture-model", estimatedInputTokens: 100, requiresTools: true });
  assert.equal(resolution.useDefault, true);
  assert.equal(resolution.targetProviderId, "primary");
});
