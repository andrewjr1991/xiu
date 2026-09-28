import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureTaskBaseline, inspectTaskChanges, getWorkspaceDiff, formatTaskChanges } from "../src/task-changes.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
}
async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-task-diff-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Xiu Test");
  await git(root, "config", "user.email", "xiu-test@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(root, "existing.txt"), "original\n");
  await fs.writeFile(path.join(root, "deleted.txt"), "remove me\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

test("task diff separates dirty baseline from new, staged and deleted changes without mutating Git", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "existing.txt"), "user edit\n");
  await git(root, "add", "existing.txt");
  await fs.writeFile(path.join(root, "user-note.txt"), "user note\n");
  const baseline = await captureTaskBaseline(root);
  assert.deepEqual(baseline.preExisting, ["existing.txt", "user-note.txt"]);
  assert.deepEqual(baseline.staged, ["existing.txt"]);
  await fs.writeFile(path.join(root, "existing.txt"), "user edit\ntask edit\n");
  await fs.writeFile(path.join(root, "new.txt"), "new task file\n");
  await git(root, "add", "new.txt");
  await fs.unlink(path.join(root, "deleted.txt"));
  const status = await git(root, "status", "--porcelain=v1");
  const index = await fs.readFile(path.join(root, ".git", "index"));
  const result = await inspectTaskChanges(root, baseline);
  assert.deepEqual(result.changes.map((item) => [item.path, item.kind, item.preExisting]), [
    ["deleted.txt", "deleted", false], ["existing.txt", "modified", true], ["new.txt", "created", false],
  ]);
  assert.ok(result.changes.every((item) => item.source === "unknown"));
  assert.match(result.changes.find((item) => item.path === "existing.txt")!.preview!, /task edit/);
  assert.doesNotMatch(result.changes.find((item) => item.path === "existing.txt")!.preview!, /original/);
  assert.match(formatTaskChanges(result, "en"), /Source unknown/);
  assert.equal(await git(root, "status", "--porcelain=v1"), status);
  assert.deepEqual(await fs.readFile(path.join(root, ".git", "index")), index);
  assert.equal(await fs.readFile(path.join(root, "user-note.txt"), "utf8"), "user note\n");
});

test("staging during a task is visible even when file content stays unchanged", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "existing.txt"), "edited before task\n");
  const baseline = await captureTaskBaseline(root);
  await git(root, "add", "existing.txt");
  const report = await inspectTaskChanges(root, baseline);
  assert.equal(report.changes.length, 1);
  assert.equal(report.changes[0]!.kind, "index-only");
  assert.equal(report.changes[0]!.preExisting, true);
});

test("workspace and staged views include untracked additions and staged deletions with distinct content", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "existing.txt"), "staged content\n");
  await git(root, "add", "existing.txt");
  await fs.writeFile(path.join(root, "existing.txt"), "working content\n");
  await git(root, "rm", "--quiet", "deleted.txt");
  await fs.writeFile(path.join(root, "untracked.txt"), "fresh\n");
  const workspace = await getWorkspaceDiff(root, "workspace");
  const staged = await getWorkspaceDiff(root, "staged");
  assert.deepEqual(workspace.changes.map((item) => [item.path, item.kind]), [
    ["deleted.txt", "deleted"], ["existing.txt", "modified"], ["untracked.txt", "created"],
  ]);
  assert.equal(staged.changes.length, 2);
  assert.match(workspace.changes.find((item) => item.path === "existing.txt")!.preview!, /working content/);
  assert.match(staged.changes.find((item) => item.path === "existing.txt")!.preview!, /staged content/);
});

test("Git subdirectory workspace stays scoped and HEAD paths remain relative", async () => {
  const root = await project();
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "file.txt"), "before\n");
  await git(root, "add", "sub");
  await git(root, "commit", "--quiet", "-m", "sub");
  await fs.writeFile(path.join(root, "sub", "file.txt"), "after\n");
  await fs.writeFile(path.join(root, "existing.txt"), "outside sub\n");
  const report = await getWorkspaceDiff(path.join(root, "sub"));
  assert.deepEqual(report.changes.map((item) => item.path), ["file.txt"]);
  assert.match(report.changes[0]!.preview!, /- before/);
});

test("task diff works without Git, honors ignore files, and never traverses junctions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-task-no-git-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-task-outside-"));
  await fs.writeFile(path.join(outside, "private.txt"), "outside canary\n");
  await fs.writeFile(path.join(root, "a.txt"), "before\n");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\nignored-dir/\n");
  await fs.writeFile(path.join(root, "ignored.txt"), "must not read\n");
  await fs.mkdir(path.join(root, "ignored-dir"));
  await fs.writeFile(path.join(root, "ignored-dir", "data.txt"), "must not read\n");
  await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const baseline = await captureTaskBaseline(root);
  assert.equal(baseline.git, false);
  assert.equal(baseline.files.has("ignored.txt"), false);
  assert.equal(baseline.files.has("ignored-dir/data.txt"), false);
  assert.equal(baseline.files.has("linked"), false);
  assert.equal(baseline.files.has("linked/private.txt"), false);
  await fs.unlink(path.join(root, "a.txt"));
  await fs.writeFile(path.join(root, "new.txt"), "new\n");
  const report = await inspectTaskChanges(root, baseline);
  assert.deepEqual(report.changes.map((item) => [item.path, item.kind]), [["a.txt", "deleted"], ["new.txt", "created"]]);
  assert.doesNotMatch(formatTaskChanges(report, "en"), /outside canary/);
  assert.match((await getWorkspaceDiff(root, "staged")).warnings.join(" "), /no-git-baseline/);
});

