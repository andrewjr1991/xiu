import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal } from "../src/task-run.js";

const options = { sessionId: "fixture", task: "offline fixture", providerId: "offline", model: "offline" };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-live-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), storage = path.join(root, "runs");
  await fs.mkdir(workspace);
  const owner = new TaskRunJournal(workspace, storage), other = new TaskRunJournal(workspace, storage);
  const run = await owner.begin(options);
  const directory = path.join(storage, owner.workspaceId);
  const snapshot = async () => Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name), "utf8")]));
  return { owner, other, run, snapshot, directory };
}
for (const action of ["resume", "abandon", "delete"] as const) {
  test(`another journal instance cannot ${action} a live running task`, async t => {
    const f = await fixture(t), before = await f.snapshot();
    const attempt = action === "resume" ? f.other.begin({ ...options, resumedFrom: f.run.runId })
      : action === "abandon" ? f.other.abandon(f.run.runId) : f.other.delete(f.run.runId);
    await assert.rejects(attempt, /active|running|live/i);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.other.currentRun(), undefined);
    await f.owner.beginOperation({ kind: "tool", name: "read", sideEffect: "none" });
    await f.owner.complete("completed");
  });
}
test("a paused task can still be explicitly resumed while its original process lives", async t => {
  const f = await fixture(t);
  await f.owner.pause("explicit pause");
  const resumed = await f.other.begin({ ...options, resumedFrom: f.run.runId });
  assert.equal(resumed.resumedFrom, f.run.runId);
  assert.equal((await f.other.read(f.run.runId))?.status, "abandoned");
  await f.other.complete("completed");
});

test("a matching recovery ID cannot replace a live lock whose record is not yet visible", async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const record = before.find(([name]) => name === `${f.run.runId}.json`)!;
  // Reproduce the interval after exclusive lock creation and before the first record write.
  const directory = f.directory;
  await fs.unlink(path.join(directory, record[0]!));
  const lockOnly = await f.snapshot();
  await assert.rejects(f.other.begin({ ...options, resumedFrom: f.run.runId }), /running|active|recover/i);
  assert.deepEqual(await f.snapshot(), lockOnly);
  await fs.writeFile(path.join(directory, record[0]!), record[1]!);
  await f.owner.complete("completed");
});
