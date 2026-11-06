import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal } from "../src/task-run.js";

const options = { sessionId: "fixture", task: "offline fixture", providerId: "offline", model: "offline" };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-owner-probe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new TaskRunJournal(root, path.join(root, "runs"));
  const run = await owner.begin(options), other = new TaskRunJournal(root, path.join(root, "runs"));
  const directory = path.join(root, "runs", owner.workspaceId);
  const snapshot = async () => Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name), "utf8")]));
  return { owner, other, run, snapshot };
}
for (const code of ["EPERM", "EIO"]) {
  for (const action of ["resume", "abandon", "delete", "inspect-lock"] as const) {
    test(`${code} owner probe cannot silently infer death during ${action}`, async t => {
      const f = await fixture(t), before = await f.snapshot(), original = process.kill;
      t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
        assert.equal(signal, 0, "owner checks must never send a terminating signal");
        if (pid === process.pid) throw Object.assign(new Error("fixture owner probe"), { code });
        return original(pid, signal);
      });
      if (action === "inspect-lock" && code === "EPERM") {
        const lock = await f.other.lockStatus();
        assert.equal(lock.active, true); assert.equal(lock.live, true);
      } else {
        const attempt = action === "resume" ? f.other.begin({ ...options, resumedFrom: f.run.runId })
          : action === "abandon" ? f.other.abandon(f.run.runId)
          : action === "delete" ? f.other.delete(f.run.runId) : f.other.lockStatus();
        await assert.rejects(attempt, error => code === "EPERM" ? /active|running/i.test((error as Error).message) : (error as NodeJS.ErrnoException).code === code);
      }
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.other.currentRun(), undefined);
    });
  }
}
test("an ESRCH owner probe still permits explicitly confirmed recovery", async t => {
  const f = await fixture(t), original = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.equal(signal, 0);
    if (pid === process.pid) throw Object.assign(new Error("fixture absent owner"), { code: "ESRCH" });
    return original(pid, signal);
  });
  assert.equal((await f.other.lockStatus()).live, false);
  const resumed = await f.other.begin({ ...options, resumedFrom: f.run.runId });
  assert.equal(resumed.resumedFrom, f.run.runId);
  assert.equal((await f.other.read(f.run.runId))?.status, "abandoned");
  await f.other.complete("completed");
});
