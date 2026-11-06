import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { taskOperationSignature, TaskRunJournal, TaskRunPersistenceError, type TaskRunRecord } from "../src/task-run.js";

const options = { sessionId: "replacement", task: "offline fixture", providerId: "offline", model: "offline" };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-recovery-retire-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, "runs"), owner = new TaskRunJournal(root, storage);
  const source = await owner.begin({ ...options, sessionId: "source" });
  await owner.beginOperation({ kind: "tool", name: "prior effect", sideEffect: "external", signature: taskOperationSignature("prior effect", { id: 1 }) });
  await owner.pause("saved recovery source");
  const directory = path.join(storage, owner.workspaceId), file = path.join(directory, `${source.runId}.json`);
  return { source, directory, file, before: await fs.readFile(file, "utf8"), next: new TaskRunJournal(root, storage) };
}
test("a post-publication IO failure preserves the original recovery source and unknown effects", async t => {
  const f = await fixture(t), readdir = fs.readdir;
  let injected = false;
  t.mock.method(fs, "readdir", async (target: Parameters<typeof fs.readdir>[0]) => {
    const names = await readdir(target);
    if (target === f.directory && !injected && names.some(name => name.endsWith(".json") && name !== `${f.source.runId}.json`)) {
      injected = true; throw Object.assign(new Error("fixture post-publication failure"), { code: "EIO" });
    }
    return names;
  });
  await assert.rejects(f.next.begin({ ...options, resumedFrom: f.source.runId }), error => (error as NodeJS.ErrnoException).code === "EIO");
  assert.equal(await fs.readFile(f.file, "utf8"), f.before);
  assert.equal(f.next.currentRun(), undefined);
  const recovery = await f.next.interrupted();
  assert.equal(recovery?.runId, f.source.runId); assert.equal(recovery?.pendingSideEffects.length, 1);
  assert.equal((await f.next.recent()).find(run => run.sessionId === "replacement")?.status, "failed");
});
test("an unresolved second source prevents retirement of the selected recovery source", async t => {
  const f = await fixture(t), older = { ...JSON.parse(f.before), runId: "older-recovery", sessionId: "older", updatedAt: "2000-01-01T00:00:00.000Z" };
  const file = path.join(f.directory, `${older.runId}.json`), bytes = JSON.stringify(older) + "\n";
  await fs.writeFile(file, bytes);
  await assert.rejects(f.next.begin({ ...options, resumedFrom: f.source.runId }), /concurrent|recoverable|decision/i);
  assert.equal(await fs.readFile(f.file, "utf8"), f.before);
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  assert.equal((await f.next.interrupted())?.runId, f.source.runId);
  assert.equal(f.next.currentRun(), undefined);
});
test("failure to retire the source leaves the published replacement terminal and unexecuted", async t => {
  const f = await fixture(t), rename = fs.rename;
  t.mock.method(fs, "rename", async (temporary: Parameters<typeof fs.rename>[0], target: Parameters<typeof fs.rename>[1]) => {
    if (target === f.file) throw Object.assign(new Error("fixture retirement failure"), { code: "EACCES" });
    return rename(temporary, target);
  });
  await assert.rejects(f.next.begin({ ...options, resumedFrom: f.source.runId }), error => error instanceof TaskRunPersistenceError && error.storageCode === "EACCES");
  assert.equal(await fs.readFile(f.file, "utf8"), f.before);
  assert.equal(f.next.currentRun(), undefined);
  const replacement = (await f.next.recent()).find(run => run.sessionId === "replacement");
  assert.equal(replacement?.status, "failed"); assert.deepEqual(replacement?.operations, []);
});
test("successful recovery retires its source after the replacement publication check", async t => {
  const f = await fixture(t), readdir = fs.readdir;
  let observed = false;
  t.mock.method(fs, "readdir", async (target: Parameters<typeof fs.readdir>[0]) => {
    const names = await readdir(target);
    if (target === f.directory && !observed && names.some(name => name.endsWith(".json") && name !== `${f.source.runId}.json`)) {
      observed = true;
      assert.equal((JSON.parse(await fs.readFile(f.file, "utf8")) as TaskRunRecord).status, "paused");
    }
    return names;
  });
  const run = await f.next.begin({ ...options, resumedFrom: f.source.runId });
  assert.equal(observed, true); assert.equal(run.resumedFrom, f.source.runId);
  assert.equal((await f.next.read(f.source.runId))?.status, "abandoned");
  await f.next.complete("completed");
});

for (const status of ["completed", "abandoned"] as const) {
  test(`an already ${status} source cannot be resumed through a stale recovery reference`, async t => {
    const f = await fixture(t), record = { ...JSON.parse(f.before), status };
    const bytes = JSON.stringify(record) + "\n"; await fs.writeFile(f.file, bytes);
    const names = await fs.readdir(f.directory);
    await assert.rejects(f.next.begin({ ...options, resumedFrom: f.source.runId }), /recover|source|decision/i);
    assert.equal(await fs.readFile(f.file, "utf8"), bytes);
    assert.deepEqual(await fs.readdir(f.directory), names);
    assert.equal(f.next.currentRun(), undefined);
  });
}
test("a missing recovery source does not silently turn into a new task", async t => {
  const f = await fixture(t);
  await f.next.abandon(f.source.runId);
  const names = await fs.readdir(f.directory);
  await assert.rejects(f.next.begin({ ...options, resumedFrom: "missing-source" }), /recover|source|decision/i);
  assert.deepEqual(await fs.readdir(f.directory), names);
  assert.equal(f.next.currentRun(), undefined);
});
test("a source explicitly abandoned during replacement publication requires a fresh decision", async t => {
  const f = await fixture(t), rename = fs.rename;
  let changed = false;
  t.mock.method(fs, "rename", async (temporary: Parameters<typeof fs.rename>[0], target: Parameters<typeof fs.rename>[1]) => {
    const record = JSON.parse(await fs.readFile(temporary, "utf8")) as TaskRunRecord;
    if (!changed && record.sessionId === "replacement" && record.status === "running") {
      changed = true; await f.next.abandon(f.source.runId, "separate explicit decision");
    }
    return rename(temporary, target);
  });
  await assert.rejects(f.next.begin({ ...options, resumedFrom: f.source.runId }), /recover|source|decision/i);
  assert.equal(changed, true); assert.equal(f.next.currentRun(), undefined);
  assert.equal((await f.next.read(f.source.runId))?.status, "abandoned");
  assert.equal((await f.next.recent()).find(run => run.sessionId === "replacement")?.status, "failed");
});
