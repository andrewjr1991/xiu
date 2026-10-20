import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigFileError } from "./config-file-error.js";

export const EXTENSION_PERMISSIONS = [
  "instructions:load",
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
  "external:read",
  "external:write",
  "credentials:access",
  "model:sampling",
] as const;

export type ExtensionPermission = typeof EXTENSION_PERMISSIONS[number];

const KNOWN = new Set<string>(EXTENSION_PERMISSIONS);

export interface ExtensionPermissionManifest {
  kind: "mcp" | "skill" | "plugin";
  name: string;
  origin: string;
  permissions: ExtensionPermission[];
  details?: string[];
  declared: boolean;
}

interface PermissionGrantRecord {
  fingerprint: string;
  permissions: ExtensionPermission[];
  approvedAt: string;
}

interface PermissionGrantFile {
  version: 1;
  grants: Record<string, PermissionGrantRecord>;
}

export function parseExtensionPermissions(value: unknown): { permissions: ExtensionPermission[]; unknown: string[] } {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const normalized = [...new Set(raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  return {
    permissions: normalized.filter((item): item is ExtensionPermission => KNOWN.has(item)).sort(),
    unknown: normalized.filter((item) => !KNOWN.has(item)).sort(),
  };
}

export function permissionFingerprint(manifest: ExtensionPermissionManifest): string {
  return createHash("sha256").update(JSON.stringify({
    kind: manifest.kind,
    name: manifest.name,
    origin: manifest.origin,
    permissions: [...manifest.permissions].sort(),
    details: [...(manifest.details ?? [])].sort(),
  })).digest("hex");
}

function grantKey(manifest: ExtensionPermissionManifest): string {
  return createHash("sha256").update(`${manifest.kind}\0${manifest.name}\0${manifest.origin}`).digest("hex");
}

export function addedPermissions(previous: ExtensionPermissionManifest | undefined, next: ExtensionPermissionManifest): ExtensionPermission[] {
  const before = new Set(previous?.permissions ?? []);
  return next.permissions.filter((permission) => !before.has(permission));
}

/** What `PermissionGrantStore.inspect()` found; `unreadable` means every Skill and plugin counts as unapproved until the file is fixed. */
export interface PermissionGrantStoreInspection {
  file: string;
  state: "read" | "absent" | "unreadable";
  /** Number of recorded grants when the file was read. */
  grants?: number;
  /** The system error code or the parser's message when `state` is `unreadable`. */
  cause?: string;
}

export class PermissionGrantStore {
  constructor(private readonly file = path.join(os.homedir(), ".xiu", "extension-permissions.json")) {}

  private async read(): Promise<PermissionGrantFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as PermissionGrantFile;
      if (parsed?.version !== 1 || !parsed.grants || typeof parsed.grants !== "object" || Array.isArray(parsed.grants)) throw new Error("invalid permission grant store");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, grants: {} };
      // Fail closed: nothing is approved while the record cannot be read. The message names the file so the user can fix it;
      // the system error code is kept for callers that classify the failure.
      const code = (error as NodeJS.ErrnoException).code;
      throw new ConfigFileError("extension-permissions", this.file, `Unable to read the extension permission store at ${this.file}: ${error instanceof Error ? error.message : String(error)}`, { code, cause: error });
    }
  }

  /** Reads the grant store without throwing, for diagnostics; the approval checks above still fail closed. */
  async inspect(): Promise<PermissionGrantStoreInspection> {
    const exists = await fs.lstat(this.file).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
    if (!exists) return { file: this.file, state: "absent" };
    try {
      const parsed = await this.read();
      return { file: this.file, state: "read", grants: Object.keys(parsed.grants).length };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof Error ? error.message : String(error);
      return { file: this.file, state: "unreadable", cause: typeof code === "string" && code ? code : message.replace(/^Unable to read the extension permission store at .*?: /, "") };
    }
  }

  async approvedManifest(manifest: ExtensionPermissionManifest): Promise<ExtensionPermissionManifest | undefined> {
    const record = (await this.read()).grants[grantKey(manifest)];
    if (!record) return undefined;
    return { ...manifest, permissions: [...record.permissions], declared: true };
  }

  async isApproved(manifest: ExtensionPermissionManifest): Promise<boolean> {
    const record = (await this.read()).grants[grantKey(manifest)];
    return record?.fingerprint === permissionFingerprint(manifest);
  }

  async approve(manifest: ExtensionPermissionManifest): Promise<void> {
    const data = await this.read();
    data.grants[grantKey(manifest)] = {
      fingerprint: permissionFingerprint(manifest),
      permissions: [...manifest.permissions].sort(),
      approvedAt: new Date().toISOString(),
    };
    await this.write(data);
  }

  /**
   * Removes whatever grant is recorded for this extension (kind, name and origin), whether or not
   * it still matches the current fingerprint. Returns false when nothing was recorded.
   */
  async revoke(manifest: ExtensionPermissionManifest): Promise<boolean> {
    const data = await this.read();
    const key = grantKey(manifest);
    if (!data.grants[key]) return false;
    delete data.grants[key];
    await this.write(data);
    return true;
  }

  private async write(data: PermissionGrantFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { await fs.rename(temporary, this.file); }
    catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
