import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal, taskOperationSignature } from "../src/task-run.js";

type MutableFixture = Record<string, unknown> & { operations: Array<Record<string, unknown> | null>; events: Array<Record<string, unknown>> };

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-journal-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), journalRoot = path.join(root, "runs");
  await fs.mkdir(workspace);
  const journal = new TaskRunJournal(workspace, journalRoot);
  const healthy = await journal.begin({ sessionId: "healthy", task: "healthy", providerId: "offline", model: "offline" });
  await journal.complete("completed");
  const run = await journal.begin({ sessionId: "paused", task: "paused", providerId: "offline", model: "offline" });
  await journal.beginOperation({ kind: "tool", name: "once", signature: taskOperationSignature("once", { path: "result" }), risk: "write", sideEffect: "workspace" });
  await journal.pause("fixture pause");
  const directory = path.join(journalRoot, journal.workspaceId), file = path.join(directory, `${run.runId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as MutableFixture;
  return { root, workspace, journalRoot, healthy, run, directory, file, record };
}

const corruptions: Array<[string, (record: MutableFixture) => void]> = [
  ["unknown run status", (record) => { record.status = "future-status"; }],
  ["unknown operation status", (record) => { record.operations[0]!.status = "future-status"; }],
  ["unknown side effect", (record) => { record.operations[0]!.sideEffect = "cloud"; }],
  ["unknown replay policy", (record) => { record.operations[0]!.replay = "replay-now"; }],
  ["unknown operation kind", (record) => { record.operations[0]!.kind = "future-kind"; }],
  ["null operation", (record) => { record.operations[0] = null; }],
  ["invalid signature", (record) => { record.operations[0]!.signature = 123; }],
  ["invalid risk", (record) => { record.operations[0]!.risk = "root"; }],
  ["missing operation identity", (record) => { delete record.operations[0]!.id; }],
];
for (const [label, corrupt] of corruptions) {
  test(`journal rejects ${label} before recovery or a new task and isolates it in lists`, async (t) => {
    const f = await fixture(t);
    corrupt(f.record);
    await fs.writeFile(f.file, JSON.stringify(f.record) + "\n");
    const before = await fs.readFile(f.file, "utf8"), names = await fs.readdir(f.directory);
    const journal = new TaskRunJournal(f.workspace, f.journalRoot);
    await assert.rejects(journal.read(f.run.runId), /Unsupported or corrupt/);
    await assert.rejects(journal.interrupted(), /Unsupported or corrupt/);
    await assert.rejects(journal.begin({ sessionId: "must-not-start", task: "must not start", providerId: "offline", model: "offline" }), /Unsupported or corrupt/);
    assert.equal(journal.currentRun(), undefined);
    const scan = await journal.scan();
    assert.deepEqual(scan.records.map((record) => record.runId), [f.healthy.runId]);
    assert.deepEqual(scan.unreadable, [{ runId: f.run.runId, reason: "corrupt" }]);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    assert.deepEqual(await fs.readdir(f.directory), names);
  });
}

test("known journal states preserve legacy optional metadata and additive display events", async (t) => {
  const f = await fixture(t);
  delete f.record.ownerStartedAt;
  delete f.record.operations[0]!.signature;
  delete f.record.operations[0]!.risk;
  f.record.displayExtension = { future: true };
  f.record.events.push({ id: "future", at: new Date().toISOString(), type: "future-display-only" });
  await fs.writeFile(f.file, JSON.stringify(f.record) + "\n");
  const before = await fs.readFile(f.file, "utf8");
  const restored = await new TaskRunJournal(f.workspace, f.journalRoot).interrupted();
  assert.equal(restored?.pendingSideEffects.length, 1);
  assert.equal(restored?.pendingSideEffects[0]?.status, "unknown");
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});
