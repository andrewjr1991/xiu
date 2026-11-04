import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function normalizedSkillName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!name || name.length > 160 || /[\x00-\x1f]/.test(name)) throw new Error("Invalid skill selection.");
  return name;
}

/** User-owned preferences, partitioned by workspace. They are never permission grants. */
export class SkillStateStore {
  readonly directory: string;
  private readonly root: string;
  constructor(private readonly userDirectory: string, cwd: string) {
    this.root = path.join(userDirectory, "skill-state");
    const workspace = path.resolve(cwd);
    this.directory = path.join(this.root, digest(process.platform === "win32" ? workspace.toLowerCase() : workspace));
  }

  private privateObject(stat: Stats, directory: boolean): void {
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
      || (!directory && stat.nlink !== 1)
      || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Skill preferences are not private regular objects.");
    }
  }

  private async directories(create: boolean): Promise<boolean> {
    // Do not follow a substituted application directory into another tree.
    const parent = await fs.lstat(this.userDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error("Unsafe skill preference directory.");
    if (!parent && !create) return false;
    if (!parent) await fs.mkdir(this.userDirectory, { recursive: true, mode: 0o700 });
    for (const directory of [this.root, this.directory]) {
      if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return false;
      this.privateObject(stat, true);
    }
    return true;
  }

  async disabled(): Promise<Set<string>> {
    if (!(await this.directories(false))) return new Set();
    const files = (await fs.readdir(this.directory)).filter((name) => !/^\.[a-f0-9-]+\.tmp$/.test(name));
    if (files.length > 2048) throw new Error("Skill preference entry limit exceeded.");
    const disabled = new Set<string>();
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Invalid skill preference entry.");
      const file = path.join(this.directory, name);
      const before = await fs.lstat(file);
      this.privateObject(before, false);
      if (before.size > 4096) throw new Error("Skill preference entry is too large.");
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        this.privateObject(opened, false);
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("Skill preferences changed; retry.");
        const bytes = Buffer.alloc(4097);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await handle.stat();
        if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Skill preferences changed; retry.");
        let entry: Record<string, unknown> | null;
        try { entry = JSON.parse(bytes.subarray(0, length).toString("utf8")) as Record<string, unknown> | null; }
        catch { throw new Error("Invalid skill preference JSON."); }
        if (!entry || entry.version !== 1 || entry.disabled !== true || typeof entry.name !== "string"
          || normalizedSkillName(entry.name) !== entry.name || `${digest(entry.name)}.json` !== name) throw new Error("Invalid skill preference entry.");
        disabled.add(entry.name);
      } finally { await handle.close(); }
    }
    return disabled;
  }

  async inspect(): Promise<{ state: "absent" | "read" | "unreadable"; count?: number; cause?: string }> {
    try {
      if (!(await this.directories(false))) return { state: "absent" };
      return { state: "read", count: (await this.disabled()).size };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { state: "unreadable", cause: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "invalid-or-unsafe" };
    }
  }

  async setDisabled(name: string, disabled: boolean): Promise<void> {
    name = normalizedSkillName(name);
    const current = await this.disabled(); // Corrupt preferences cannot silently re-enable skills.
    if (disabled && !current.has(name) && current.size >= 2048) throw new Error("Skill preference entry limit exceeded.");
    await this.directories(true);
    const file = path.join(this.directory, `${digest(name)}.json`);
    if (!disabled) {
      await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      return;
    }
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, name, disabled: true })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
