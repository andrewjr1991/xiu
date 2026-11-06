import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processStartTime } from "../src/process-identity.js";
import { TaskRunJournal } from "../src/task-run.js";

const options = { sessionId: "fixture", task: "offline fixture", providerId: "offline", model: "offline" };
async function fixture(t: test.TestContext, paused = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-paused-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, "runs"), owner = new TaskRunJournal(root, storage);
  const run = await owner.begin(options);
  if (paused) await owner.pause("explicit pause");
  const directory = path.join(storage, owner.workspaceId), file = path.join(directory, `${run.runId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  // The real parent process is alive; represent a record created by that other process.
  record.ownerPid = process.ppid;
  const startedAt = await processStartTime(process.ppid);
  if (startedAt === undefined) delete record.ownerStartedAt; else record.ownerStartedAt = new Date(startedAt).toISOString();
  await fs.writeFile(file, JSON.stringify(record) + "\n");
  return { owner, other: new TaskRunJournal(root, storage), run, file, directory };
}
test("a paused task remains discoverable while its other-process owner is alive", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  assert.equal((await f.other.interrupted())?.runId, f.run.runId);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.deepEqual(await fs.readdir(f.directory), [`${f.run.runId}.json`]);
});
test("a paused live-owner task requires a recovery decision rather than reporting an active writer", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.other.begin(options), /explicit resume or abandon/);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});
test("a paused task can be explicitly resumed from another process while its prior owner lives", async t => {
  const f = await fixture(t);
  const resumed = await f.other.begin({ ...options, resumedFrom: f.run.runId });
  assert.equal(resumed.resumedFrom, f.run.runId);
  assert.equal((await f.other.read(f.run.runId))?.status, "abandoned");
  await f.other.complete("completed");
});
test("a running task owned by another live process remains unavailable for recovery", async t => {
  const f = await fixture(t, false), before = await fs.readFile(f.file, "utf8");
  assert.equal(await f.other.interrupted(), undefined);
  await assert.rejects(f.other.begin({ ...options, resumedFrom: f.run.runId }), /already running/);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  await f.owner.complete("completed");
});
test("paused discovery and explicit recovery do not depend on probing an idle prior owner", async t => {
  const f = await fixture(t), original = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === process.ppid && signal === 0) throw Object.assign(new Error("fixture unavailable probe"), { code: "EIO" });
    return original(pid, signal);
  });
  assert.equal((await f.other.interrupted())?.runId, f.run.runId);
  await f.other.begin({ ...options, resumedFrom: f.run.runId });
  await f.other.complete("completed");
});
