import { permissionFingerprint, type ExtensionPermission } from "../extension-permissions.js";
import { McpAuthStore, type McpAuthSecretRecord } from "../mcp-auth-store.js";
import { McpManager, type McpServerStatus, type McpOAuthConfig, type McpServerConfig } from "../mcp.js";
import type { CredentialStore } from "../credential-store.js";
import { randomUUID } from "node:crypto";
import type { ToolRisk } from "../types.js";

export interface WorkspaceMcpDraft {
  name: string;
  fingerprint?: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  bearerTokenEnvironment?: string;
  oauth?: McpOAuthConfig;
  risk: ToolRisk;
  enabled?: boolean;
}
export interface WorkspaceMcpOAuthFlow {
  id: string; name: string;
  state: "starting" | "confirmation" | "waiting" | "completed" | "cancelled" | "failed";
  issuer?: string; resource?: string; scopes?: string[]; callback?: string;
  authorizationUrl?: string; browserOpened?: boolean;
}

/** Shared composition: neither frontend installs presets or copies OAuth secrets. */
export function createMcpManager(workspace: string, credentials?: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">): McpManager {
  return new McpManager(workspace, undefined, new McpAuthStore(undefined, credentials));
}

export interface WorkspaceMcpSnapshot {
  oauthFlow?: WorkspaceMcpOAuthFlow;
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
    editable?: WorkspaceMcpDraft;
    removable?: boolean;
    oauth?: boolean;
    diagnostic?: string;
  }>;
}

/** Desktop view exposes only a validated basic editor projection, never raw config, tokens or errors. */
export class WorkspaceMcpService {
  private pending: Promise<void> = Promise.resolve();
  private flow?: WorkspaceMcpOAuthFlow;
  private loginAbort?: AbortController;
  private confirmLogin?: (allowed: boolean) => void;
  get busy(): boolean { return Boolean(this.loginAbort); }
  constructor(readonly manager: McpManager, private readonly toolsChanged: () => void, private readonly openBrowser?: (url: URL) => Promise<void>) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async snapshot(): Promise<WorkspaceMcpSnapshot> {
    const statuses = this.manager.status();
    const manifests = await this.manager.permissionManifests(true);
    const entries = await this.manager.configurationEntries(true);
    let flow = this.flow ? structuredClone(this.flow) : undefined;
    if (flow) {
      try {
        const clean = await this.manager.serverTextSanitizer(flow.name);
        flow = { ...flow, scopes: flow.scopes?.map(clean), ...(flow.authorizationUrl && clean(flow.authorizationUrl) !== flow.authorizationUrl ? { authorizationUrl: undefined } : {}) };
      } catch {
        // Keep cancellation reachable when a credential backend cannot supply the redaction vocabulary.
        flow = { id: flow.id, name: flow.name, state: flow.state };
      }
    }
    return { ...(flow ? { oauthFlow: flow } : {}), servers: await Promise.all(entries.map(async (entry) => {
      const manifest = manifests.find((item) => item.name === entry.name) ?? { ...entry.manifest, approved: false, added: [] };
      const status = statuses.find((item) => item.name === manifest.name);
      const editable = entry.origin === "user" ? await this.editor(entry.name, entry.config, permissionFingerprint(manifest)) : undefined;
      return {
        name: manifest.name, origin: manifest.origin,
        transport: manifest.details?.includes("transport:streamable-http") ? "streamable-http" : "stdio",
        // An on-disk edit revokes the displayed grant even before reconnecting.
        state: !manifest.approved ? "permission-required" : status?.state === "permission-required" ? "disconnected" : status?.state ?? "disconnected",
        tools: manifest.approved ? status?.tools ?? 0 : 0,
        approved: manifest.approved, permissions: [...manifest.permissions], added: [...manifest.added],
        fingerprint: permissionFingerprint(manifest),
        ...(status?.state === "failed" ? { diagnostic: /XIU_NODE_NOT_FOUND|ENOENT|not recognized|not found|无法|找不到/i.test(status.error ?? "") ? "找不到启动程序。请安装 Node.js 并检查用户 PATH，关闭并重新打开 Xiu 后重连。" : "服务启动或协议握手失败。请检查该服务的启动命令、工作目录和运行环境；不会自动安装或修改配置。" } : {}),
        ...(editable ? { editable } : {}), removable: entry.origin === "user", oauth: Boolean(entry.config.auth),
      };
    })) };
  }

