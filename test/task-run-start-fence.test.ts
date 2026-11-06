import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

const options = { sessionId: "first", task: "offline fixture", providerId: "offline", model: "offline" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-start-fence-"));
  const drains: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const drain of drains) await drain(); await fs.rm(root, { recursive: true, force: true }); });
  const storage = path.join(root, "runs"), seed = new TaskRunJournal(root, storage);
  await seed.begin({ ...options, sessionId: "seed" });
  const directory = path.join(storage, seed.workspaceId), lockFile = path.join(directory, ".active.lock");
  const stale = await fs.readFile(lockFile, "utf8"); await seed.complete("completed");
  // Crash window: terminal record saved, old lock not yet released.
  await fs.writeFile(lockFile, stale, { flag: "wx" });
  return { directory, lockFile, drains, first: new TaskRunJournal(root, storage), second: new TaskRunJournal(root, storage) };
}
test("a stale-lock cleaner cannot return an executable task after another starter has published its live run", async t => {
  const f = await fixture(t), unlink = fs.unlink;
  let interleaved = false, secondRun: TaskRunRecord | undefined;
  t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    if (target === f.lockFile && !interleaved) {
      interleaved = true; secondRun = await f.second.begin({ ...options, sessionId: "second" });
    }
    return unlink(target);
  });
  await assert.rejects(f.first.begin(options), /start|running|exclusive|concurrent/i);
  assert.ok(secondRun); assert.equal(f.first.currentRun(), undefined);
  assert.equal(f.second.currentRun()?.runId, secondRun.runId);
  await f.second.beginOperation({ kind: "tool", name: "only winner", sideEffect: "none" });
  const records = await f.first.recent();
  assert.equal(records.filter(run => run.status === "running").length, 1);
  assert.equal(records.find(run => run.sessionId === "first")?.status, "failed");
  await assert.rejects(f.first.begin(options), /running/);
  await f.second.complete("completed");
});
test("a starter delayed before its record publication rejects after a competing run becomes live", async t => {
  const f = await fixture(t), unlink = fs.unlink, rename = fs.rename;
  const writing = deferred(), release = deferred();
  let interleaved = false, held = false;
  let secondStart: Promise<{ run?: TaskRunRecord; error?: unknown }> | undefined;
  f.drains.push(async () => { release.resolve(); await secondStart; });
  t.mock.method(fs, "rename", async (temporary: Parameters<typeof fs.rename>[0], target: Parameters<typeof fs.rename>[1]) => {
    const record = JSON.parse(await fs.readFile(temporary, "utf8")) as TaskRunRecord;
    if (!held && record.sessionId === "second" && record.status === "running") {
      held = true; writing.resolve(); await release.promise;
    }
    return rename(temporary, target);
  });
  t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    if (target === f.lockFile && !interleaved) {
      interleaved = true;
      secondStart = f.second.begin({ ...options, sessionId: "second" }).then(run => ({ run }), error => ({ error }));
      await Promise.race([writing.promise, secondStart.then(() => { throw new Error("second starter ended before publication window"); })]);
    }
    return unlink(target);
  });
  const firstRun = await f.first.begin(options);
  release.resolve();
  const result = await secondStart!;
  assert.ok(result.error, "second starter obtained execution permission after first was live");
  assert.equal(result.run, undefined); assert.equal(f.second.currentRun(), undefined);
  assert.equal(f.first.currentRun()?.runId, firstRun.runId);
  assert.equal((await f.first.recent()).filter(run => run.status === "running").length, 1);
  await f.first.beginOperation({ kind: "tool", name: "only winner", sideEffect: "none" });
  await f.first.complete("completed");
});
test("failure to verify a published start leaves a terminal no-execution record and rejects the start", async t => {
  const f = await fixture(t), readdir = fs.readdir;
  let scans = 0;
  t.mock.method(fs, "readdir", async (target: Parameters<typeof fs.readdir>[0]) => {
    if (target === f.directory && ++scans === 2) throw Object.assign(new Error("fixture start scan failure"), { code: "EIO" });
    return readdir(target);
  });
  await assert.rejects(f.first.begin(options), error => (error as NodeJS.ErrnoException).code === "EIO");
  assert.equal(f.first.currentRun(), undefined);
  const attempted = (await f.first.recent()).find(run => run.sessionId === "first");
  assert.equal(attempted?.status, "failed"); assert.deepEqual(attempted?.operations, []);
  assert.ok(attempted?.events.some(event => event.type === "run-finished" && event.status === "failed"));
  await f.first.begin({ ...options, sessionId: "explicit retry" });
  await f.first.complete("completed");
});

test("a competing task paused during stale cleanup still requires an explicit recovery decision", async t => {
  const f = await fixture(t), unlink = fs.unlink;
  let interleaved = false, pausedRun: TaskRunRecord | undefined;
  t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    if (target === f.lockFile && !interleaved) {
      interleaved = true;
      pausedRun = await f.second.begin({ ...options, sessionId: "second" });
      await f.second.beginOperation({ kind: "tool", name: "possible earlier effect", sideEffect: "external" });
      await f.second.pause("competing task paused");
      // The paused owner released the lock; let the stale cleaner observe that disappearance.
      return;
    }
    return unlink(target);
  });
  await assert.rejects(f.first.begin(options), /start|recover|concurrent|decision/i);
  assert.equal(f.first.currentRun(), undefined);
  assert.equal((await f.first.interrupted())?.runId, pausedRun?.runId);
  assert.equal((await f.first.interrupted())?.pendingSideEffects.length, 1);
});
