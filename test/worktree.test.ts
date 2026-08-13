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
  await fs.writeFile(path.join(cwd, "package.json"), '{"dependencies":{"alpha":"1.0.0"}}\n', "utf8");
  await fs.writeFile(path.join(cwd, "source.ts"), "export function alpha(value: string): string { return value; }\n", "utf8");
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

test("disjoint dirty main-workspace changes are reported and preserved during integration", async () => {
  const cwd = await repository();
  const manager = new WorktreeManager(cwd);
  const info = await manager.create("run-three", "disjoint");
  await fs.writeFile(path.join(info.path, "agent.txt"), "agent addition\n", "utf8");
  await fs.writeFile(path.join(cwd, "base.txt"), "local unfinished edit\n", "utf8");
  const analysis = await manager.analyze(info);
  assert.equal(analysis.canIntegrate, true);
  assert.deepEqual(analysis.changedFiles, ["agent.txt"]);
  assert.ok(analysis.dirtyMainFiles.includes("base.txt"));
  await manager.integrate(info);
  assert.equal(await fs.readFile(path.join(cwd, "base.txt"), "utf8"), "local unfinished edit\n");
  assert.equal((await fs.readFile(path.join(cwd, "agent.txt"), "utf8")).replace(/\r\n/g, "\n"), "agent addition\n");
});

test("dependency and symbol conflicts are classified before integration", async () => {
  const cwd = await repository();
  const manager = new WorktreeManager(cwd);
  const info = await manager.create("run-four", "classified");
  await fs.writeFile(path.join(info.path, "package.json"), '{"dependencies":{"alpha":"2.0.0"}}\n', "utf8");
  await fs.writeFile(path.join(info.path, "source.ts"), "export function alpha(value: number): number { return value; }\n", "utf8");
  await fs.writeFile(path.join(cwd, "package.json"), '{"dependencies":{"alpha":"3.0.0"}}\n', "utf8");
  await fs.writeFile(path.join(cwd, "source.ts"), "export function alpha(value: boolean): boolean { return value; }\n", "utf8");
  const analysis = await manager.analyze(info);
  assert.equal(analysis.canIntegrate, false);
  assert.ok(analysis.conflicts.some((conflict) => conflict.kind === "dependency" && conflict.files.includes("package.json")));
  assert.ok(analysis.conflicts.some((conflict) => conflict.kind === "file" && conflict.files.includes("source.ts")));
  assert.ok(analysis.conflicts.some((conflict) => conflict.kind === "symbol" && conflict.symbols?.includes("alpha")));
  await assert.rejects(manager.integrate(info), /merge conflicts were detected/);
});

test("different dependency manifests changed on each side still block integration", async () => {
  const cwd = await repository();
  await fs.writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  await git(cwd, ["add", "package-lock.json"]);
  await git(cwd, ["commit", "-m", "add lock"]);
  const manager = new WorktreeManager(cwd);
  const info = await manager.create("run-five", "dependency-pair");
  await fs.writeFile(path.join(info.path, "package.json"), '{"dependencies":{"alpha":"2.0.0"}}\n', "utf8");
  await fs.writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3,"packages":{"alpha":"3.0.0"}}\n', "utf8");
  const analysis = await manager.analyze(info);
  assert.equal(analysis.canIntegrate, false);
  const dependency = analysis.conflicts.find((conflict) => conflict.kind === "dependency");
  assert.deepEqual(dependency?.files, ["package-lock.json", "package.json"]);
});
