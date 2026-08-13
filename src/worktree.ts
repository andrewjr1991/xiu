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

export type WorktreeConflictKind = "file" | "symbol" | "dependency" | "git-apply";

export interface WorktreeMergeConflict {
  kind: WorktreeConflictKind;
  detail: string;
  files: string[];
  symbols?: string[];
}

export interface WorktreeMergeAnalysis {
  patch: string;
  patchFile?: string;
  changedFiles: string[];
  mainChangesSinceBase: string[];
  dirtyMainFiles: string[];
  conflicts: WorktreeMergeConflict[];
  canIntegrate: boolean;
}

const dependencyFiles = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "requirements.txt", "pyproject.toml", "poetry.lock", "pipfile", "pipfile.lock",
  "cargo.toml", "cargo.lock", "go.mod", "go.sum", "pom.xml", "build.gradle", "build.gradle.kts",
  "gradle.properties", "composer.json", "composer.lock", "gemfile", "gemfile.lock",
]);

function normalizedFile(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, ""); }

function uniqueFiles(values: string[]): string[] {
  return [...new Set(values.map(normalizedFile).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function parseFileList(value: string): string[] { return uniqueFiles(value.split(/\r?\n/)); }

function isDependencyFile(file: string): boolean { return dependencyFiles.has(path.posix.basename(normalizedFile(file)).toLowerCase()); }

function changedSymbols(patch: string): string[] {
  const symbols = new Set<string>();
  const reserved = new Set(["if", "for", "while", "switch", "catch", "return", "new"]);
  for (const line of patch.split(/\r?\n/)) {
    if (!/^[+-](?![+-])/.test(line)) continue;
    const source = line.slice(1);
    const declaration = source.match(/\b(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|func)\s+([A-Za-z_$][\w$]*)/);
    const callable = source.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:[A-Za-z_$][\w$<>\[\], |]*\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    const symbol = declaration?.[1] ?? callable?.[1];
    if (symbol && !reserved.has(symbol)) symbols.add(symbol);
  }
  return [...symbols].sort((a, b) => a.localeCompare(b));
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

  private async filesChangedFrom(cwd: string, baseCommit: string): Promise<string[]> {
    const tracked = parseFileList(await git(cwd, ["diff", "--name-only", baseCommit, "--"]));
    const untracked = parseFileList(await git(cwd, ["ls-files", "--others", "--exclude-standard"]));
    return uniqueFiles([...tracked, ...untracked]);
  }

  private async dirtyFiles(): Promise<string[]> {
    const tracked = parseFileList(await git(this.cwd, ["diff", "--name-only", "HEAD", "--"]));
    const staged = parseFileList(await git(this.cwd, ["diff", "--name-only", "--cached", "HEAD", "--"]));
    const untracked = parseFileList(await git(this.cwd, ["ls-files", "--others", "--exclude-standard"]));
    return uniqueFiles([...tracked, ...staged, ...untracked]);
  }

  private async writePatch(info: WorktreeInfo, patch: string): Promise<string> {
    const patchDirectory = path.join(this.cwd, ".xiu", "agents", "patches");
    await fs.mkdir(patchDirectory, { recursive: true });
    const patchFile = path.join(patchDirectory, `${safeSegment(info.branch)}-latest.patch`);
    const temporary = `${patchFile}.tmp`;
    await fs.writeFile(temporary, patch, "utf8");
    await fs.rename(temporary, patchFile).catch(async () => {
      await fs.copyFile(temporary, patchFile);
      await fs.unlink(temporary).catch(() => undefined);
    });
    return patchFile;
  }

  async analyze(info: WorktreeInfo): Promise<WorktreeMergeAnalysis> {
    this.validateTarget(info.path);
    const patch = await this.diff(info);
    if (patch === "No changes in this Agent Worktree.") {
      return { patch, changedFiles: [], mainChangesSinceBase: [], dirtyMainFiles: await this.dirtyFiles(), conflicts: [], canIntegrate: true };
    }
    const [changedFiles, mainChangesSinceBase, dirtyMainFiles, mainPatch] = await Promise.all([
      this.filesChangedFrom(info.path, info.baseCommit),
      this.filesChangedFrom(this.cwd, info.baseCommit),
      this.dirtyFiles(),
      git(this.cwd, ["diff", "--unified=0", info.baseCommit, "--"]),
    ]);
    const mainChangesByIdentity = new Set(mainChangesSinceBase.map((file) => file.toLowerCase()));
    const overlap = changedFiles.filter((file) => mainChangesByIdentity.has(file.toLowerCase()));
    const agentDependencyChanges = changedFiles.filter(isDependencyFile);
    const mainDependencyChanges = mainChangesSinceBase.filter(isDependencyFile);
    const dependencyOverlap = agentDependencyChanges.length && mainDependencyChanges.length
      ? uniqueFiles([...agentDependencyChanges, ...mainDependencyChanges])
      : [];
    const ordinaryOverlap = overlap.filter((file) => !isDependencyFile(file));
    const conflicts: WorktreeMergeConflict[] = [];
    if (ordinaryOverlap.length) {
      conflicts.push({ kind: "file", files: ordinaryOverlap, detail: `Both the main workspace and Agent changed: ${ordinaryOverlap.join(", ")}` });
    }
    if (dependencyOverlap.length) {
      conflicts.push({ kind: "dependency", files: dependencyOverlap, detail: `Dependency manifests changed on both sides: ${dependencyOverlap.join(", ")}` });
    }
    const agentSymbols = changedSymbols(patch);
    const mainSymbols = changedSymbols(mainPatch);
    const symbolOverlap = overlap.length ? agentSymbols.filter((symbol) => mainSymbols.includes(symbol)) : [];
    if (symbolOverlap.length) {
      conflicts.push({ kind: "symbol", files: overlap, symbols: symbolOverlap, detail: `The same symbols changed on both sides: ${symbolOverlap.join(", ")}` });
    }
    const patchFile = await this.writePatch(info, patch);
    if (!conflicts.length) {
      try {
        await git(this.cwd, ["apply", "--check", "--binary", patchFile]);
      } catch (error) {
        conflicts.push({ kind: "git-apply", files: changedFiles, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return { patch, patchFile, changedFiles, mainChangesSinceBase, dirtyMainFiles, conflicts, canIntegrate: conflicts.length === 0 };
  }

  async integrate(info: WorktreeInfo): Promise<string> {
    const analysis = await this.analyze(info);
    if (analysis.patch === "No changes in this Agent Worktree.") return analysis.patch;
    if (!analysis.canIntegrate || !analysis.patchFile) {
      const details = analysis.conflicts.map((conflict) => `${conflict.kind}: ${conflict.detail}`).join("; ");
      throw new Error(`Agent patch was not applied because merge conflicts were detected: ${details}. The Worktree and patch were preserved.`);
    }
    try {
      await git(this.cwd, ["apply", "--check", "--binary", analysis.patchFile]);
      await git(this.cwd, ["apply", "--binary", analysis.patchFile]);
    } catch (error) {
      throw new Error(`Agent patch was not applied: ${error instanceof Error ? error.message : String(error)}. The Worktree was preserved at ${info.path}.`);
    }
    return `Applied Agent patch to the main workspace. Worktree preserved at ${info.path}. Run review and verification before completion.`;
  }
}