  private async editor(name: string, config: McpServerConfig, fingerprint: string): Promise<WorkspaceMcpDraft | undefined> {
    // Explicit/custom permission declarations must not be silently discarded by the basic editor.
    if (config.permissions !== undefined) return undefined;
    if (Object.keys(config).some((key) => !["transport", "command", "args", "url", "headers", "auth", "risk", "permissions", "enabled"].includes(key))) return undefined;
    const headers = Object.entries(config.headers ?? {});
    const bearer = headers.length === 1 && headers[0]![0].toLowerCase() === "authorization" ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(headers[0]![1])?.[1] : undefined;
    if (headers.length && !bearer) return undefined;
    const draft: WorkspaceMcpDraft = { name, fingerprint, transport: config.url ? "streamable-http" : "stdio", risk: config.risk ?? "execute", enabled: config.enabled !== false,
      ...(config.url ? { url: config.url } : { command: config.command, args: config.args ?? [] }),
      ...(bearer ? { bearerTokenEnvironment: bearer } : {}), ...(config.auth ? { oauth: structuredClone(config.auth) } : {}),
    };
    try { await this.validateDraft(draft); return draft; } catch { return undefined; }
  }

  private async validateDraft(draft: WorkspaceMcpDraft): Promise<McpServerConfig> {
    if (!draft || !/^[A-Za-z0-9_-]{1,64}$/.test(draft.name) || !["stdio", "streamable-http"].includes(draft.transport)
      || !["read", "write", "execute", "dangerous"].includes(draft.risk) || JSON.stringify(draft).length > 32_000) throw new Error("Invalid MCP editor fields.");
    if (draft.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(draft.fingerprint)) throw new Error("Invalid MCP configuration revision.");
    if (draft.args && (!Array.isArray(draft.args) || draft.args.length > 64 || draft.args.some((arg) => typeof arg !== "string" || arg.length > 4096))) throw new Error("MCP arguments exceed limits.");
    if (draft.bearerTokenEnvironment && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.bearerTokenEnvironment)) throw new Error("Use an environment variable name, never a token.");
    if (draft.url) {
      const url = new URL(draft.url);
      if (url.username || url.password || [...url.searchParams.keys()].some((key) => /key|token|secret|password|authorization/i.test(key))) throw new Error("Credentials must not be embedded in URLs.");
    }
    for (let i = 0; i < (draft.args?.length ?? 0); i++) {
      const arg = draft.args![i]!;
      if (/^--?(?:.*(?:key|token|secret|password))/i.test(arg) && !/^--?[\w-]+(?:=\$\{[A-Za-z_][A-Za-z0-9_]*\}|$)/.test(arg)) throw new Error("Use environment references for credentials.");
      if (/^--?[\w-]*(?:key|token|secret|password)[\w-]*$/i.test(arg) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(draft.args![i + 1] ?? "")) throw new Error("Use environment references for credentials.");
    }
    const sanitize = await this.manager.serverTextSanitizer(draft.name);
    for (const value of [draft.url, draft.command, ...(draft.args ?? []), ...(draft.oauth?.scopes ?? []), draft.oauth?.clientId, draft.oauth?.clientMetadataUrl]) {
      if (value && (typeof value !== "string" || sanitize(value) !== value)) throw new Error("Secret-bearing configuration cannot be edited here.");
    }
    const config: McpServerConfig = { transport: draft.transport, risk: draft.risk, enabled: draft.enabled !== false,
      ...(draft.transport === "stdio" ? { command: draft.command, args: draft.args ?? [] } : { url: draft.url,
        ...(draft.oauth ? { auth: draft.oauth } : {}), ...(draft.bearerTokenEnvironment ? { headers: { Authorization: `Bearer \${${draft.bearerTokenEnvironment}}` } } : {}),
      }),
    };
    if (draft.transport === "stdio" && (!draft.command?.trim() || draft.url || draft.oauth || draft.bearerTokenEnvironment)) throw new Error("Invalid stdio configuration.");
    if (draft.transport === "streamable-http" && (!draft.url || draft.command || draft.args?.length || draft.oauth && draft.bearerTokenEnvironment)) throw new Error("Invalid HTTP configuration.");
    return config;
  }

  async save(draft: WorkspaceMcpDraft): Promise<WorkspaceMcpSnapshot> {
    return this.serialize(async () => {
      const config = await this.validateDraft(draft);
      if (draft.fingerprint && !(await this.snapshot()).servers.find((server) => server.name === draft.name)?.editable) throw new Error("Advanced or project configuration is read-only here.");
      await this.manager.saveUserServer(draft.name, config, draft.fingerprint);
      await this.manager.close(); this.toolsChanged();
      return this.snapshot();
    });
  }

  async remove(name: string, fingerprint: string, confirmed: boolean): Promise<WorkspaceMcpSnapshot> {
    return this.serialize(async () => {
      if (!confirmed || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("MCP deletion requires exact confirmation.");
      await this.manager.deleteUserServer(name, fingerprint);
      await this.manager.close(); this.toolsChanged();
      return this.snapshot();
    });
  }

  async startLogin(name: string, fingerprint: string): Promise<WorkspaceMcpSnapshot> {
    if (this.busy) throw new Error("OAuth login is already active.");
    const server = (await this.snapshot()).servers.find((item) => item.name === name);
    if (this.busy) throw new Error("OAuth login is already active.");
    if (!server?.approved || !server.oauth || server.fingerprint !== fingerprint) throw new Error("Confirm the current OAuth permission manifest first.");
    const abort = new AbortController();
    this.loginAbort = abort;
    this.flow = { id: randomUUID(), name, state: "starting" };
    const id = this.flow.id;
    void this.serialize(async () => {
      try {
        await this.manager.close(); this.toolsChanged();
        await this.manager.login(name, {
          signal: abort.signal, timeoutMs: 5 * 60_000, openBrowser: this.openBrowser,
          confirmAuthorizationServer: async (issuer, resource, details) => {
            if (abort.signal.aborted) return false;
            this.flow = { id, name, state: "confirmation", issuer: issuer.origin, resource: resource.origin, scopes: details.scopes, callback: details.callback.origin };
            return new Promise<boolean>((resolve) => { this.confirmLogin = resolve; });
          },
          authorizationUrlReady: async (url, opened) => {
            this.flow = { ...this.flow!, state: "waiting", authorizationUrl: url.toString(), browserOpened: opened };
          },
        }, true, fingerprint);
        this.flow = { id, name, state: "completed" };
      } catch { this.flow = { id, name, state: abort.signal.aborted ? "cancelled" : "failed" }; }
      finally { this.loginAbort = undefined; this.confirmLogin = undefined; }
    });
    return this.snapshot();
  }

  decideLogin(id: string, allowed: boolean): void {
    if (this.flow?.id !== id || this.flow.state !== "confirmation" || !this.confirmLogin || typeof allowed !== "boolean") throw new Error("OAuth confirmation expired.");
    const resolve = this.confirmLogin; this.confirmLogin = undefined;
    if (!allowed) this.loginAbort?.abort();
    this.flow.state = "starting"; resolve(allowed);
  }

  cancelLogin(id?: string): void {
    if (id && this.flow?.id !== id) throw new Error("OAuth login identity changed.");
    this.loginAbort?.abort(); this.confirmLogin?.(false); this.confirmLogin = undefined;
  }

  async logout(name: string, fingerprint: string, confirmed: boolean): Promise<WorkspaceMcpSnapshot> {
    return this.serialize(async () => {
      const server = (await this.snapshot()).servers.find((item) => item.name === name);
      if (!confirmed || !server?.oauth || server.fingerprint !== fingerprint) throw new Error("OAuth logout requires current configuration confirmation.");
      await this.manager.logout(name, false, true); this.toolsChanged();
      return this.snapshot();
    });
  }

  async browse(name: string, action: "resources" | "read" | "prompts" | "prompt", value?: string, args?: Record<string, string>): Promise<unknown> {
    return this.serialize(async () => {
      if (!["resources", "read", "prompts", "prompt"].includes(action) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid MCP content request.");
      const server = (await this.snapshot()).servers.find((item) => item.name === name);
      if (!server?.approved || server.state !== "connected") throw new Error("Connect an approved MCP server first.");
      const signal = AbortSignal.timeout(15_000);
      const result = action === "resources" ? await this.manager.listResources(name, signal)
        : action === "read" ? await this.manager.readResource(name, value!, signal)
        : action === "prompts" ? await this.manager.listPrompts(name, signal) : await this.manager.getPrompt(name, value!, args ?? {}, signal);
      const sanitize = await this.manager.serverTextSanitizer(name);
      const clean = async (value: unknown): Promise<unknown> => {
        if (typeof value === "string") return sanitize(value);
        if (Array.isArray(value)) return Promise.all(value.map(clean));
        if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await clean(item)])));
        return value;
      };
      return clean(result);
    });
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
    this.cancelLogin();
    return this.serialize(async () => {
      // Includes in-flight connection setup; shutdown cannot orphan a stdio child.
      await this.manager.close();
      this.toolsChanged();
    });
  }
}
