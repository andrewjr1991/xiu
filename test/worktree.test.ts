import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WorktreeManager } from "../src/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-worktree-"));
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Xiu Test"]);
  await git(cwd, ["config", "user.email", "xiu@example.invalid"]);
  await fs.writeFile(path.join(cwd, ".gitignore"), ".xiu/\n", "utf8");
  await fs.writeFile(path.join(cwd, "base.txt"), "base\n", "utf8");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "base"]);
  return cwd;
}

test("worktree agents stay isolated until an approved integration", async () => {
  const cwd = await repository();
  const manager = new WorktreeManager(cwd);
  const first = await manager.create("run-one", "first");
  const second = await manager.create("run-one", "second");
  await fs.writeFile(path.join(first.path, "first.txt"), "from first\n", "utf8");
  await fs.writeFile(path.join(second.path, "second.txt"), "from second\n", "utf8");
  await assert.rejects(fs.access(path.join(cwd, "first.txt")));
  await assert.rejects(fs.access(path.join(cwd, "second.txt")));
  assert.match(await manager.diff(first), /first\.txt/);
  await manager.integrate(first);
  assert.equal((await fs.readFile(path.join(cwd, "first.txt"), "utf8")).replace(/\r\n/g, "\n"), "from first\n");
  await assert.rejects(fs.access(path.join(cwd, "second.txt")));
});

test("conflicting agent patches do not alter the main workspace", async () => {
  const cwd = await repository();
  const manager = new WorktreeManager(cwd);
  const info = await manager.create("run-two", "conflict");
  await fs.writeFile(path.join(info.path, "base.txt"), "agent version\n", "utf8");
  await fs.writeFile(path.join(cwd, "base.txt"), "main version\n", "utf8");
  await assert.rejects(manager.integrate(info), /was not applied/);
  assert.equal(await fs.readFile(path.join(cwd, "base.txt"), "utf8"), "main version\n");
  assert.equal(await fs.readFile(path.join(info.path, "base.txt"), "utf8"), "agent version\n");
});
