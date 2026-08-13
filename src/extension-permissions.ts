import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EXTENSION_PERMISSIONS = [
  "instructions:load",
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
  "external:read",
  "external:write",
  "credentials:access",
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

export class PermissionGrantStore {
  constructor(private readonly file = path.join(os.homedir(), ".xiu", "extension-permissions.json")) {}

  private async read(): Promise<PermissionGrantFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as PermissionGrantFile;
      if (parsed?.version !== 1 || !parsed.grants || typeof parsed.grants !== "object" || Array.isArray(parsed.grants)) throw new Error("invalid permission grant store");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, grants: {} };
      throw error;
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
