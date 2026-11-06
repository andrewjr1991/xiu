import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSession, listSessionsWithIssues, loadSession, rebuildSessionSummaries, unreadableSessionsNote } from "../src/session.js";
import { chooseSession, printSessionList } from "../src/commands/session-commands.js";
import { DesktopWorkspaceController } from "../apps/desktop/main/workspace-controller.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-directory-issues-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "good.jsonl");
  await fs.writeFile(file, '{"type":"task","task":"visible task"}\n');
  return { root, cwd, directory, file };
}

test("session lists retain healthy legacy logs and report directory permission failures without paths", async (t) => {
  const f = await fixture(t);
  const legacy = path.join(f.cwd, ".forge_sessions");
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, "target-extra.jsonl"), '{"type":"task","task":"legacy task"}\n');
  const original = fs.readdir.bind(fs);
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === f.directory) throw Object.assign(new Error(`private-directory-canary ${f.directory}`), { code: "EACCES" });
    return original(...args);
  });
  const listing = await listSessionsWithIssues(f.cwd);
  assert.deepEqual(listing.sessions.map((entry) => entry.id), ["target-extra"]);
  assert.deepEqual(listing.directoryIssues, [{ reason: "EACCES" }]);
  const en = unreadableSessionsNote(listing.unreadable, "en-US", listing.sessions, listing.directoryIssues);
  assert.match(en!, /1 session director.*could not be listed.*EACCES.*history may be incomplete/);
  assert.match(unreadableSessionsNote([], "zh-CN", [], listing.directoryIssues)!, /1 个会话目录无法列出.*EACCES/);
  assert.doesNotMatch(en!, /private-directory-canary|xiu-directory-issues|target-extra/);
  await assert.rejects(loadSession(f.cwd, "target"), (error: NodeJS.ErrnoException) => error.code === "EACCES", "a hidden exact target must not silently select a readable prefix match");
});

test("restoring history refuses incomplete directory enumeration even when one exact log is readable", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, ".forge_sessions"), "private-canary");
  for (const id of [undefined, "good"]) {
    await assert.rejects(loadSession(f.cwd, id), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR" && !error.message.includes(f.cwd));
  }
  assert.equal(await fs.readFile(f.file, "utf8"), '{"type":"task","task":"visible task"}\n');
});

test("index rebuilding refuses an incomplete scan before creating any summaries", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, ".forge_sessions"), "private-canary");
  await assert.rejects(rebuildSessionSummaries(f.cwd), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR");
  assert.deepEqual(await fs.readdir(f.directory), ["good.jsonl"]);
});

test("session deletion refuses incomplete directory enumeration before removing a readable log", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, ".forge_sessions"), "private-canary");
  await assert.rejects(deleteSession(f.cwd, "good"), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR");
  assert.equal((await fs.stat(f.file)).isFile(), true);
});

test("empty CLI history with unreadable directories is not reported as an empty workspace", async () => {
  const logs: string[] = [];
  await printSessionList("/workspace", "en-US", {
    list: async () => ({ sessions: [], unreadable: [], directoryIssues: [{ reason: "EACCES" }] }),
    log: (line) => { logs.push(line); },
  });
  assert.match(logs.join("\n"), /No readable Xiu sessions/);
  assert.match(logs.join("\n"), /session director.*could not be listed.*EACCES/);
  assert.doesNotMatch(logs.join("\n"), /No Xiu sessions in this workspace/);
});

test("desktop preserves readable tasks with a history warning and clears it after repair", async (t) => {
  const f = await fixture(t);
  const broken = path.join(f.cwd, ".forge_sessions");
  await fs.writeFile(broken, "private-canary");
  const controller = new DesktopWorkspaceController({ trustStorePath: path.join(f.root, "state", "trust.json"), recentStorePath: path.join(f.root, "state", "recent.json"), taskRunRoot: path.join(f.root, "runs") });
  const selected = await controller.selectWorkspace(f.cwd);
  assert.equal(selected.trust, "required");
  assert.deepEqual(selected.tasks, []);
  assert.equal(selected.error, undefined);
  const trusted = await controller.trustCurrent({ workspaceId: selected.workspace!.id, acknowledged: true });
  assert.equal(trusted.tasks[0]?.id, "good");
  assert.match(trusted.error!, /会话目录无法列出.*ENOTDIR/);
  assert.doesNotMatch(trusted.error!, /private-canary|xiu-directory-issues/);
  await fs.rm(broken);
  const repaired = await controller.snapshot();
  assert.equal(repaired.tasks[0]?.id, "good");
  assert.equal(repaired.error, undefined);
});


test("resume chooser stops on an incomplete directory scan before selection or new-session fallback", async (t) => {
  t.mock.method(console, "log", () => {});
  let selections = 0;
  let loads = 0;
  await assert.rejects(chooseSession("/workspace", "en-US", {
    list: async () => ({ sessions: [{ id: "good", file: "good.jsonl", firstTask: "task", createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z", size: 0 }], unreadable: [], directoryIssues: [{ reason: "ENOTDIR" }] }),
    select: async (_title, options) => { selections++; return options[0]!.value; },
    load: async () => { loads++; throw new Error("selector reached an unsafe load"); },
  }), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR");
  assert.equal(selections, 0);
  assert.equal(loads, 0);
});
