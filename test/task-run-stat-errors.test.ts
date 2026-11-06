import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal, TaskRunPersistenceError } from "../src/task-run.js";

async function fixture(t: test.TestContext, paused: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-journal-stat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new TaskRunJournal(root, path.join(root, "runs"));
  const run = await journal.begin({ sessionId: "fixture", task: "offline fixture", providerId: "offline", model: "offline" });
  if (paused) await journal.pause("fixture pause");
  const directory = path.join(root, "runs", journal.workspaceId), file = path.join(directory, `${run.runId}.json`);
  return { journal, run, file, directory };
}
for (const code of ["EACCES", "EPERM", "EIO"]) {
  test(`journal ${code} metadata failure remains visible and blocks recovery/start`, async t => {
    const f = await fixture(t, true), before = await fs.readFile(f.file, "utf8"), names = await fs.readdir(f.directory);
    const original = fs.lstat;
    t.mock.method(fs, "lstat", async (target: Parameters<typeof fs.lstat>[0]) => {
      if (target === f.file) throw Object.assign(new Error("fixture metadata failure"), { code });
      return original(target);
    });
    const matches = (error: unknown) => (error as NodeJS.ErrnoException).code === code;
    await assert.rejects(f.journal.read(f.run.runId), matches);
    assert.deepEqual((await f.journal.scan()).unreadable, [{ runId: f.run.runId, reason: code }]);
    await assert.rejects(f.journal.interrupted(), matches);
    await assert.rejects(f.journal.begin({ sessionId: "new", task: "must not start", providerId: "offline", model: "offline" }), matches);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    assert.deepEqual(await fs.readdir(f.directory), names);
  });
  test(`journal ${code} destination metadata failure stops replacement and further operations`, async t => {
    const f = await fixture(t, false), before = await fs.readFile(f.file, "utf8");
    const lock = await fs.readFile(path.join(f.directory, ".active.lock"), "utf8"), names = await fs.readdir(f.directory);
    const original = fs.lstat;
    t.mock.method(fs, "lstat", async (target: Parameters<typeof fs.lstat>[0]) => {
      if (target === f.file) throw Object.assign(new Error("fixture metadata failure"), { code });
      return original(target);
    });
    await assert.rejects(f.journal.beginOperation({ kind: "tool", name: "must not execute", sideEffect: "external" }), error => error instanceof TaskRunPersistenceError && error.storageCode === code);
    assert.equal(f.journal.persistenceFailure(), code);
    await assert.rejects(f.journal.beginOperation({ kind: "tool", name: "also blocked", sideEffect: "none" }), TaskRunPersistenceError);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    assert.equal(await fs.readFile(path.join(f.directory, ".active.lock"), "utf8"), lock);
    assert.deepEqual(await fs.readdir(f.directory), names);
  });
  test(`journal ${code} lock inspection failure is surfaced after terminal record persistence`, async t => {
    const f = await fixture(t, false), lockFile = path.join(f.directory, ".active.lock");
    const before = await fs.readFile(lockFile, "utf8"), names = await fs.readdir(f.directory);
    const original = fs.lstat;
    t.mock.method(fs, "lstat", async (target: Parameters<typeof fs.lstat>[0]) => {
      if (target === lockFile) throw Object.assign(new Error("fixture metadata failure"), { code });
      return original(target);
    });
    await assert.rejects(f.journal.complete("completed"), error => (error as NodeJS.ErrnoException).code === code);
    assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).status, "completed");
    assert.equal(await fs.readFile(lockFile, "utf8"), before);
    assert.deepEqual(await fs.readdir(f.directory), names);
  });

}
test("a genuinely missing record still returns undefined and a new journal can start", async t => {
  const f = await fixture(t, true);
  await f.journal.abandon(f.run.runId);
  assert.equal(await f.journal.read("missing-record"), undefined);
  await f.journal.begin({ sessionId: "new", task: "new", providerId: "offline", model: "offline" });
  await f.journal.complete("completed");
});
