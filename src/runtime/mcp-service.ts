import { permissionFingerprint, type ExtensionPermission } from "../extension-permissions.js";
import { McpAuthStore, type McpAuthSecretRecord } from "../mcp-auth-store.js";
import { McpManager, type McpServerStatus } from "../mcp.js";
import type { CredentialStore } from "../credential-store.js";

/** Shared composition: neither frontend installs presets or copies OAuth secrets. */
export function createMcpManager(workspace: string, credentials?: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">): McpManager {
  return new McpManager(workspace, undefined, new McpAuthStore(undefined, credentials));
}

export interface WorkspaceMcpSnapshot {
  servers: Array<{
    name: string;
    origin: string;
    transport: McpServerStatus["transport"];
    state: McpServerStatus["state"] | "disconnected";
    tools: number;
    approved: boolean;
    permissions: ExtensionPermission[];
    added: ExtensionPermission[];
    fingerprint: string;
  }>;
}

/** Desktop-facing view never includes configuration, headers, tokens or raw errors. */
export class WorkspaceMcpService {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly manager: McpManager, private readonly toolsChanged: () => void) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async snapshot(): Promise<WorkspaceMcpSnapshot> {
    const statuses = this.manager.status();
    const manifests = await this.manager.permissionManifests(true);
    return { servers: manifests.map((manifest) => {
      const status = statuses.find((item) => item.name === manifest.name);
      return {
        name: manifest.name, origin: manifest.origin,
        transport: manifest.details?.includes("transport:streamable-http") ? "streamable-http" : "stdio",
        // An on-disk edit revokes the displayed grant even before reconnecting.
        state: !manifest.approved ? "permission-required" : status?.state === "permission-required" ? "disconnected" : status?.state ?? "disconnected",
        tools: manifest.approved ? status?.tools ?? 0 : 0,
        approved: manifest.approved, permissions: [...manifest.permissions], added: [...manifest.added],
        fingerprint: permissionFingerprint(manifest),
      };
    }) };
  }

  async reload(): Promise<WorkspaceMcpSnapshot> {
    return this.serialize(async () => {
      // Remove stale tools even if parsing or reconnection fails. No silent replay.
      await this.manager.close();
      this.toolsChanged();
      try { await this.manager.start(true); }
      finally { this.toolsChanged(); }
      return this.snapshot();
    });
  }

  async approve(name: string, fingerprint: string): Promise<WorkspaceMcpSnapshot> {
    return this.serialize(async () => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid MCP permission request.");
      await this.manager.approvePermissions(name, true, fingerprint);
      await this.manager.close(); // Never present an old live connection as the newly approved config.
      this.toolsChanged();
      // Grant recording is separate from connecting: user explicitly reloads next.
      return this.snapshot();
    });
  }

  async close(): Promise<void> {
    return this.serialize(async () => {
      // Includes in-flight connection setup; shutdown cannot orphan a stdio child.
      await this.manager.close();
      this.toolsChanged();
    });
  }
}
