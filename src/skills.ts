import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { addedPermissions, parseExtensionPermissions, PermissionGrantStore, type ExtensionPermission, type ExtensionPermissionManifest } from "./extension-permissions.js";
import type { AgentTool } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_SKILL_FILES = 300;
const MAX_INSTALL_BYTES = 20 * 1024 * 1024;

export interface XiuSkill {
  name: string;
  description: string;
  file: string;
  scope: "project" | "global" | "compatible";
  permissions: ExtensionPermission[];
  permissionWarnings: string[];
  permissionsDeclared: boolean;
}

export interface InstalledSkill {
  name: string;
  destination: string;
  backup?: string;
  permissions: ExtensionPermission[];
}

export type SkillPermissionConfirmation = (input: {
  manifest: ExtensionPermissionManifest;
  added: ExtensionPermission[];
  replacing: boolean;
}) => Promise<boolean>;

function frontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") throw new Error(`Invalid skill name: ${value}`);
  return normalized;
}

function skillPermissions(meta: Record<string, string>): { permissions: ExtensionPermission[]; unknown: string[]; declared: boolean } {
  const declared = Object.hasOwn(meta, "permissions");
  const parsed = parseExtensionPermissions(meta.permissions);
  return {
    permissions: parsed.permissions.length ? parsed.permissions : ["instructions:load"],
    unknown: parsed.unknown,
    declared,
  };
}

function skillManifest(name: string, destination: string, meta: Record<string, string>): ExtensionPermissionManifest {
  const parsed = skillPermissions(meta);
  return {
    kind: "skill",
    name,
    origin: path.resolve(destination),
    permissions: parsed.permissions,
    details: parsed.unknown.map((permission) => `unknown:${permission}`),
    declared: parsed.declared,
  };
}

