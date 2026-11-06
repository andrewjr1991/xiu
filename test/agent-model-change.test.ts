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
async function fixture(t: test.TestContext, overrides: Partial<AgentConfig> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-model-change-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const config: AgentConfig = { cwd, provider: "openai", providerId: "offline", model: "old-model", autoApprove: false,
    capabilities: { text: "old-model", vision: "old-model" }, ...overrides };
  const provider = { async complete() { return { text: "done", toolCalls: [], raw: {} }; } };
  const agent = new Agent({ config, provider, tools: [], approve: async () => false, planManager: new TaskPlanManager() });
  await agent.run("answer only");
  const restored = await loadSession(cwd, agent.status().sessionId);
  return { cwd, config, provider, agent, restored, file: restored.file };
}

test("failed model persistence preserves model, context and capability state, then permits repair", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.config);
  await fs.rename(f.file, `${f.file}.backup`);
  await fs.mkdir(f.file);
  await assert.rejects(f.agent.setModel("new-model"));
  assert.deepEqual(f.config, before);
  assert.equal(f.agent.status().model, "old-model");
  await fs.rmdir(f.file);
  await fs.rename(`${f.file}.backup`, f.file);
  await f.agent.setModel("new-model");
  assert.equal(f.agent.status().model, "new-model");
  assert.equal(f.config.capabilities?.text, "new-model");
  assert.equal(f.config.capabilities?.vision, "new-model");
  assert.equal((await loadSession(f.cwd, f.restored.id)).model, "new-model");
});

for (const operation of ["run", "compact", "restore", "clear", "plan", "model", "provider", "recovery"] as const) {
  test(`pending model persistence blocks concurrent ${operation} and keeps the committed model visible`, async (t) => {
    const f = await fixture(t);
    const entered = deferred(), release = deferred();
    const original = fs.open.bind(fs);
    let held = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (typeof args[1] === "number" && (args[1] & constants.O_APPEND)) {
        const append = handle.appendFile.bind(handle);
        t.mock.method(handle, "appendFile", async (...data: Parameters<typeof handle.appendFile>) => {
          if (!held && String(data[0]).includes('"type":"model_changed"')) { held = true; entered.resolve(); await release.promise; }
          return append(...data);
        });
      }
      return handle;
    });
    const pending = f.agent.setModel("new-model");
    await entered.promise;
    try {
      const busy = /model|configuration|mode change/i;
      if (operation === "run") await assert.rejects(f.agent.run("must wait"), busy);
      if (operation === "compact") await assert.rejects(f.agent.compact(), busy);
      if (operation === "restore") assert.throws(() => f.agent.restoreSession(f.restored), busy);
      if (operation === "clear") assert.throws(() => f.agent.clearConversation(), busy);
      if (operation === "plan") await assert.rejects(f.agent.setPlanMode(true), busy);
      if (operation === "model") await assert.rejects(f.agent.setModel("other-model"), busy);
      if (operation === "provider") await assert.rejects(f.agent.replaceProvider({ ...f.config, providerId: "other" }, f.provider), busy);
      if (operation === "recovery") assert.throws(() => f.agent.setRecoverySource(undefined), busy);
      assert.equal(f.agent.status().model, "old-model");
      assert.equal(f.agent.currentModel().model, "old-model");
    } finally { release.resolve(); await pending; }
    assert.equal(f.agent.status().model, "new-model");
    assert.equal(f.agent.status().sessionId, f.restored.id);
    assert.equal((await loadSession(f.cwd, f.restored.id)).model, "new-model");
  });
}

test("an active task rejects model switching without changing its configuration", async (t) => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  f.provider.complete = async () => { entered.resolve(); await release.promise; return { text: "done", toolCalls: [], raw: {} }; };
  const run = f.agent.run("wait for the offline provider");
  await entered.promise;
  try {
    await assert.rejects(f.agent.setModel("new-model"), /task|active/i);
    assert.equal(f.agent.status().model, "old-model");
  } finally { release.resolve(); await run; }
});

test("invalid target context leaves no model-change record and releases the configuration latch", async (t) => {
  const f = await fixture(t, { provider: "agnes", model: "agnes-2.5-flash", contextWindow: 512000,
    contextWindowSource: "official", contextLimit: 300000, contextLimitMode: "configured" });
  const before = structuredClone(f.config), log = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.agent.setModel("unknown-model"), /context-limit/);
  assert.deepEqual(f.config, before);
  assert.equal(await fs.readFile(f.file, "utf8"), log);
  await f.agent.setModel("agnes-2.5-flash");
  assert.equal(f.agent.status().model, "agnes-2.5-flash");
});

test("committing a model change preserves an independently updated UI language", async (t) => {
  const f = await fixture(t);
  const original = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (typeof args[1] === "number" && (args[1] & constants.O_APPEND)) {
      const append = handle.appendFile.bind(handle);
      t.mock.method(handle, "appendFile", async (...data: Parameters<typeof handle.appendFile>) => {
        if (String(data[0]).includes('"type":"model_changed"')) f.agent.setLanguage("zh-CN");
        return append(...data);
      });
    }
    return handle;
  });
  await f.agent.setModel("new-model");
  assert.equal(f.config.language, "zh-CN");
  assert.equal(f.agent.status().model, "new-model");
});

for (const preservePlanMode of [false, true]) {
  test(`failed history context validation preserves the active session and permits retry (preserve Plan ${preservePlanMode})`, async (t) => {
    const f = await fixture(t, { provider: "agnes", model: "agnes-2.5-flash", contextWindow: 512000,
      contextWindowSource: "official", contextLimit: 300000, contextLimitMode: "configured" });
    await f.agent.setPlanMode(true);
    const target = path.join(path.dirname(f.file), "other.jsonl");
    await fs.writeFile(target, `${JSON.stringify({ type: "task", task: "other history", config: { providerId: "offline", provider: "agnes", model: "unknown-model" } })}\n`);
    const restored = await loadSession(f.cwd, "other");
    const before = { config: structuredClone(f.config), status: f.agent.status(), history: f.agent.history(), plan: f.agent.plan(), log: await fs.readFile(f.file, "utf8"), target: await fs.readFile(target, "utf8") };
    assert.throws(() => f.agent.restoreSession(restored, { preservePlanMode }), /context-limit/);
    assert.equal(f.agent.status().sessionId, before.status.sessionId);
    const after = f.agent.status();
    // Snapshot observation time advances even when no execution state changes.
    if (after.diagnostics && before.status.diagnostics) after.diagnostics.updatedAt = before.status.diagnostics.updatedAt;
    assert.deepEqual(after, before.status);
    assert.deepEqual(f.config, before.config);
    assert.equal(f.agent.history(), before.history);
    assert.equal(f.agent.plan(), before.plan);
    assert.equal(await fs.readFile(f.file, "utf8"), before.log);
    assert.equal(await fs.readFile(target, "utf8"), before.target);
    await f.agent.run("continue the original session");
    assert.equal(f.agent.status().sessionId, before.status.sessionId);
    assert.equal((await loadSession(f.cwd, f.restored.id)).lastUserTask, "continue the original session");
    assert.equal(await fs.readFile(target, "utf8"), before.target);
    f.agent.restoreSession({ ...restored, model: "agnes-2.5-flash" }, { preservePlanMode });
    assert.equal(f.agent.status().sessionId, "other");
    assert.equal(f.agent.status().planMode, preservePlanMode);
    assert.match(f.agent.history(), /other history/);
  });
}
