import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";
import { configureProcessStartTimeProbe, processStartTime, processStartTimeSync } from "../src/process-identity.js";

async function fixture(t: test.TestContext, paused = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-run-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), journalRoot = path.join(root, "runs");
  await fs.mkdir(workspace);
  const journal = new TaskRunJournal(workspace, journalRoot);
  const run = await journal.begin({ sessionId: "saved", task: "fixture", providerId: "offline", model: "offline" });
  if (paused) await journal.pause("fixture pause"); else await journal.complete("completed");
  const directory = path.join(journalRoot, journal.workspaceId), file = path.join(directory, `${run.runId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as TaskRunRecord;
  return { root, workspace, journalRoot, journal, run, directory, file, record };
}

for (const [label, pid] of [["zero", 0], ["negative", -1], ["fraction", 1.25], ["out of API range", 2147483648], ["string", "123"], ["null", null], ["missing", undefined]] as const) {
  test(`journal rejects ${label} owner PID without inferring owner death or starting a task`, async (t) => {
    const f = await fixture(t);
    const record: Record<string, unknown> = { ...f.record, ownerPid: pid };
    if (pid === undefined) delete record.ownerPid;
    await fs.writeFile(f.file, JSON.stringify(record) + "\n");
    const before = await fs.readFile(f.file, "utf8"), names = await fs.readdir(f.directory);
    await assert.rejects(f.journal.read(f.run.runId), /corrupt|owner|PID/i);
    await assert.rejects(f.journal.interrupted(), /corrupt|owner|PID/i);
    await assert.rejects(f.journal.begin({ sessionId: "new", task: "new", providerId: "offline", model: "offline" }), /corrupt|owner|PID/i);
    const scan = await f.journal.scan();
    assert.deepEqual(scan.unreadable, [{ runId: f.run.runId, reason: "corrupt" }]);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    assert.deepEqual(await fs.readdir(f.directory), names);
  });
}
for (const pid of [0, -1, 2147483648]) {
  test(`lock owner PID ${pid} is preserved as corrupt rather than cleared as dead`, async (t) => {
    const f = await fixture(t, false), file = path.join(f.directory, ".active.lock");
    const body = JSON.stringify({ version: 1, workspaceId: f.journal.workspaceId, runId: f.run.runId, ownerPid: pid,
      ownerInstance: "fixture", createdAt: new Date().toISOString() }) + "\n";
    await fs.writeFile(file, body);
    const names = await fs.readdir(f.directory);
    await assert.rejects(f.journal.begin({ sessionId: "new", task: "new", providerId: "offline", model: "offline" }), /corrupt|owner|PID/i);
    await assert.rejects(f.journal.lockStatus(), /corrupt|owner|PID/i);
    assert.equal(await fs.readFile(file, "utf8"), body);
    assert.deepEqual(await fs.readdir(f.directory), names);
    assert.equal(f.journal.currentRun(), undefined);
  });
}

test("process start-time probes never receive invalid PIDs or process-group identifiers", async (t) => {
  let calls = 0;
  configureProcessStartTimeProbe({ sync: () => { calls++; return 17; }, async: async () => { calls++; return 23; } });
  t.after(() => configureProcessStartTimeProbe(undefined));
  for (const pid of [0, -1, 1.25, 2147483648, Infinity, NaN, "../fixture", null, undefined]) {
    assert.equal(processStartTimeSync(pid as number), undefined);
    assert.equal(await processStartTime(pid as number), undefined);
  }
  assert.equal(calls, 0);
  assert.equal(processStartTimeSync(process.pid), 17);
  assert.equal(await processStartTime(process.pid), 23);
});

test("legacy records without owner start time and valid positive PIDs remain readable", async (t) => {
  const f = await fixture(t);
  delete f.record.ownerStartedAt;
  await fs.writeFile(f.file, JSON.stringify(f.record) + "\n");
  assert.equal((await f.journal.read(f.run.runId))?.ownerPid, process.pid);
  assert.equal((await f.journal.interrupted())?.runId, f.run.runId);
});
