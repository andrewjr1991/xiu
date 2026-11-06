import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopWorkspaceController } from "../apps/desktop/main/workspace-controller.js";
import { TaskRunJournal } from "../src/task-run.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-history-refresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, ".xiu", "sessions"), { recursive: true });
  const cwd = await fs.realpath(workspace);
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.writeFile(path.join(directory, "visible.jsonl"), '{"type":"task","task":"old-workspace-private-canary"}\n');
  const taskRunRoot = path.join(root, "runs");
  const controller = new DesktopWorkspaceController({ trustStorePath: path.join(root, "state", "trust.json"), recentStorePath: path.join(root, "state", "recent.json"), taskRunRoot });
  const selected = await controller.selectWorkspace(cwd);
  await controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true });
  const journal = new TaskRunJournal(cwd, taskRunRoot);
  return { root, cwd, directory, taskRunRoot, controller, journal };
}

test("desktop history clears a previous storage failure after a successful refresh", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.taskRunRoot, { recursive: true });
  const blocked = path.join(f.taskRunRoot, f.journal.workspaceId);
  await fs.writeFile(blocked, "not a directory");
  const failed = await f.controller.snapshot();
  assert.match(failed.error!, /ENOTDIR/);
  await fs.rm(blocked);
  const repaired = await f.controller.snapshot();
  assert.equal(repaired.tasks[0]?.id, "visible");
  assert.equal(repaired.error, undefined);
});

test("desktop reports unreadable run records without hiding healthy tasks or relaxing recovery", async (t) => {
  const f = await fixture(t);
  await f.journal.begin({ sessionId: "healthy-run", task: "healthy run", providerId: "p", model: "m" });
  await f.journal.complete("completed");
  const damaged = path.join(f.taskRunRoot, f.journal.workspaceId, "private-bad-record-canary.json");
  await fs.writeFile(damaged, '{"version":999}');
  const snapshot = await f.controller.snapshot();
  assert.ok(snapshot.tasks.some((task) => task.id === "healthy-run"));
  assert.match(snapshot.error!, /1 条运行记录无法读取.*corrupt/);
  assert.doesNotMatch(snapshot.error!, /private-bad-record-canary|xiu-history-refresh/);
  await assert.rejects(f.journal.interrupted(), /Unsupported or corrupt/);
  await fs.rm(damaged);
  assert.equal((await f.controller.snapshot()).error, undefined);
});

for (const failOldRead of [false, true]) {
  test(`a late ${failOldRead ? "failed" : "successful"} history snapshot cannot overwrite an untrusted workspace selection`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const other = path.join(f.root, "other-workspace");
    await fs.mkdir(other);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = failOldRead ? path.join(f.taskRunRoot, f.journal.workspaceId) : f.directory;
    const original = fs.readdir.bind(fs);
    let blocked = false;
    t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
      if (!blocked && String(args[0]) === target) {
        blocked = true;
        enter();
        await gate;
        if (failOldRead) throw Object.assign(new Error("private-old-error-canary"), { code: "EIO" });
      }
      return original(...args);
    });
    const pending = f.controller.snapshot();
    await entered;
    try {
      const selected = await f.controller.selectWorkspace(other);
      assert.equal(selected.trust, "required");
    } finally { release(); }
    const late = await pending;
    assert.equal(late.trust, "required");
    assert.equal(late.workspace?.name, "other-workspace");
    assert.equal(late.workspace?.path, undefined);
    assert.deepEqual(late.tasks, []);
    assert.equal(late.error, undefined);
    const current = await f.controller.snapshot();
    assert.equal(current.trust, "required");
    assert.equal(current.error, undefined);
    assert.doesNotMatch(JSON.stringify(late), /old-workspace-private-canary|private-old-error-canary/);
  });
}