test("excluded and ignored files are never captured even when force tracked; previews redact runtime secrets", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(root, "ignored.txt"), "ignored canary\n");
  await fs.writeFile(path.join(root, ".env"), "private canary\n");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "module.js"), "dependency canary\n");
  await git(root, "add", "-f", ".env", "ignored.txt", "node_modules/module.js");
  const options = { sensitiveValues: ["unique-canary-987654321"] };
  const baseline = await captureTaskBaseline(root, options);
  assert.equal(baseline.files.has(".env"), false);
  assert.equal(baseline.files.has("ignored.txt"), false);
  assert.equal(baseline.files.has("node_modules/module.js"), false);
  await fs.writeFile(path.join(root, "existing.txt"), "const value = 'unique-canary-987654321';\n");
  const report = await inspectTaskChanges(root, baseline, options);
  const formatted = formatTaskChanges(report, "en");
  assert.doesNotMatch(formatted, /unique-canary-987654321|private canary|ignored canary|dependency canary/);
  assert.match(formatted, /REDACTED/);
  const staged = await getWorkspaceDiff(root, "staged");
  assert.equal(staged.changes.length, 0);
});

test("binary edits are detected by digest, while large files and partial coverage are explicitly limited", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, "large.txt"), "a".repeat(500));
  const options = { maxFileBytes: 100 };
  const baseline = await captureTaskBaseline(root, options);
  assert.equal(baseline.files.get("binary.bin")!.omitted, "binary");
  assert.equal(baseline.files.get("large.txt")!.omitted, "size-limit");
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 3]));
  await fs.writeFile(path.join(root, "large.txt"), "b".repeat(501));
  const result = await inspectTaskChanges(root, baseline, options);
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes[0]!.preview, undefined);
  assert.match(formatTaskChanges(result, "en"), /binary|size-limit/);
  const partial = await captureTaskBaseline(root, { maxFiles: 1 });
  const report = await inspectTaskChanges(root, partial, { maxFiles: 1 });
  assert.equal(report.complete, false);
  assert.match(formatTaskChanges(report, "en"), /Coverage is incomplete/);
  assert.equal(report.changes.length, 0);
});

test("baseline cannot be used in another workspace and an unborn Git index is supported", async () => {
  const root = await project();
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-task-unborn-"));
  const baseline = await captureTaskBaseline(root);
  await assert.rejects(inspectTaskChanges(other, baseline), /another workspace/);
  await git(other, "init", "--quiet");
  await fs.writeFile(path.join(other, "first.txt"), "first\n");
  await git(other, "add", "first.txt");
  const report = await getWorkspaceDiff(other, "staged");
  assert.deepEqual(report.changes.map((item) => [item.path, item.kind]), [["first.txt", "created"]]);
});

test("new ignore rules omit previously captured content instead of reporting a false deletion", async () => {
  const root = await project();
  const baseline = await captureTaskBaseline(root);
  await fs.writeFile(path.join(root, ".gitignore"), "existing.txt\n");
  await fs.writeFile(path.join(root, "existing.txt"), "do not capture this content\n");
  const report = await inspectTaskChanges(root, baseline);
  const existing = report.changes.find((item) => item.path === "existing.txt")!;
  assert.equal(existing.kind, "unknown");
  assert.ok(existing.limitations.includes("ignored"));
  assert.equal(existing.preview, undefined);
  assert.doesNotMatch(formatTaskChanges(report, "en"), /do not capture this content/);
});

test("new file previews have no invented deletion and total snapshot bytes are bounded", async () => {
  const root = await project();
  const baseline = await captureTaskBaseline(root);
  await fs.writeFile(path.join(root, "new.txt"), "created line\n");
  const report = await inspectTaskChanges(root, baseline);
  assert.match(report.changes[0]!.preview!, /@@ -0,0 \+1,1 @@/);
  assert.doesNotMatch(report.changes[0]!.preview!, /\n- /);
  const bounded = await captureTaskBaseline(root, { maxTotalBytes: 15 });
  assert.ok([...bounded.files.values()].some((file) => file.omitted === "total-limit"));
  assert.ok([...bounded.files.values()].filter((file) => !!file.digest).reduce((sum, file) => sum + file.bytes, 0) <= 15);
});
