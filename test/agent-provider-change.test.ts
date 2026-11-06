import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { TaskPlanManager } from "../src/plan.js";
import { loadSession } from "../src/session.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function pauseEvent(t: test.TestContext, type: string) {
  const entered = deferred(), release = deferred();
  const original = fs.open.bind(fs);
  let held = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (typeof args[1] === "number" && (args[1] & constants.O_APPEND)) {
      const append = handle.appendFile.bind(handle);
      t.mock.method(handle, "appendFile", async (...data: Parameters<typeof handle.appendFile>) => {
        if (!held && String(data[0]).includes(`"type":"${type}"`)) { held = true; entered.resolve(); await release.promise; }
        return append(...data);
      });
    }
    return handle;
  });
  return { entered, release };
}
async function fixture(t: test.TestContext) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-change-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const config: AgentConfig = { cwd, provider: "openai", providerId: "old", model: "old-model", autoApprove: false, language: "en-US",
    apiKey: "old-credential-canary-H7_Dq92", capabilities: { text: "old-model", vision: "old-model" } };
  const provider = { async complete() { return { text: "done", toolCalls: [], raw: {} }; } };
  const nextProvider = { async complete() { return { text: "next done", toolCalls: [], raw: {} }; } };
  const agent = new Agent({ config, provider, tools: [], approve: async () => false, planManager: new TaskPlanManager() });
  await agent.run("answer only");
  const restored = await loadSession(cwd, agent.status().sessionId);
  const next: AgentConfig = { ...structuredClone(config), providerId: "next", model: "next-model", apiKey: "next-credential-canary-K6_Fs34",
    capabilities: { text: "next-model", vision: "next-model" } };
  return { cwd, config, provider, nextProvider, agent, restored, file: restored.file, next };
}

test("failed provider persistence preserves effective configuration and transport until repaired", async (t) => {
  const f = await fixture(t), before = structuredClone(f.config);
  await fs.rename(f.file, `${f.file}.backup`);
  await fs.mkdir(f.file);
  await assert.rejects(f.agent.replaceProvider(f.next, f.nextProvider));
  assert.deepEqual(f.config, before);
  assert.equal(f.agent.currentModel().provider, f.provider);
  await fs.rmdir(f.file);
  await fs.rename(`${f.file}.backup`, f.file);
  await f.agent.replaceProvider(f.next, f.nextProvider);
  assert.equal(f.agent.currentModel().provider, f.nextProvider);
  assert.equal(f.agent.currentModel().providerId, "next");
  assert.equal((await loadSession(f.cwd, f.restored.id)).providerId, "next");
});

for (const operation of ["run", "compact", "restore", "clear", "plan", "model", "provider", "recovery"] as const) {
  test(`pending provider persistence blocks concurrent ${operation} and keeps the committed transport visible`, async (t) => {
    const f = await fixture(t), entered = deferred(), release = deferred();
    const original = fs.open.bind(fs);
    let held = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (typeof args[1] === "number" && (args[1] & constants.O_APPEND)) {
        const append = handle.appendFile.bind(handle);
        t.mock.method(handle, "appendFile", async (...data: Parameters<typeof handle.appendFile>) => {
          if (!held && String(data[0]).includes('"type":"provider_changed"')) { held = true; entered.resolve(); await release.promise; }
          return append(...data);
        });
      }
      return handle;
    });
    const pending = f.agent.replaceProvider(f.next, f.nextProvider);
    await entered.promise;
    try {
      const busy = /provider|configuration|model|mode change/i;
      if (operation === "run") await assert.rejects(f.agent.run("must wait"), busy);
      if (operation === "compact") await assert.rejects(f.agent.compact(), busy);
      if (operation === "restore") assert.throws(() => f.agent.restoreSession(f.restored), busy);
      if (operation === "clear") assert.throws(() => f.agent.clearConversation(), busy);
      if (operation === "plan") await assert.rejects(f.agent.setPlanMode(true), busy);
      if (operation === "model") await assert.rejects(f.agent.setModel("other-model"), busy);
      if (operation === "provider") await assert.rejects(f.agent.replaceProvider({ ...f.next, providerId: "other" }, f.provider), busy);
      if (operation === "recovery") assert.throws(() => f.agent.setRecoverySource(undefined), busy);
      assert.equal(f.agent.currentModel().provider, f.provider);
      assert.equal(f.agent.currentModel().providerId, "old");
    } finally { release.resolve(); await pending; }
    assert.equal(f.agent.currentModel().provider, f.nextProvider);
    assert.equal(f.agent.currentModel().providerId, "next");
    assert.equal(f.agent.status().sessionId, f.restored.id);
  });
}

