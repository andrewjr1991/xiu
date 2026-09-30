import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteTaskChangeHistory, loadTaskChangeHistory, saveTaskChangeHistory } from "../src/task-change-history.js";
import type { TaskChangeReport } from "../src/task-changes.js";

function report(pathname = "src/example.ts", preview = "@@ -1,1 +1,1 @@\n- old\n+ new"): TaskChangeReport {
  return {
    view: "task", git: true, capturedAt: "2026-09-30T00:00:00.000Z", complete: true,
    preExisting: [], warnings: [],
    changes: [{ path: pathname, kind: "modified", source: "unknown", preExisting: false, staged: false, preview, limitations: [] }],
  };
}

test("task change history saves, reloads, redacts and deletes a bounded report", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-change-history-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const runId = "run-safe-1";
  await saveTaskChangeHistory(workspace, runId, report("src/example.ts", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n+ ok"));
  const file = path.join(workspace, ".xiu", "task-change-history", `${runId}.json`);
  const raw = await fs.readFile(file, "utf8");
  assert.doesNotMatch(raw, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(raw, /REDACTED/);
  assert.deepEqual((await loadTaskChangeHistory(workspace, runId))?.changes[0]?.path, "src/example.ts");
  assert.equal(await deleteTaskChangeHistory(workspace, runId), true);
  assert.equal(await loadTaskChangeHistory(workspace, runId), undefined);
});

test("task change history enforces run IDs, safe source paths and schema versions", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-change-history-validation-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(() => saveTaskChangeHistory(workspace, "../escape", report()), /Invalid task change history run ID/);
  await assert.rejects(() => saveTaskChangeHistory(workspace, "safe-run", report("../outside.ts")), /unsafe path/);
  await assert.rejects(() => saveTaskChangeHistory(workspace, "safe-run", report(".xiu/private.json")), /unsafe path/);
  await saveTaskChangeHistory(workspace, "safe-run", report());
  const file = path.join(workspace, ".xiu", "task-change-history", "safe-run.json");
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 99, runId: "safe-run", savedAt: new Date().toISOString(), report: report() }));
  await assert.rejects(() => loadTaskChangeHistory(workspace, "safe-run"), /Unsupported or corrupt/);
});

test("task change history caps file count, preview size and total serialized bytes", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-change-history-bounds-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const large = report();
  large.changes = Array.from({ length: 510 }, (_, index) => ({
    path: `src/file-${index}.ts`, kind: "modified" as const, source: "unknown" as const,
    preExisting: false, staged: false, preview: `+ ${"x".repeat(20_000)}`, limitations: [],
  }));
  await saveTaskChangeHistory(workspace, "bounded-run", large);
  const file = path.join(workspace, ".xiu", "task-change-history", "bounded-run.json");
  const stat = await fs.stat(file);
  const loaded = await loadTaskChangeHistory(workspace, "bounded-run");
  assert.ok(stat.size <= 1024 * 1024);
  assert.equal(loaded?.changes.length, 500);
  assert.equal(loaded?.complete, false);
  assert.ok(loaded?.warnings.some((warning) => warning.startsWith("history-file-limit:")));
  assert.ok(loaded?.changes.every((change) => !change.preview || Buffer.byteLength(change.preview, "utf8") <= 16 * 1024));
});

test("task change history rejects a linked storage directory", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-change-history-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-change-history-outside-"));
  t.after(() => Promise.all([fs.rm(workspace, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(workspace, ".xiu"));
  try {
    await fs.symlink(outside, path.join(workspace, ".xiu", "task-change-history"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlink creation is not permitted on this machine"); return; }
    throw error;
  }
  await assert.rejects(() => saveTaskChangeHistory(workspace, "linked-run", report()), /Unsafe task change history directory/);
});
