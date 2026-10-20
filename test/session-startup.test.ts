import assert from "node:assert/strict";
import test from "node:test";
import { applyRestoredSession, printSessionList, type RestoredSessionConfigDeps } from "../src/commands/session-commands.js";
import type { AgentConfig } from "../src/config.js";
import type { ProviderProfile } from "../src/provider-registry.js";
import type { SessionListItem } from "../src/session.js";

const profile = (id: string, model: string): ProviderProfile => ({ id, name: id, kind: "openai", model } as unknown as ProviderProfile);

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { provider: "openai", providerId: "office", model: "gpt-a", capabilities: { text: "gpt-a", vision: "gpt-a" }, cwd: "/w", ...overrides } as unknown as AgentConfig;
}

function deps(overrides: Partial<RestoredSessionConfigDeps> = {}) {
  const calls: string[] = [];
  const profiles = new Map([["lab", profile("lab", "lab-default")]]);
  const value: RestoredSessionConfigDeps = {
    providerRegistry: { get: (id: string) => profiles.get(id) },
    profileConfig: (selected, model) => { calls.push(`profileConfig:${selected.id}:${model ?? "-"}`); return config({ providerId: selected.id, model: model ?? selected.model, capabilities: { text: model ?? selected.model, vision: "lab-vision" } }); },
    providerOverridden: false,
    ...overrides,
  };
  return { value, calls };
}

test("a restored session switches to its provider and model, and the capabilities follow", () => {
  const target = config();
  const d = deps();
  applyRestoredSession(target, { providerId: "lab", model: "lab-x" }, d.value);
  assert.deepEqual(d.calls, ["profileConfig:lab:lab-x"]);
  assert.equal(target.providerId, "lab");
  assert.equal(target.model, "lab-x");
  assert.deepEqual(target.capabilities, { text: "lab-x", vision: "lab-vision" });
});

test("--provider on the command line keeps its provider; only the model and the capabilities that followed it move", () => {
  const target = config();
  const d = deps({ providerOverridden: true });
  applyRestoredSession(target, { providerId: "lab", model: "gpt-b" }, d.value);
  assert.deepEqual(d.calls, []);
  assert.equal(target.providerId, "office");
  assert.equal(target.model, "gpt-b");
  assert.deepEqual(target.capabilities, { text: "gpt-b", vision: "gpt-b" }, "vision followed the text model, so it moves too");

  const separateVision = config({ capabilities: { text: "gpt-a", vision: "see-1" } });
  applyRestoredSession(separateVision, { model: "gpt-b" }, d.value);
  assert.deepEqual(separateVision.capabilities, { text: "gpt-b", vision: "see-1" }, "a separately configured vision model stays");
});

test("an unknown provider id, a missing model or no session leave the config alone", () => {
  const target = config();
  const d = deps();
  applyRestoredSession(target, { providerId: "gone", model: undefined }, d.value);
  applyRestoredSession(target, undefined, d.value);
  applyRestoredSession(target, { providerId: undefined, model: "gpt-a" }, d.value);
  assert.deepEqual(d.calls, []);
  assert.deepEqual(target, config());
});

test("--list-sessions prints one line per session, the unknown-model fallback and the unreadable note", async () => {
  const sessions: SessionListItem[] = [
    { id: "s-1", file: "s-1.jsonl", createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T09:05:00.000Z", firstTask: "  rename   the helpers  ", model: "gpt-a", providerId: "office", size: 10 },
    { id: "s-2", file: "s-2.jsonl", createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:01:00.000Z", firstTask: "", size: 5 },
  ];
  const logs: string[] = [];
  await printSessionList("/w", "en-US", { list: async () => ({ sessions, unreadable: [{ id: "bad", reason: "EACCES" }] }), log: (line) => { logs.push(line); } });
  assert.equal(logs.length, 3);
  assert.match(logs[0]!, /^s-1 {2}\S+ \S+ {2}gpt-a {2}rename the helpers$/);
  assert.match(logs[1]!, /^s-2 {2}\S+ \S+ {2}unknown model {2}Untitled session$/);
  assert.equal(logs[2], "1 more session log(s) could not be read (EACCES ×1) and are not listed.");

  const empty: string[] = [];
  await printSessionList("/w", "zh-CN", { list: async () => ({ sessions: [], unreadable: [] }), log: (line) => { empty.push(line); } });
  assert.deepEqual(empty, ["此工作区没有 Xiu 会话。"]);
});
