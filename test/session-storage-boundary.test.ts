import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { appendSessionLog } from "../src/session-storage.js";
import { Agent } from "../src/agent.js";
import { deleteSession, listSessionsWithIssues, loadSession } from "../src/session.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-storage-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), outside = path.join(root, "outside");
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  return { root, cwd, outside };
}

for (const storage of [".xiu", ".xiu/sessions", ".forge", ".forge_sessions"]) {
  test(`history refuses linked storage ${storage} before reading or deleting outside logs`, async (t) => {
    const { cwd, outside } = await fixture(t);
    const linked = path.join(cwd, storage);
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const directory = [".xiu", ".forge"].includes(storage) ? path.join(outside, "sessions") : outside;
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "foreign.jsonl");
    const content = '{"type":"task","task":"outside canary"}\n';
    await fs.writeFile(file, content);
    const listing = await listSessionsWithIssues(cwd, { useSummary: false });
    assert.equal(listing.sessions.length, 0);
    assert.deepEqual(listing.directoryIssues, [{ reason: "ELOOP" }]);
    await assert.rejects(loadSession(cwd, "foreign"), { code: "ELOOP" });
    await assert.rejects(deleteSession(cwd, "foreign"), { code: "ELOOP" });
    assert.equal(await fs.readFile(file, "utf8"), content);
  });
}

for (const storage of [".xiu", ".xiu/sessions"]) {
  test(`Agent refuses linked ${storage} before model calls and recovers after repair`, async (t) => {
    const { cwd, outside } = await fixture(t);
    const linked = path.join(cwd, storage);
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    let calls = 0;
    const agent = new Agent({ config: { cwd, provider: "openai", providerId: "offline", model: "offline", autoApprove: false },
      provider: { async complete() { calls++; return { text: "done", toolCalls: [], raw: {} }; } }, tools: [], approve: async () => false });
    await assert.rejects(agent.run("answer only"));
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.rm(linked, { recursive: true });
    await agent.run("answer after repair");
    assert.equal(calls, 1);
  });
}

test("append verifies the opened pathname before chmod or writing even without O_NOFOLLOW", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, outside } = await fixture(t);
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "saved.jsonl"), foreign = path.join(outside, "canary");
  await fs.writeFile(file, "original\n");
  await fs.writeFile(foreign, "outside unchanged\n", { mode: 0o644 });
  const mode = (await fs.stat(foreign)).mode;
  const original = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file) {
      await fs.unlink(file);
      await fs.symlink(foreign, file);
      args[1] = (args[1] as number) & ~constants.O_NOFOLLOW;
    }
    return original(...args);
  });
  await assert.rejects(appendSessionLog(cwd, file, "must not append\n"), { code: "ELOOP" });
  assert.equal(await fs.readFile(foreign, "utf8"), "outside unchanged\n");
  assert.equal((await fs.stat(foreign)).mode, mode);
});

test("history verifies the opened pathname before reading when O_NOFOLLOW is unavailable", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, outside } = await fixture(t);
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "saved.jsonl"), foreign = path.join(outside, "canary");
  await fs.writeFile(file, '{"type":"task","task":"local"}\n');
  await fs.writeFile(foreign, '{"type":"task","task":"foreign canary"}\n');
  const original = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file) {
      await fs.unlink(file);
      await fs.symlink(foreign, file);
      args[1] = (args[1] as number) & ~constants.O_NOFOLLOW;
    }
    return original(...args);
  });
  const listing = await listSessionsWithIssues(cwd, { useSummary: false });
  assert.deepEqual(listing.sessions, []);
  assert.deepEqual(listing.unreadable, [{ id: "saved", reason: "ELOOP" }]);
});

test("replacing a restored log with a FIFO cannot hang or disable Plan mode", { skip: process.platform === "win32" }, async (t) => {
  const { cwd } = await fixture(t);
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "saved.jsonl");
  await fs.writeFile(file, '{"type":"task","task":"local"}\n{"type":"plan_mode","enabled":true}\n');
  // A child deadline also catches a regression that blocks inside the OS open call.
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {execFileSync} from 'node:child_process';
    import {Agent} from './src/agent.ts';
    import {loadSession} from './src/session.ts';
    import {TaskPlanManager} from './src/plan.ts';
    const cwd=process.argv[1], file=process.argv[2];
    const restored=await loadSession(cwd,'saved');
    const planManager=new TaskPlanManager(undefined,true);
    const agent=new Agent({config:{cwd,provider:'openai',providerId:'offline',model:'offline',autoApprove:false},
      provider:{async complete(){throw new Error('unexpected model call')}},tools:[],approve:async()=>false,planManager,restored});
    await fs.unlink(file);
    execFileSync('mkfifo',[file]);
    await assert.rejects(agent.setPlanMode(false));
    assert.equal(planManager.mode(),true);
  `, cwd, file], { cwd: process.cwd(), timeout: 10000, stdio: "pipe", windowsHide: true });
});

test("append refuses a regular file replaced between validation and open", async (t) => {
  const { cwd } = await fixture(t);
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "saved.jsonl");
  await fs.writeFile(file, "original\n");
  const original = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file) {
      await fs.rename(file, `${file}.previous`);
      await fs.writeFile(file, "replacement unchanged\n");
    }
    return original(...args);
  });
  await assert.rejects(appendSessionLog(cwd, file, "must not append\n"), { code: "SESSION_STORAGE_UNSAFE" });
  assert.equal(await fs.readFile(file, "utf8"), "replacement unchanged\n");
  assert.equal(await fs.readFile(`${file}.previous`, "utf8"), "original\n");
});

test("restored logging cannot append outside the configured workspace", async (t) => {
  const { cwd, outside } = await fixture(t);
  const file = path.join(outside, "saved.jsonl");
  await fs.writeFile(file, "outside unchanged\n");
  await assert.rejects(appendSessionLog(cwd, file, "must not append\n"), { code: "SESSION_STORAGE_UNSAFE" });
  assert.equal(await fs.readFile(file, "utf8"), "outside unchanged\n");
});
