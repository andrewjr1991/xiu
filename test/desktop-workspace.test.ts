import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopWorkspaceController } from "../apps/desktop/main/workspace-controller.js";
import { isTrustedRendererUrl, resolveRendererAsset, secureWebPreferences } from "../apps/desktop/main/security-policy.js";
import { TaskRunJournal } from "../src/task-run.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, ".xiu", "sessions"), { recursive: true });
  const trustStorePath = path.join(root, "state", "trust.json");
  const recentStorePath = path.join(root, "state", "recent.json");
  const taskRunRoot = path.join(root, "runs");
  const controller = new DesktopWorkspaceController({ trustStorePath, recentStorePath, taskRunRoot, now: () => new Date("2026-09-28T10:00:00.000Z") });
  return { root, workspace, trustStorePath, recentStorePath, taskRunRoot, controller };
}

test("untrusted workspace exposes only its directory name and reads no task history", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(item.workspace, ".xiu", "sessions", "private.jsonl"), `${JSON.stringify({ type: "task", task: "secret project task" })}\n`);
  const snapshot = await item.controller.selectWorkspace(item.workspace);
  assert.equal(snapshot.trust, "required");
  assert.equal(snapshot.workspace?.name, "workspace");
  assert.equal(snapshot.workspace?.path, undefined);
  assert.deepEqual(snapshot.tasks, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret project task/);
  await assert.rejects(() => fs.access(item.recentStorePath));
});

test("explicit trust unlocks bounded task history and remembers the workspace", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(item.workspace, ".xiu", "sessions", "session-one.jsonl"), `${JSON.stringify({ type: "task", task: "implement desktop shell", timestamp: "2026-09-28T09:00:00.000Z" })}\n`);
  const selected = await item.controller.selectWorkspace(item.workspace);
  await assert.rejects(() => item.controller.trustCurrent({ workspaceId: "stale", acknowledged: true }), /stale/);
  const trusted = await item.controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true });
  assert.equal(trusted.trust, "trusted");
  assert.equal(trusted.workspace?.path, await fs.realpath(item.workspace));
  assert.equal(trusted.tasks[0]?.title, "implement desktop shell");
  assert.equal(trusted.recent[0]?.trusted, true);
  const closed = await item.controller.clearSelection();
  assert.equal(closed.trust, "none");
  assert.equal(closed.workspace, undefined);
  assert.equal(closed.recent[0]?.trusted, true);
});

test("desktop task list groups follow-up runs by stable conversation identity", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(item.workspace, ".xiu", "sessions", "session-one.jsonl"), [
    JSON.stringify({ type: "task", task: "first conversation title", timestamp: "2026-09-28T09:00:00.000Z" }),
    JSON.stringify({ type: "task", task: "follow-up prompt", timestamp: "2026-09-28T09:02:00.000Z" }),
  ].join("\n") + "\n");
  const selected = await item.controller.selectWorkspace(item.workspace);
  await item.controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true });
  const journal = new TaskRunJournal(await fs.realpath(item.workspace), item.taskRunRoot);
  await journal.begin({ sessionId: "session-one", task: "first conversation title", providerId: "p", model: "m" });
  await journal.complete("completed");
  await journal.begin({ sessionId: "session-one", task: "follow-up prompt", providerId: "p", model: "m" });
  await journal.complete("completed");
  const snapshot = await item.controller.snapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0]?.id, "session-one");
  assert.equal(snapshot.tasks[0]?.title, "first conversation title");
  assert.equal(snapshot.tasks[0]?.status, "completed");
});

test("removing a recent workspace requires confirmation and never deletes its directory", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const selected = await item.controller.selectWorkspace(item.workspace);
  await item.controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true });
  await assert.rejects(() => item.controller.removeRecent({ workspaceId: selected.workspace!.id, confirmed: true }, false), /主进程确认/);
  const removed = await item.controller.removeRecent({ workspaceId: selected.workspace!.id, confirmed: true }, true);
  assert.equal(removed.trust, "none");
  assert.deepEqual(removed.recent, []);
  assert.equal((await fs.stat(item.workspace)).isDirectory(), true);
});

test("task-run locks are surfaced read-only without taking over the writer", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const selected = await item.controller.selectWorkspace(item.workspace);
  await item.controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true });
  const journal = new TaskRunJournal(await fs.realpath(item.workspace), item.taskRunRoot);
  const run = await journal.begin({ sessionId: "desktop-lock", task: "active task", providerId: "p", model: "m" });
  const snapshot = await item.controller.snapshot();
  assert.equal(snapshot.workspace?.lock, "active-elsewhere");
  assert.equal(snapshot.tasks[0]?.status, "running");
  assert.equal(journal.currentRun()?.runId, run.runId);
  await journal.complete("cancelled");
});

test("desktop renderer policy rejects navigation tricks and enables isolation", () => {
  assert.deepEqual(secureWebPreferences, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    safeDialogs: true,
    spellcheck: false,
  });
  assert.equal(isTrustedRendererUrl("xiu-app://bundle/index.html"), true);
  assert.equal(isTrustedRendererUrl("https://bundle/index.html"), false);
  assert.equal(isTrustedRendererUrl("xiu-app://bundle.evil/index.html"), false);
  const root = path.resolve("renderer-root");
  assert.equal(resolveRendererAsset(root, "/assets/app.js"), path.join(root, "assets", "app.js"));
  assert.equal(resolveRendererAsset(root, "/../secret.txt"), undefined);
  assert.equal(resolveRendererAsset(root, "/%2e%2e/secret.txt"), undefined);
  assert.equal(resolveRendererAsset(root, "/%00bad"), undefined);
});

test("corrupt desktop history fails closed instead of forgetting trusted state", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(item.recentStorePath), { recursive: true });
  await fs.writeFile(item.recentStorePath, "{not-json");
  await assert.rejects(() => item.controller.snapshot());
});
