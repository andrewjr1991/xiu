import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopWorkspaceController } from "../apps/desktop/main/workspace-controller.js";
import { isWorkspaceTrusted, trustWorkspace } from "../src/trust.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-trust-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  const trustStorePath = path.join(root, "state", "trust.json");
  const controller = new DesktopWorkspaceController({ trustStorePath, recentStorePath: path.join(root, "state", "recent.json"), taskRunRoot: path.join(root, "runs") });
  const selected = await controller.selectWorkspace(first);
  return { root, first, second, trustStorePath, controller, selected };
}

for (const transition of ["switch", "close"] as const) {
  test(`a trust save finishing after workspace ${transition} cannot reactivate the old selection`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === f.trustStorePath) { enter(); await gate; }
      return original(...args);
    });
    const pending = f.controller.trustCurrent({ workspaceId: f.selected.workspace!.id, acknowledged: true }).then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
    await entered;
    try {
      if (transition === "switch") await f.controller.selectWorkspace(f.second);
      else await f.controller.clearSelection();
    } finally { release(); }
    const outcome = await pending;
    assert.ok(outcome.error, "an obsolete confirmation must not be applied to the current selection");
    assert.match(outcome.error.message, /selection changed|unavailable|stale/i);
    const current = await f.controller.snapshot();
    assert.equal(current.trust, transition === "switch" ? "required" : "none");
    assert.equal(current.workspace?.path, undefined);
    assert.deepEqual(current.tasks, []);
    assert.throws(() => f.controller.trustedWorkspacePath(), /trusted workspace/);
    assert.equal(await isWorkspaceTrusted(f.second, f.trustStorePath), false);
    assert.equal(await isWorkspaceTrusted(f.first, f.trustStorePath), true, "only the explicitly confirmed original workspace may have been persisted; do not roll it back or transfer it");
  });
}

test("closing and reopening the same workspace invalidates a pending trust decision before persistence", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const canonical = await fs.realpath(f.first);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = fs.realpath.bind(fs);
  let blocked = false;
  t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
    if (!blocked && String(args[0]) === canonical) { blocked = true; enter(); await gate; }
    return original(...args);
  });
  const pending = f.controller.trustCurrent({ workspaceId: f.selected.workspace!.id, acknowledged: true }).then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
  await entered;
  try {
    await f.controller.clearSelection();
    const reopened = await f.controller.selectWorkspace(f.first);
    assert.equal(reopened.workspace!.id, f.selected.workspace!.id, "a stable workspace ID does not make the old confirmation current");
    assert.equal(reopened.trust, "required");
  } finally { release(); }
  assert.ok((await pending).error);
  assert.equal((await f.controller.snapshot()).trust, "required");
  assert.equal(await isWorkspaceTrusted(f.first, f.trustStorePath), false);
  await assert.rejects(fs.access(f.trustStorePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

for (const kind of ["case", "backslash"] as const) {
  test(`POSIX ${kind}-distinct paths cannot reuse a workspace trust confirmation`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    const first = path.join(f.root, kind === "case" ? "Project" : "part\\name");
    const second = path.join(f.root, kind === "case" ? "project" : "part/name");
    await fs.mkdir(first, { recursive: true });
    if (kind === "case") {
      try { await fs.mkdir(second); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { t.skip("filesystem does not distinguish path case"); return; } throw error; }
    } else await fs.mkdir(second, { recursive: true });
    const selected = await f.controller.selectWorkspace(first);
    const current = await f.controller.selectWorkspace(second);
    await assert.rejects(f.controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true }), /unavailable|stale/);
    assert.notEqual(selected.workspace!.id, current.workspace!.id);
    assert.equal(await isWorkspaceTrusted(second, f.trustStorePath), false);
  });
}


test("legacy recent workspace IDs are upgraded in memory and stay openable without duplicate rows", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const workspace = path.join(f.root, "MixedCaseProject");
  await fs.mkdir(workspace);
  const canonical = await fs.realpath(workspace);
  await trustWorkspace(canonical, f.trustStorePath);
  const recentStorePath = path.join(f.root, "state", "recent.json");
  const oldId = createHash("sha256").update(canonical.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 24);
  const expected = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  const original = JSON.stringify({ version: 1, workspaces: [{ id: oldId, path: canonical, lastOpenedAt: "2026-11-06T00:00:00Z" }] });
  await fs.writeFile(recentStorePath, original);
  const snapshot = await f.controller.snapshot();
  assert.equal(snapshot.recent[0]!.id, expected);
  assert.equal(await fs.readFile(recentStorePath, "utf8"), original, "reading history does not rewrite the store");
  const opened = await f.controller.openRecent({ workspaceId: expected });
  assert.equal(opened.workspace!.id, expected);
  assert.equal(opened.recent.length, 1);
  const stored = JSON.parse(await fs.readFile(recentStorePath, "utf8"));
  assert.equal(stored.workspaces[0].id, expected);
});