test("provider selection cannot switch the Agent's workspace under an existing session", async (t) => {
  const f = await fixture(t), before = structuredClone(f.config), log = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.agent.replaceProvider({ ...f.next, cwd: path.join(f.cwd, "different") }, f.nextProvider));
  assert.deepEqual(f.config, before);
  assert.equal(await fs.readFile(f.file, "utf8"), log);
  await f.agent.replaceProvider(f.next, f.nextProvider);
  assert.equal(f.agent.currentModel().providerId, "next");
});

test("an equivalent workspace alias preserves the selected root and existing session identity", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.cwd, "equivalent-root");
  await fs.symlink(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
  await f.agent.replaceProvider({ ...f.next, cwd: alias }, f.nextProvider);
  assert.equal(f.config.cwd, f.cwd);
  assert.equal(f.agent.status().sessionId, f.restored.id);
  assert.equal((await loadSession(f.cwd, f.restored.id)).providerId, "next");
});

test("provider events redact old and next credentials even when embedded in opaque metadata", async (t) => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  f.next.model = `${f.config.apiKey} ${f.next.apiKey}`;
  await f.agent.replaceProvider(f.next, f.nextProvider);
  const appended = (await fs.readFile(f.file, "utf8")).slice(before.length);
  assert.ok(!appended.includes(f.config.apiKey!));
  assert.ok(!appended.includes("old-credential-canary-H7_Dq92"));
  assert.ok(!appended.includes("next-credential-canary-K6_Fs34"));
});

test("provider commit uses its captured configuration and preserves a later UI-language change", async (t) => {
  const f = await fixture(t), { entered, release } = pauseEvent(t, "provider_changed");
  const pending = f.agent.replaceProvider(f.next, f.nextProvider);
  await entered.promise;
  f.next.providerId = "mutated-id";
  f.next.model = "mutated-model";
  f.next.capabilities!.text = "mutated-capability";
  f.agent.setLanguage("zh-CN");
  release.resolve();
  await pending;
  assert.equal(f.config.providerId, "next");
  assert.equal(f.config.model, "next-model");
  assert.equal(f.config.capabilities!.text, "next-model");
  assert.equal(f.config.language, "zh-CN");
});

test("a pending Plan change rejects provider adoption without changing its target", async (t) => {
  const f = await fixture(t), { entered, release } = pauseEvent(t, "plan_mode");
  const pending = f.agent.setPlanMode(true);
  await entered.promise;
  try {
    await assert.rejects(f.agent.replaceProvider(f.next, f.nextProvider), /mode|configuration|active/i);
    assert.equal(f.agent.currentModel().provider, f.provider);
  } finally { release.resolve(); await pending; }
  assert.equal(f.agent.status().planMode, true);
  assert.equal(f.agent.currentModel().providerId, "old");
  await f.agent.replaceProvider(f.next, f.nextProvider);
  assert.equal(f.agent.currentModel().providerId, "next");
});

for (const phase of ["validation", "persistence"] as const) {
  test(`an explicit unchanged UI language wins over provider snapshots during ${phase}`, async (t) => {
    const f = await fixture(t);
    f.next.language = "zh-CN";
    if (phase === "validation") {
      const alias = path.join(f.cwd, "language-root");
      await fs.symlink(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
      const pending = f.agent.replaceProvider({ ...f.next, cwd: alias }, f.nextProvider);
      f.agent.setLanguage("en-US");
      await pending;
    } else {
      const { entered, release } = pauseEvent(t, "provider_changed");
      const pending = f.agent.replaceProvider(f.next, f.nextProvider);
      await entered.promise;
      f.agent.setLanguage("en-US");
      release.resolve();
      await pending;
    }
    assert.equal(f.config.language, "en-US");
    assert.equal(f.agent.currentModel().providerId, "next");
  });
}
