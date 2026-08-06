import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  if (!normalized) throw new Error("Worktree identifier is empty after normalization.");
  return normalized;
}

async function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, timeout: 60_000, maxBuffer, encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error((failure.stderr || failure.message).trim());
  }
}

async function gitNoIndexDiff(cwd: string, file: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", file], {
      cwd, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (failure.code === 1 && failure.stdout) return failure.stdout.trim();
    throw new Error((failure.stderr || failure.message).trim());
  }
}

export class WorktreeManager {
  constructor(private readonly cwd: string) {}

  private root(): string { return path.resolve(this.cwd, ".xiu", "worktrees"); }

  private validateTarget(target: string): void {
    const root = this.root();
    const resolved = path.resolve(target);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Worktree path escaped Xiu's managed directory.");
  }

  async create(runId: string, taskId: string): Promise<WorktreeInfo> {
    const repositoryRoot = path.resolve(await git(this.cwd, ["rev-parse", "--show-toplevel"]));
    if (repositoryRoot.toLowerCase() !== path.resolve(this.cwd).toLowerCase()) {
      throw new Error("Worktree agents currently require Xiu to run at the Git repository root.");
    }
    const baseCommit = await git(this.cwd, ["rev-parse", "HEAD"]);
    const run = safeSegment(runId);
    const task = safeSegment(taskId);
    const target = path.join(this.root(), run, task);
    this.validateTarget(target);
    const branch = `xiu/agent-${run.slice(-17)}-${task}`;
    const existing = await fs.stat(target).catch(() => undefined);
    if (existing) {
      if (!existing.isDirectory()) throw new Error(`Worktree target exists and is not a directory: ${target}`);
      const currentBranch = await git(target, ["branch", "--show-current"]);
      return { path: target, branch: currentBranch || branch, baseCommit };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await git(this.cwd, ["worktree", "add", "-b", branch, target, baseCommit]);
    return { path: target, branch, baseCommit };
  }

  async diff(info: WorktreeInfo): Promise<string> {
    this.validateTarget(info.path);
    const tracked = await git(info.path, ["diff", "--binary", info.baseCommit, "--"]);
    const untracked = (await git(info.path, ["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/).filter(Boolean);
    const additions: string[] = [];
    for (const file of untracked) {
      const full = path.resolve(info.path, file);
      const relative = path.relative(path.resolve(info.path), full);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Untracked Worktree path escaped its workspace.");
      additions.push(await gitNoIndexDiff(info.path, file));
    }
    const chunks = [tracked, ...additions].filter(Boolean);
    const patch = chunks.map((chunk) => chunk.endsWith("\n") ? chunk : `${chunk}\n`).join("");
    return patch || "No changes in this Agent Worktree.";
  }

  async integrate(info: WorktreeInfo): Promise<string> {
    const patch = await this.diff(info);
    if (patch === "No changes in this Agent Worktree.") return patch;
    const patchDirectory = path.join(this.cwd, ".xiu", "agents", "patches");
    await fs.mkdir(patchDirectory, { recursive: true });
    const patchFile = path.join(patchDirectory, `${safeSegment(info.branch)}-${Date.now()}.patch`);
    await fs.writeFile(patchFile, patch, "utf8");
    try {
      await git(this.cwd, ["apply", "--check", "--binary", patchFile]);
      await git(this.cwd, ["apply", "--binary", patchFile]);
    } catch (error) {
      throw new Error(`Agent patch was not applied: ${error instanceof Error ? error.message : String(error)}. The Worktree was preserved at ${info.path}.`);
    }
    return `Applied Agent patch to the main workspace. Worktree preserved at ${info.path}. Run review and verification before completion.`;
  }
}
