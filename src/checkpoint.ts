import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWorkspacePath } from "./workspace-path.js";

const execFileAsync = promisify(execFile);

export interface CheckpointFile {
  path: string;
  existed: boolean;
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  tool: string;
  description: string;
  files: CheckpointFile[];
}

function targetPaths(tool: string, input: Record<string, unknown>): string[] {
  if (["write_file", "replace_text", "apply_patch"].includes(tool) && typeof input.path === "string") return [input.path];
  if (["generate_image", "generate_video"].includes(tool) && typeof input.output_path === "string") return [input.output_path];
  return [];
}

export class CheckpointManager {
  private sessionId?: string;
  private touched = new Set<string>();

  constructor(private readonly cwd: string, sessionId?: string) {
    this.sessionId = sessionId;
  }

  setSession(sessionId: string): void {
    if (this.sessionId !== sessionId) this.touched.clear();
    this.sessionId = sessionId;
  }

  clearSession(): void {
    this.sessionId = undefined;
    this.touched.clear();
  }

  private root(): string {
    if (!this.sessionId) throw new Error("Session has not started yet.");
    return path.join(this.cwd, ".xiu", "checkpoints", this.sessionId);
  }

  async capture(tool: string, input: Record<string, unknown>, description: string): Promise<Checkpoint | undefined> {
    const paths = targetPaths(tool, input);
    if (!paths.length || !this.sessionId) return undefined;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
    const directory = path.join(this.root(), id);
    const files: CheckpointFile[] = [];
    for (const relative of paths) {
      const target = resolveWorkspacePath(this.cwd, relative);
      const normalized = path.relative(this.cwd, target).replace(/\\/g, "/");
      this.touched.add(normalized);
      let existed = false;
      try {
        const stat = await fs.stat(target);
        if (stat.isFile()) {
          existed = true;
          const backup = path.join(directory, "files", normalized);
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.copyFile(target, backup);
        }
      } catch { /* file did not exist before the operation */ }
      files.push({ path: normalized, existed });
    }
    const checkpoint: Checkpoint = { id, createdAt: new Date().toISOString(), tool, description, files };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(checkpoint, null, 2), "utf8");
    return checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    if (!this.sessionId) return [];
    const root = this.root();
    const directories = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const checkpoints: Checkpoint[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      try { checkpoints.push(JSON.parse(await fs.readFile(path.join(root, entry.name, "manifest.json"), "utf8")) as Checkpoint); }
      catch { /* ignore incomplete checkpoint */ }
    }
    return checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restore(id: string): Promise<Checkpoint> {
    const checkpoint = (await this.list()).find((item) => item.id === id || item.id.startsWith(id));
    if (!checkpoint) throw new Error(`Checkpoint not found: ${id}`);
    const directory = path.join(this.root(), checkpoint.id);
    for (const file of checkpoint.files) {
      const target = resolveWorkspacePath(this.cwd, file.path);
      if (file.existed) {
        const backup = path.join(directory, "files", file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(backup, target);
      } else {
        await fs.rm(target, { force: true });
      }
      this.touched.add(file.path);
    }
    return checkpoint;
  }

  async diff(): Promise<string> {
    let gitDiff = "";
    try {
      const result = await execFileAsync("git", ["diff", "--", "."], { cwd: this.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
      gitDiff = result.stdout.trim();
    } catch { /* non-Git project */ }
    const checkpoints = await this.list();
    for (const checkpoint of checkpoints) for (const file of checkpoint.files) this.touched.add(file.path);
    const summary = this.touched.size ? `Session-touched files:\n${[...this.touched].sort().map((file) => `- ${file}`).join("\n")}` : "No file changes have been checkpointed in this session.";
    return gitDiff ? `${summary}\n\nGit diff:\n${gitDiff}` : summary;
  }
}