async function copyTree(source: string, destination: string): Promise<void> {
  let totalBytes = 0;
  let fileCount = 0;
  async function copy(current: string, target: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    await fs.mkdir(target, { recursive: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const from = path.join(current, entry.name);
      const to = path.join(target, entry.name);
      const stat = await fs.lstat(from);
      if (stat.isSymbolicLink()) throw new Error(`Skill packages may not contain symbolic links: ${from}`);
      if (stat.isDirectory()) await copy(from, to);
      else if (stat.isFile()) {
        totalBytes += stat.size;
        fileCount++;
        if (totalBytes > MAX_INSTALL_BYTES || fileCount > 1000) throw new Error("Skill package exceeds the 20 MB or 1000-file safety limit");
        await fs.copyFile(from, to);
      }
    }
  }
  await copy(source, destination);
}

export class SkillRegistry {
  private skills: XiuSkill[] = [];

  constructor(
    private readonly cwd: string,
    private readonly globalRoot?: string,
    private readonly permissionStore = new PermissionGrantStore(globalRoot
      ? path.join(path.dirname(globalRoot), "extension-permissions.json")
      : path.join(os.homedir(), ".xiu", "extension-permissions.json")),
  ) {}

  globalDirectory(): string { return this.globalRoot ?? path.join(os.homedir(), ".xiu", "skills"); }

  async refresh(includeProject = true): Promise<XiuSkill[]> {
    const roots: Array<{ directory: string; scope: XiuSkill["scope"] }> = [
      ...(includeProject ? [
        { directory: path.join(this.cwd, ".xiu", "skills"), scope: "project" as const },
        { directory: path.join(this.cwd, ".agents", "skills"), scope: "compatible" as const },
        { directory: path.join(this.cwd, ".claude", "skills"), scope: "compatible" as const },
      ] : []),
      { directory: this.globalDirectory(), scope: "global" },
      { directory: path.join(os.homedir(), ".agents", "skills"), scope: "compatible" },
    ];
    const discovered: XiuSkill[] = [];
    for (const root of roots) {
      const files = await fg("**/SKILL.md", { cwd: root.directory, absolute: true, onlyFiles: true, unique: true }).catch(() => [] as string[]);
      for (const file of files.slice(0, MAX_SKILL_FILES)) {
        try {
          const content = await fs.readFile(file, "utf8");
          const meta = frontmatter(content);
          const permissionInfo = skillPermissions(meta);
          const folder = path.basename(path.dirname(file));
          discovered.push({
            name: meta.name || folder,
            description: meta.description || content.replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "") || "No description",
            file,
            scope: root.scope,
            permissions: permissionInfo.permissions,
            permissionWarnings: permissionInfo.unknown,
            permissionsDeclared: permissionInfo.declared,
          });
        } catch { /* ignore unreadable skills */ }
      }
    }
    const unique = new Map<string, XiuSkill>();
    for (const skill of discovered) if (!unique.has(skill.name.toLowerCase())) unique.set(skill.name.toLowerCase(), skill);
    this.skills = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.list();
  }

  list(): XiuSkill[] { return this.skills.map((skill) => ({ ...skill })); }

  catalog(): string {
    if (!this.skills.length) return "No Xiu skills are installed.";
    return [
      "Available Xiu skills (call read_skill before following a relevant skill):",
      ...this.skills.map((skill) => `- ${skill.name} [${skill.scope}] [permissions: ${skill.permissions.join(", ")}${skill.permissionWarnings.length ? `; unknown: ${skill.permissionWarnings.join(", ")}` : ""}]: ${skill.description}`),
    ].join("\n");
  }

  async read(name: string): Promise<string> {
    const normalized = name.trim().toLowerCase();
    const matches = this.skills.filter((skill) => skill.name.toLowerCase() === normalized || skill.name.toLowerCase().startsWith(normalized));
    if (!matches.length) throw new Error(`Skill not found: ${name}`);
    if (matches.length > 1) throw new Error(`Skill name is ambiguous: ${name}`);
    const skill = matches[0]!;
    const content = await fs.readFile(skill.file, "utf8");
    if (content.length > 120_000) throw new Error(`Skill is too large to load safely: ${skill.name}`);
    return `Skill: ${skill.name}\nScope: ${skill.scope}\nPermissions: ${skill.permissions.join(", ")}\n${skill.permissionWarnings.length ? `Unknown permission declarations: ${skill.permissionWarnings.join(", ")}\n` : ""}Source: ${skill.file}\n\n${content}`;
  }

  async install(source: string, overwrite = false, confirmPermissions?: SkillPermissionConfirmation): Promise<InstalledSkill[]> {
    const trimmed = source.trim().replace(/^['"]|['"]$/g, "");
    if (!trimmed) throw new Error("Skill source cannot be empty");
    let packageRoot = path.resolve(trimmed);
    let temporary: string | undefined;
    if (/^https:\/\//i.test(trimmed)) {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-"));
      await execFileAsync("git", ["clone", "--depth", "1", "--", trimmed, temporary], { timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      packageRoot = temporary;
    } else if (/^[a-z]+:\/\//i.test(trimmed)) {
      throw new Error("Remote skill sources must use HTTPS Git URLs");
    }

    try {
      const stat = await fs.stat(packageRoot).catch(() => undefined);
      if (!stat) throw new Error(`Skill source does not exist: ${trimmed}`);
      if (stat.isFile()) {
        if (path.basename(packageRoot).toLowerCase() !== "skill.md") throw new Error("A skill file must be named SKILL.md");
        packageRoot = path.dirname(packageRoot);
      }
      const skillFiles = await fg("**/SKILL.md", { cwd: packageRoot, absolute: true, onlyFiles: true, unique: true, ignore: ["**/.git/**"] });
      if (!skillFiles.length) throw new Error("No SKILL.md was found in the source");
      const installed: InstalledSkill[] = [];
      for (const skillFile of skillFiles.slice(0, 100)) {
        const content = await fs.readFile(skillFile, "utf8");
        const meta = frontmatter(content);
        const name = safeName(meta.name || path.basename(path.dirname(skillFile)));
        const sourceDirectory = path.dirname(skillFile);
        const destination = path.join(this.globalDirectory(), name);
        let backup: string | undefined;
        const exists = await fs.stat(destination).then(() => true, () => false);
        if (exists && !overwrite) throw new Error(`Skill already exists: ${name}`);
        const manifest = skillManifest(name, destination, meta);
        const unknown = (manifest.details ?? []).filter((item) => item.startsWith("unknown:"));
        if (unknown.length) throw new Error(`Skill ${name} declares unknown permissions: ${unknown.map((item) => item.slice(8)).join(", ")}`);
        let previous: ExtensionPermissionManifest | undefined;
        if (exists) {
          const previousContent = await fs.readFile(path.join(destination, "SKILL.md"), "utf8");
          previous = skillManifest(name, destination, frontmatter(previousContent));
          if (!await this.permissionStore.approvedManifest(previous)) await this.permissionStore.approve(previous);
        }
        const approved = await this.permissionStore.isApproved(manifest);
        const added = addedPermissions(previous ?? await this.permissionStore.approvedManifest(manifest), manifest);
        const requiresConfirmation = !approved && added.some((permission) => permission !== "instructions:load");
        if (requiresConfirmation && (!confirmPermissions || !await confirmPermissions({ manifest, added, replacing: exists }))) {
          throw new Error(`Skill permission acknowledgement was declined: ${name}`);
        }
        if (exists) {
          backup = `${destination}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          await fs.rename(destination, backup);
        }
        try { await copyTree(sourceDirectory, destination); }
        catch (error) {
          await fs.rm(destination, { recursive: true, force: true });
          if (backup) await fs.rename(backup, destination);
          throw error;
        }
        await this.permissionStore.approve(manifest);
        installed.push({ name, destination, backup, permissions: manifest.permissions });
      }
      await this.refresh();
      return installed;
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

export function createSkillTools(registry: SkillRegistry): AgentTool[] {
  return [{
    name: "read_skill",
    description: "Load the complete instructions for one installed Xiu skill. Use when the skill catalog says a skill matches the current task.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    describe: (input) => `load skill ${String(input.name)}`,
    async execute(input) {
      if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name must be a non-empty string");
      return await registry.read(input.name);
    },
  }];
}
