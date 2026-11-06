import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-run-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), journalRoot = path.join(root, "runs");
  await fs.mkdir(workspace);
  const journal = new TaskRunJournal(workspace, journalRoot);
  const run = await journal.begin({ sessionId: "saved", task: "fixture", providerId: "offline", model: "offline" });
  await journal.complete("completed");
  const directory = path.join(journalRoot, journal.workspaceId), file = path.join(directory, `${run.runId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as TaskRunRecord;
  return { root, workspace, journalRoot, journal, run, directory, file, record };
}

test("journal rejects a payload ID that differs from its file before reading or adopting it", async (t) => {
  const f = await fixture(t);
  f.record.runId = "another-run";
  await fs.writeFile(f.file, JSON.stringify(f.record) + "\n");
  const before = await fs.readFile(f.file, "utf8"), names = await fs.readdir(f.directory);
  await assert.rejects(f.journal.read(f.run.runId), /corrupt|identity/i);
  await assert.rejects(f.journal.saveRuntimeEvents(f.run.runId, []), /corrupt|identity/i);
  await assert.rejects(f.journal.abandon(f.run.runId), /corrupt|identity/i);
  await assert.rejects(f.journal.begin({ sessionId: "new", task: "new", providerId: "offline", model: "offline" }), /corrupt|identity/i);
  const scan = await f.journal.scan();
  assert.equal(scan.records.length, 0);
  assert.deepEqual(scan.unreadable, [{ runId: f.run.runId, reason: "corrupt" }]);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.deepEqual(await fs.readdir(f.directory), names);
});

for (const action of ["read", "abandon"] as const) {
  test(`journal ${action} rejects a traversal ID before accessing a sibling fixture`, async (t) => {
    const f = await fixture(t), outside = path.join(f.journalRoot, "outside.json");
    const body = JSON.stringify({ ...f.record, runId: "../outside" }) + "\n";
    await fs.writeFile(outside, body);
    await assert.rejects(action === "read" ? f.journal.read("../outside") : f.journal.abandon("../outside"), /invalid|corrupt|identity/i);
    assert.equal(await fs.readFile(outside, "utf8"), body);
  });
}

test("desktop event persistence cannot redirect through a mismatched record ID", async (t) => {
  const f = await fixture(t), target = path.join(f.directory, "target.json");
  const body = JSON.stringify({ ...f.record, runId: "target" }) + "\n";
  await fs.writeFile(target, body);
  f.record.runId = "target";
  await fs.writeFile(f.file, JSON.stringify(f.record) + "\n");
  const source = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.journal.saveRuntimeEvents(f.run.runId, []), /corrupt|identity/i);
  assert.equal(await fs.readFile(target, "utf8"), body);
  assert.equal(await fs.readFile(f.file, "utf8"), source);
});

test("malformed run IDs reject rather than becoming missing records", async (t) => {
  const f = await fixture(t);
  for (const id of ["", ".", "..", "nested/id", "..\\outside", "/absolute", "x".repeat(161)]) {
    await assert.rejects(f.journal.read(id), /invalid|corrupt|identity/i, id);
    await assert.rejects(f.journal.begin({ sessionId: "new", task: "new", providerId: "offline", model: "offline", resumedFrom: id }), /invalid|corrupt|identity/i, id);
  }
});

test("a malformed lock run ID cannot be silently removed to admit a new starter", async (t) => {
  const f = await fixture(t), file = path.join(f.directory, ".active.lock");
  const body = JSON.stringify({ version: 1, workspaceId: f.journal.workspaceId, runId: "../outside", ownerPid: 2000000000,
    ownerInstance: "fixture", createdAt: new Date().toISOString() }) + "\n";
  await fs.writeFile(file, body);
  const names = await fs.readdir(f.directory);
  await assert.rejects(f.journal.begin({ sessionId: "new", task: "new", providerId: "offline", model: "offline" }), /corrupt|invalid|identity/i);
  await assert.rejects(f.journal.lockStatus(), /corrupt|invalid|identity/i);
  assert.equal(await fs.readFile(file, "utf8"), body);
  assert.deepEqual(await fs.readdir(f.directory), names);
  assert.equal(f.journal.currentRun(), undefined);
});

test("matching legacy alphanumeric/hyphen run IDs retain their exact case", async (t) => {
  const f = await fixture(t), id = "legacy-Run-001";
  const body = JSON.stringify({ ...f.record, runId: id }) + "\n";
  await fs.writeFile(path.join(f.directory, `${id}.json`), body);
  assert.equal((await f.journal.read(id))?.runId, id);
  assert.equal((await f.journal.scan()).unreadable.length, 0);
});
