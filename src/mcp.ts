import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client, InsufficientScopeError, StreamableHTTPClientTransport, type AuthProvider } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import iconv from "iconv-lite";
import os from "node:os";
import path from "node:path";
import { localize, type UiLanguage } from "./i18n.js";
import { McpAuthStore, type McpAuthCredentialInfo, type McpAuthSecretRecord } from "./mcp-auth-store.js";
import type { CredentialBackendStatus, CredentialStore } from "./credential-store.js";
import { loginMcpOAuth, logoutMcpOAuth, sanitizeOAuthError, XiuMcpOAuthProvider, type McpOAuthInteraction, type McpOAuthStatus } from "./mcp-oauth.js";
import { createSafeOAuthFetch } from "./oauth-url-policy.js";
import { addedPermissions, parseExtensionPermissions, PermissionGrantStore, type ExtensionPermission, type ExtensionPermissionManifest } from "./extension-permissions.js";
import type { AgentTool, JsonSchema, ToolRisk } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
const MAX_OUTPUT = 60_000;
const MAX_MCP_PAGES = 20;
const MAX_MCP_ITEMS = 500;
const MAX_CONTENT_BLOCK = 32_000;
const MAX_CONTENT_TOTAL = 64_000;
const VALID_RISKS = new Set<ToolRisk>(["read", "write", "execute", "dangerous"]);

export interface McpServerConfig {
  transport?: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpOAuthConfig;
  enabled?: boolean;
  risk?: ToolRisk;
  toolRisks?: Record<string, ToolRisk>;
  changesWorkspace?: boolean;
  toolChangesWorkspace?: Record<string, boolean>;
  permissions?: ExtensionPermission[];
}

export interface McpOAuthConfig {
  type: "oauth";
  registration?: "auto" | "pre-registered";
  clientId?: string;
  clientMetadataUrl?: string;
  scopes?: string[];
  callbackPort?: number;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface McpResource {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  name: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments: McpPromptArgument[];
}

export interface McpResourceCatalog {
  server: string;
  resources: McpResource[];
  templates: McpResourceTemplate[];
  truncated: boolean;
}

export interface McpPromptCatalog {
  server: string;
  prompts: McpPrompt[];
  truncated: boolean;
}

export interface McpRenderedContent {
  server: string;
  label: string;
  text: string;
  truncated: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "streamable-http";
  state: "connected" | "permission-required" | "auth-required" | "authorizing" | "refreshing" | "scope-required" | "failed";
  tools: number;
  error?: string;
  permissionChanges?: ExtensionPermission[];
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n... [MCP output truncated]`;
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`MCP environment variable ${name} is not set`);
    return resolved;
  });
}

interface StdioLaunch {
  command: string;
  args: string[];
}

export async function resolveStdioLaunch(command: string, args: string[]): Promise<StdioLaunch> {
  if (process.platform !== "win32") return { command, args };
  const executable = path.basename(command).toLowerCase().replace(/\.(?:cmd|bat|exe|com)$/i, "");
  if (executable !== "npm" && executable !== "npx") return { command, args };
  const script = executable === "npm" ? "npm-cli.js" : "npx-cli.js";
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : []),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { command: process.execPath, args: [candidate, ...args] };
    } catch { /* try the next standard Node/npm layout */ }
  }
  return { command, args };
}

const RESERVED_HTTP_HEADERS = new Set(["accept", "content-type", "mcp-session-id", "mcp-protocol-version"]);

function transportOf(config: McpServerConfig): "stdio" | "streamable-http" {
  return config.url ? "streamable-http" : "stdio";
}

function validateRemoteUrl(value: string, name: string): string {
  if (value.length > 2_048) throw new Error(`MCP server ${name} URL is too long`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`MCP server ${name} has an invalid URL`); }
  if (url.protocol === "https:") return url.toString();
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "http:" || !local) throw new Error(`MCP server ${name} must use HTTPS; HTTP is allowed only for localhost`);
  return url.toString();
}

function validateServer(name: string, value: unknown): McpServerConfig {
  if (!value || typeof value !== "object") throw new Error(`MCP server ${name} must be an object`);
  const config = value as Record<string, unknown>;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`MCP server name ${name} must contain only letters, numbers, _ or -`);
  const hasCommand = typeof config.command === "string" && Boolean(config.command.trim());
  const hasUrl = typeof config.url === "string" && Boolean(config.url.trim());
  if (config.enabled !== false && hasCommand === hasUrl) throw new Error(`MCP server ${name} requires exactly one of command or url`);
  if (config.transport !== undefined && !["stdio", "streamable-http"].includes(String(config.transport))) throw new Error(`MCP server ${name} has an invalid transport`);
  if (hasCommand && config.transport === "streamable-http") throw new Error(`MCP server ${name} command conflicts with streamable-http transport`);
  if (hasUrl && config.transport === "stdio") throw new Error(`MCP server ${name} url conflicts with stdio transport`);
  if (hasUrl) config.url = validateRemoteUrl(String(config.url), name);
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((item) => typeof item !== "string"))) {
    throw new Error(`MCP server ${name} args must be an array of strings`);
  }
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env)
    || Object.values(config.env).some((item) => typeof item !== "string"))) {
    throw new Error(`MCP server ${name} env must contain string values`);
  }
  if (config.headers !== undefined && (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)
    || Object.entries(config.headers).length > 32 || Object.entries(config.headers).some(([key, item]) => typeof item !== "string" || key.length > 128 || item.length > 4_096))) {
    throw new Error(`MCP server ${name} headers must contain at most 32 bounded string values`);
  }
  if (config.headers && Object.keys(config.headers).some((key) => RESERVED_HTTP_HEADERS.has(key.toLowerCase()))) {
    throw new Error(`MCP server ${name} cannot override a reserved MCP header`);
  }
  if (hasCommand && config.headers !== undefined) throw new Error(`MCP server ${name} stdio transport does not accept headers`);
  if (hasUrl && (config.args !== undefined || config.cwd !== undefined || config.env !== undefined)) throw new Error(`MCP server ${name} streamable HTTP transport does not accept command process options`);
  if (config.auth !== undefined) {
    if (!config.auth || typeof config.auth !== "object" || Array.isArray(config.auth)) throw new Error(`MCP server ${name} OAuth configuration must be an object`);
    if (!hasUrl) throw new Error(`MCP server ${name} OAuth requires streamable HTTP transport`);
    const auth = config.auth as Record<string, unknown>;
    const allowedAuthFields = new Set(["type", "registration", "clientId", "clientMetadataUrl", "scopes", "callbackPort"]);
    const unknownAuthField = Object.keys(auth).find((field) => !allowedAuthFields.has(field));
    if (unknownAuthField) throw new Error(`MCP server ${name} has an unsupported OAuth field ${unknownAuthField}`);
    if (auth.type !== "oauth") throw new Error(`MCP server ${name} has an invalid OAuth type`);
    if (auth.registration !== undefined && !["auto", "pre-registered"].includes(String(auth.registration))) throw new Error(`MCP server ${name} has an invalid OAuth registration mode`);
    if (auth.clientId !== undefined && (typeof auth.clientId !== "string" || !auth.clientId || auth.clientId.length > 2_048)) throw new Error(`MCP server ${name} has an invalid OAuth client ID`);
    if (auth.registration === "pre-registered" && !auth.clientId) throw new Error(`MCP server ${name} pre-registered OAuth requires a client ID`);
    if (auth.clientMetadataUrl !== undefined) {
      if (typeof auth.clientMetadataUrl !== "string") throw new Error(`MCP server ${name} has an invalid OAuth client metadata URL`);
      const metadataUrl = validateRemoteUrl(auth.clientMetadataUrl, `${name} OAuth client metadata`);
      if (!metadataUrl.startsWith("https:")) throw new Error(`MCP server ${name} OAuth client metadata URL must use HTTPS`);
      auth.clientMetadataUrl = metadataUrl;
    }
    if (auth.scopes !== undefined && (!Array.isArray(auth.scopes) || auth.scopes.length > 64
      || auth.scopes.some((scope) => typeof scope !== "string" || !scope || scope.length > 256 || /\s/.test(scope))
      || new Set(auth.scopes).size !== auth.scopes.length)) {
      throw new Error(`MCP server ${name} OAuth scopes must be unique bounded strings without whitespace`);
    }
    if (auth.callbackPort !== undefined && (!Number.isInteger(auth.callbackPort) || Number(auth.callbackPort) < 1_024 || Number(auth.callbackPort) > 65_535)) {
      throw new Error(`MCP server ${name} has an invalid OAuth callback port`);
    }
    if (config.headers && Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) {
      throw new Error(`MCP server ${name} OAuth cannot be combined with an Authorization header`);
    }
  }
  if (config.risk !== undefined && !VALID_RISKS.has(config.risk as ToolRisk)) throw new Error(`MCP server ${name} has invalid risk`);
  if (config.toolRisks !== undefined && (!config.toolRisks || typeof config.toolRisks !== "object" || Array.isArray(config.toolRisks)
    || Object.values(config.toolRisks).some((item) => !VALID_RISKS.has(item as ToolRisk)))) {
    throw new Error(`MCP server ${name} toolRisks contains an invalid risk`);
  }
  if (config.changesWorkspace !== undefined && typeof config.changesWorkspace !== "boolean") throw new Error(`MCP server ${name} changesWorkspace must be boolean`);
  if (config.toolChangesWorkspace !== undefined && (!config.toolChangesWorkspace || typeof config.toolChangesWorkspace !== "object"
    || Array.isArray(config.toolChangesWorkspace) || Object.values(config.toolChangesWorkspace).some((item) => typeof item !== "boolean"))) {
    throw new Error(`MCP server ${name} toolChangesWorkspace must contain boolean values`);
  }
  if (config.permissions !== undefined) {
    if (!Array.isArray(config.permissions) || config.permissions.length > 32 || config.permissions.some((item) => typeof item !== "string")) {
      throw new Error(`MCP server ${name} permissions must be an array of known permission strings`);
    }
    const parsed = parseExtensionPermissions(config.permissions);
    if (parsed.unknown.length) throw new Error(`MCP server ${name} declares unknown permissions: ${parsed.unknown.join(", ")}`);
    config.permissions = parsed.permissions;
  }
  return config as unknown as McpServerConfig;
}

function inferredMcpPermissions(config: McpServerConfig): ExtensionPermission[] {
  const permissions = new Set<ExtensionPermission>();
  permissions.add(config.url ? "network:access" : "process:execute");
  const risks = [config.risk ?? "execute", ...Object.values(config.toolRisks ?? {})];
  for (const risk of risks) permissions.add(risk === "read" ? "external:read" : "external:write");
  if (config.changesWorkspace || Object.values(config.toolChangesWorkspace ?? {}).some(Boolean)) permissions.add("workspace:write");
  if (config.auth || Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization") || Object.keys(config.env ?? {}).length) permissions.add("credentials:access");
  return [...permissions].sort();
}

function stableConfiguration(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableConfiguration).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableConfiguration(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function mcpConfigurationFingerprint(config: McpServerConfig): string {
  return createHash("sha256").update(stableConfiguration({ ...config, enabled: undefined })).digest("hex");
}

function mcpManifest(name: string, origin: string, config: McpServerConfig): ExtensionPermissionManifest {
  const inferred = inferredMcpPermissions(config);
  const declared = config.permissions !== undefined;
  if (declared) {
    const missing = inferred.filter((permission) => !config.permissions!.includes(permission));
    if (missing.length) throw new Error(`MCP server ${name} permission declaration omits required permissions: ${missing.join(", ")}`);
  }
  return {
    kind: "mcp",
    name,
    origin,
    permissions: declared ? [...config.permissions!] : inferred,
    declared,
    details: [
      `configuration:${mcpConfigurationFingerprint(config)}`,
      `transport:${transportOf(config)}`,
      `risk:${config.risk ?? "execute"}`,
      ...Object.entries(config.toolRisks ?? {}).map(([tool, risk]) => `tool-risk:${tool}:${risk}`),
      ...((config.auth?.scopes ?? []).map((scope) => `oauth-scope:${scope}`)),
      ...(config.changesWorkspace ? ["workspace-changes:all"] : []),
      ...Object.entries(config.toolChangesWorkspace ?? {}).filter(([, changes]) => changes).map(([tool]) => `workspace-changes:${tool}`),
    ],
  };
}

async function readConfig(file: string): Promise<Record<string, McpServerConfig>> {
  let content: string;
  try { content = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: McpConfigFile;
  try { parsed = JSON.parse(content) as McpConfigFile; }
  catch (error) { throw new Error(`Invalid MCP JSON in ${file}: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)))) {
    throw new Error(`MCP config ${file} must contain an mcpServers object`);
  }
  return Object.fromEntries(Object.entries(parsed.mcpServers ?? {}).map(([name, value]) => [name, validateServer(name, value)]));
}

interface McpConnectionLike {
  start(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  listResources(signal?: AbortSignal): Promise<{ resources: McpResource[]; templates: McpResourceTemplate[]; truncated: boolean }>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpRenderedContent>;
  listPrompts(signal?: AbortSignal): Promise<{ prompts: McpPrompt[]; truncated: boolean }>;
  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpRenderedContent>;
  close(): Promise<void>;
}

function boundedText(value: string, remaining: number): { text: string; used: number; truncated: boolean } {
  const limit = Math.max(0, Math.min(MAX_CONTENT_BLOCK, remaining));
  if (value.length <= limit) return { text: value, used: value.length, truncated: false };
  return { text: `${value.slice(0, limit)}\n... [MCP content truncated]`, used: limit, truncated: true };
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function renderContentBlocks(blocks: unknown[], fallback: string): { text: string; truncated: boolean } {
  const output: string[] = [];
  let used = 0;
  let truncated = false;
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (typeof block.text === "string") {
      const bounded = boundedText(block.text, MAX_CONTENT_TOTAL - used);
      output.push(bounded.text);
      used += bounded.used;
      truncated ||= bounded.truncated;
    } else if (typeof block.blob === "string" || typeof block.data === "string") {
      const data = String(block.blob ?? block.data);
      output.push(`[binary content omitted: ${String(block.mimeType ?? "unknown type")}, approximately ${estimatedBase64Bytes(data)} bytes]`);
    } else {
      const serialized = JSON.stringify(block, null, 2);
      const bounded = boundedText(serialized, MAX_CONTENT_TOTAL - used);
      output.push(bounded.text);
      used += bounded.used;
      truncated ||= bounded.truncated;
    }
    if (used >= MAX_CONTENT_TOTAL) { truncated = true; break; }
  }
  return { text: output.filter(Boolean).join("\n\n") || fallback, truncated };
}

function parseResources(value: unknown, server: string): McpResource[] {
  if (!Array.isArray(value)) throw new Error(`MCP server ${server} returned an invalid resources/list response`);
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error(`MCP server ${server} returned an invalid resource`);
    const item = raw as Record<string, unknown>;
    if (typeof item.uri !== "string" || !item.uri || item.uri.length > 8_192) throw new Error(`MCP server ${server} returned an invalid resource URI`);
    return { name: typeof item.name === "string" && item.name ? item.name : item.uri, uri: item.uri,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}) };
  });
}

function parseTemplates(value: unknown, server: string): McpResourceTemplate[] {
  if (!Array.isArray(value)) throw new Error(`MCP server ${server} returned an invalid resources/templates/list response`);
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error(`MCP server ${server} returned an invalid resource template`);
    const item = raw as Record<string, unknown>;
    if (typeof item.uriTemplate !== "string" || !item.uriTemplate || item.uriTemplate.length > 8_192) throw new Error(`MCP server ${server} returned an invalid resource template URI`);
    return { name: typeof item.name === "string" && item.name ? item.name : item.uriTemplate, uriTemplate: item.uriTemplate,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}) };
  });
}

function parsePrompts(value: unknown, server: string): McpPrompt[] {
  if (!Array.isArray(value)) throw new Error(`MCP server ${server} returned an invalid prompts/list response`);
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error(`MCP server ${server} returned an invalid prompt`);
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name || item.name.length > 256) throw new Error(`MCP server ${server} returned an invalid prompt name`);
    const args = item.arguments === undefined ? [] : item.arguments;
    if (!Array.isArray(args)) throw new Error(`MCP server ${server} returned invalid prompt arguments`);
    return { name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), arguments: args.map((rawArg) => {
      if (!rawArg || typeof rawArg !== "object" || typeof (rawArg as Record<string, unknown>).name !== "string") throw new Error(`MCP server ${server} returned an invalid prompt argument`);
      const argument = rawArg as Record<string, unknown>;
      return { name: String(argument.name), required: argument.required === true,
        ...(typeof argument.description === "string" ? { description: argument.description } : {}) };
    }) };
  });
}

function validatePromptArguments(args: Record<string, string>): void {
  const entries = Object.entries(args);
  if (entries.length > 64) throw new Error("MCP prompt accepts at most 64 arguments");
  let total = 0;
  for (const [name, value] of entries) {
    if (!name || name.length > 256 || typeof value !== "string" || value.length > 20_000) throw new Error("MCP prompt arguments must use bounded string names and values");
    total += name.length + value.length;
  }
  if (total > 64_000) throw new Error("MCP prompt arguments exceed the 64000-character safety limit");
}

function formatToolResult(result: Record<string, unknown>): string {
  const sections: string[] = [];
  if (Array.isArray(result?.content)) {
    for (const block of result.content as Array<Record<string, unknown>>) {
      if (block.type === "text") sections.push(String(block.text ?? ""));
      else if (block.type === "image" || block.type === "audio") sections.push(`[${block.type}: ${String(block.mimeType ?? "unknown type")}, binary data omitted]`);
      else sections.push(JSON.stringify(block));
    }
  }
  if (result?.structuredContent !== undefined) sections.push(JSON.stringify(result.structuredContent, null, 2));
  const output = truncate(sections.filter(Boolean).join("\n") || "MCP tool completed without text output.");
  return result?.isError ? `Tool error: ${output}` : output;
}

function methodUnsupported(error: unknown): boolean {
  return /method not (?:found|supported)|-32601/i.test(error instanceof Error ? error.message : String(error));
}

function decodeMcpStderr(value: Buffer): string {
  if (!value.length) return "";
  if (value[0] === 0xff && value[1] === 0xfe) return iconv.decode(value.subarray(2), "utf16le");
  const utf8 = iconv.decode(value, "utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  if (process.platform !== "win32") return utf8;
  const local = iconv.decode(value, "gb18030");
  const score = (text: string) => (text.match(/\uFFFD/g)?.length ?? 0) * 10 + (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)?.length ?? 0);
  return score(local) < score(utf8) ? local : utf8;
}

class StdioMcpConnection implements McpConnectionLike {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderr = Buffer.alloc(0);
  private closed = false;

  constructor(private name: string, private config: McpServerConfig, private workspace: string) {}

  async start(): Promise<McpToolDefinition[]> {
    const configuredCwd = this.config.cwd
      ? path.resolve(this.workspace, this.config.cwd)
      : this.workspace;
    const launch = await resolveStdioLaunch(this.config.command!, this.config.args ?? []);
    this.child = spawn(launch.command, launch.args, {
      cwd: configuredCwd,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(this.config.env ?? {}).map(([key, value]) => [key, expandEnvironment(value)])),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-MAX_OUTPUT);
    });
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      const stderr = decodeMcpStderr(this.stderr).trim();
      if (!this.closed) this.failAll(new Error(`MCP server ${this.name} exited (${signal ?? code ?? "unknown"})${stderr ? `: ${truncate(stderr)}` : ""}`));
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "xiu", version: packageJson.version },
    });
    this.notify("notifications/initialized", {});
    return await this.listTools();
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { continue; }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(this.errorMessage(message.error)));
        else pending.resolve(message.result);
      } else if (typeof message.id === "number" && typeof message.method === "string") {
        if (message.method === "ping") this.send({ jsonrpc: "2.0", id: message.id, result: {} });
        else this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported" } });
      }
    }
  }

  private errorMessage(value: unknown): string {
    if (value && typeof value === "object" && "message" in value) return String((value as { message: unknown }).message);
    return JSON.stringify(value);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child || this.closed || !this.child.stdin.writable) throw new Error(`MCP server ${this.name} is not connected`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 15_000, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`MCP call ${method} was cancelled`));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(new Error(`MCP server ${this.name} timed out during ${method}`));
      }, timeoutMs);
      let onAbort: (() => void) | undefined;
      if (signal) onAbort = () => {
          clearTimeout(timer);
          this.pending.delete(id);
          signal.removeEventListener("abort", onAbort!);
          try { this.notify("notifications/cancelled", { requestId: id, reason: "Xiu task cancelled" }); } catch {}
          reject(new Error(`MCP call ${method} was cancelled`));
        };
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as { tools?: McpToolDefinition[]; nextCursor?: string };
      if (!Array.isArray(result?.tools)) throw new Error(`MCP server ${this.name} returned an invalid tools/list response`);
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error(`MCP server ${this.name} returned too many tool pages`);
  }

  private async paged(method: string, field: string, signal?: AbortSignal): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
      const result = await this.request(method, cursor ? { cursor } : {}, 15_000, signal) as Record<string, unknown>;
      if (!Array.isArray(result?.[field])) throw new Error(`MCP server ${this.name} returned an invalid ${method} response`);
      items.push(...result[field] as unknown[]);
      if (items.length >= MAX_MCP_ITEMS) return { items: items.slice(0, MAX_MCP_ITEMS), truncated: true };
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) return { items, truncated: false };
      if (seen.has(cursor)) throw new Error(`MCP server ${this.name} returned a repeated pagination cursor for ${method}`);
      seen.add(cursor);
    }
    return { items, truncated: true };
  }

  async listResources(signal?: AbortSignal): Promise<{ resources: McpResource[]; templates: McpResourceTemplate[]; truncated: boolean }> {
    let resources = { items: [] as unknown[], truncated: false };
    let templates = { items: [] as unknown[], truncated: false };
    try { resources = await this.paged("resources/list", "resources", signal); }
    catch (error) { if (!methodUnsupported(error)) throw error; }
    try { templates = await this.paged("resources/templates/list", "resourceTemplates", signal); }
    catch (error) { if (!methodUnsupported(error)) throw error; }
    return { resources: parseResources(resources.items, this.name), templates: parseTemplates(templates.items, this.name), truncated: resources.truncated || templates.truncated };
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpRenderedContent> {
    if (!uri || uri.length > 8_192) throw new Error("MCP resource URI must be between 1 and 8192 characters");
    const result = await this.request("resources/read", { uri }, 30_000, signal) as Record<string, unknown>;
    if (!Array.isArray(result?.contents)) throw new Error(`MCP server ${this.name} returned an invalid resources/read response`);
    const rendered = renderContentBlocks(result.contents, "MCP resource contained no displayable content.");
    return { server: this.name, label: uri, ...rendered };
  }

  async listPrompts(signal?: AbortSignal): Promise<{ prompts: McpPrompt[]; truncated: boolean }> {
    try {
      const result = await this.paged("prompts/list", "prompts", signal);
      return { prompts: parsePrompts(result.items, this.name), truncated: result.truncated };
    } catch (error) {
      if (methodUnsupported(error)) return { prompts: [], truncated: false };
      throw error;
    }
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpRenderedContent> {
    if (!name || name.length > 256) throw new Error("MCP prompt name must be between 1 and 256 characters");
    validatePromptArguments(args);
    const result = await this.request("prompts/get", { name, arguments: args }, 30_000, signal) as Record<string, unknown>;
    if (!Array.isArray(result?.messages)) throw new Error(`MCP server ${this.name} returned an invalid prompts/get response`);
    const blocks = (result.messages as Array<Record<string, unknown>>).flatMap((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      const content = message.content;
      return Array.isArray(content) ? content.map((block) => ({ role, ...(block as Record<string, unknown>) })) : [{ role, ...((content && typeof content === "object") ? content as Record<string, unknown> : { text: String(content ?? "") }) }];
    });
    const rendered = renderContentBlocks(blocks, "MCP prompt contained no displayable messages.");
    return { server: this.name, label: name, ...rendered };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args }, 120_000, signal) as Record<string, unknown>;
    return formatToolResult(result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error(`MCP server ${this.name} closed`));
    if (!this.child) return;
    this.child.stdin.end();
    const child = this.child;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const forceTimer = setTimeout(() => child.kill(), 1_000);
      const hardTimer = setTimeout(resolve, 3_000);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        clearTimeout(hardTimer);
        resolve();
      });
    });
  }
}

class HttpMcpConnection implements McpConnectionLike {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;

  constructor(private name: string, private config: McpServerConfig, private authProvider?: XiuMcpOAuthProvider) {}

  async start(): Promise<McpToolDefinition[]> {
    await this.authProvider?.ensureFresh();
    const headers = Object.fromEntries(Object.entries(this.config.headers ?? {}).map(([key, value]) => [key, expandEnvironment(value)]));
    const transportAuth: AuthProvider | undefined = this.authProvider ? {
      token: async () => (await this.authProvider!.tokens())?.access_token,
      onUnauthorized: async () => await this.authProvider!.ensureFresh(undefined, true),
    } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url!), {
      requestInit: { headers },
      ...(transportAuth ? { authProvider: transportAuth, fetch: createSafeOAuthFetch(), onInsufficientScope: "throw" as const } : {}),
    });
    const client = new Client({ name: "xiu", version: packageJson.version }, {
      versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000, maxRetries: 0 } },
    });
    this.client = client;
    this.transport = transport;
    try {
      await client.connect(transport);
      const result = await client.listTools(undefined, { timeout: 15_000, maxTotalTimeout: 30_000 });
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as JsonSchema,
      }));
    } catch (error) {
      await client.close().catch(() => undefined);
      this.client = undefined;
      this.transport = undefined;
      throw new Error(`MCP server ${this.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.client) throw new Error(`MCP server ${this.name} is not connected`);
    await this.authProvider?.ensureFresh(signal);
    const result = await this.client.callTool({ name, arguments: args }, { signal, timeout: 120_000, maxTotalTimeout: 120_000 });
    return formatToolResult(result as unknown as Record<string, unknown>);
  }

  private connectedClient(): Client {
    if (!this.client) throw new Error(`MCP server ${this.name} is not connected`);
    return this.client;
  }

  async listResources(signal?: AbortSignal): Promise<{ resources: McpResource[]; templates: McpResourceTemplate[]; truncated: boolean }> {
    const client = this.connectedClient();
    await this.authProvider?.ensureFresh(signal);
    const resources: unknown[] = [];
    const templates: unknown[] = [];
    let truncated = false;
    let cursor: string | undefined;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result = await client.listResources(cursor ? { cursor } : undefined, { signal, timeout: 15_000, maxTotalTimeout: 30_000 });
        resources.push(...result.resources);
        if (resources.length >= MAX_MCP_ITEMS) { resources.length = MAX_MCP_ITEMS; truncated = true; break; }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor)) throw new Error(`MCP server ${this.name} returned a repeated pagination cursor for resources/list`);
        seen.add(cursor);
        if (page === MAX_MCP_PAGES - 1) truncated = true;
      }
    } catch (error) { if (!methodUnsupported(error)) throw error; }
    cursor = undefined;
    seen.clear();
    try {
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result = await client.listResourceTemplates(cursor ? { cursor } : undefined, { signal, timeout: 15_000, maxTotalTimeout: 30_000 });
        templates.push(...result.resourceTemplates);
        if (templates.length >= MAX_MCP_ITEMS) { templates.length = MAX_MCP_ITEMS; truncated = true; break; }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor)) throw new Error(`MCP server ${this.name} returned a repeated pagination cursor for resources/templates/list`);
        seen.add(cursor);
        if (page === MAX_MCP_PAGES - 1) truncated = true;
      }
    } catch (error) { if (!methodUnsupported(error)) throw error; }
    return { resources: parseResources(resources, this.name), templates: parseTemplates(templates, this.name), truncated };
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpRenderedContent> {
    if (!uri || uri.length > 8_192) throw new Error("MCP resource URI must be between 1 and 8192 characters");
    const client = this.connectedClient();
    await this.authProvider?.ensureFresh(signal);
    const result = await client.readResource({ uri }, { signal, timeout: 30_000, maxTotalTimeout: 30_000 });
    const rendered = renderContentBlocks(result.contents, "MCP resource contained no displayable content.");
    return { server: this.name, label: uri, ...rendered };
  }

  async listPrompts(signal?: AbortSignal): Promise<{ prompts: McpPrompt[]; truncated: boolean }> {
    const client = this.connectedClient();
    await this.authProvider?.ensureFresh(signal);
    const prompts: unknown[] = [];
    let truncated = false;
    let cursor: string | undefined;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result = await client.listPrompts(cursor ? { cursor } : undefined, { signal, timeout: 15_000, maxTotalTimeout: 30_000 });
        prompts.push(...result.prompts);
        if (prompts.length >= MAX_MCP_ITEMS) { prompts.length = MAX_MCP_ITEMS; truncated = true; break; }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor)) throw new Error(`MCP server ${this.name} returned a repeated pagination cursor for prompts/list`);
        seen.add(cursor);
        if (page === MAX_MCP_PAGES - 1) truncated = true;
      }
    } catch (error) { if (methodUnsupported(error)) return { prompts: [], truncated: false }; throw error; }
    return { prompts: parsePrompts(prompts, this.name), truncated };
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpRenderedContent> {
    if (!name || name.length > 256) throw new Error("MCP prompt name must be between 1 and 256 characters");
    validatePromptArguments(args);
    const client = this.connectedClient();
    await this.authProvider?.ensureFresh(signal);
    const result = await client.getPrompt({ name, arguments: args }, { signal, timeout: 30_000, maxTotalTimeout: 30_000 });
    const blocks = result.messages.flatMap((message) => {
      const content = message.content as unknown;
      return Array.isArray(content) ? content : [content];
    });
    const rendered = renderContentBlocks(blocks, "MCP prompt contained no displayable messages.");
    return { server: this.name, label: name, ...rendered };
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (transport?.sessionId) await transport.terminateSession().catch(() => undefined);
    if (client) await client.close().catch(() => undefined);
  }
}

export class McpManager {
  private connections = new Map<string, McpConnectionLike>();
  private activeTools: AgentTool[] = [];
  private serverStatuses: McpServerStatus[] = [];
  private serverOrigins = new Map<string, "user" | "project">();
  private activeConfigs = new Map<string, McpServerConfig>();

  constructor(
    private workspace: string,
    private globalConfig = path.join(os.homedir(), ".xiu", "mcp.json"),
    private authStore = new McpAuthStore(),
    private stepUpInteraction: McpOAuthInteraction = {},
    private permissionStore = new PermissionGrantStore(path.join(path.dirname(globalConfig), "extension-permissions.json")),
  ) {}

  private async configuredServers(includeProject = true): Promise<Record<string, McpServerConfig>> {
    const globalServers = await readConfig(this.globalConfig);
    const projectServers = includeProject ? await readConfig(path.join(this.workspace, ".xiu", "mcp.json")) : {};
    this.serverOrigins = new Map([
      ...Object.keys(globalServers).map((name) => [name, "user"] as const),
      ...Object.keys(projectServers).map((name) => [name, "project"] as const),
    ]);
    return { ...globalServers, ...projectServers };
  }

  async start(includeProject = true): Promise<McpServerStatus[]> {
    const servers = await this.configuredServers(includeProject);
    await this.close();
    this.activeConfigs = new Map(Object.entries(servers));
    const ready: Array<{ name: string; config: McpServerConfig; transport: "stdio" | "streamable-http" }> = [];
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      const transport = transportOf(config);
      const manifest = mcpManifest(name, `${this.serverOrigins.get(name) ?? "user"}:${name}`, config);
      const previous = await this.permissionStore.approvedManifest(manifest);
      if (!await this.permissionStore.isApproved(manifest)) {
        const permissionChanges = addedPermissions(previous, manifest);
        this.serverStatuses.push({ name, transport, state: "permission-required", tools: 0,
          permissionChanges,
          error: "Permission manifest approval required" });
        continue;
      }
      if (config.auth?.type === "oauth") {
        const credentials = await this.authStore.find(config.url!);
        if (!credentials.some((record) => record.tokens)) {
          this.serverStatuses.push({ name, transport, state: "auth-required", tools: 0 });
          continue;
        }
      }
      ready.push({ name, config, transport });
    }
    type ConnectionResult =
      | { name: string; config: McpServerConfig; transport: "stdio" | "streamable-http"; connection: McpConnectionLike; definitions: McpToolDefinition[] }
      | { name: string; config: McpServerConfig; transport: "stdio" | "streamable-http"; error: string; authRequired: boolean };
    const results: ConnectionResult[] = await Promise.all(ready.map(async ({ name, config, transport }): Promise<ConnectionResult> => {
      const connection: McpConnectionLike = transport === "streamable-http"
        ? new HttpMcpConnection(name, config, config.auth ? new XiuMcpOAuthProvider(config.url!, config.auth, this.authStore) : undefined)
        : new StdioMcpConnection(name, config, this.workspace);
      try { return { name, config, transport, connection, definitions: await connection.start() }; }
      catch (error) {
        await connection.close();
        const reason = sanitizeOAuthError(error, await this.redactionValues(config.url)).message;
        const authRequired = Boolean(config.auth && /oauth|unauthori[sz]ed|credentials expired|run \/mcp login/i.test(reason));
        return { name, config, transport, error: reason, authRequired };
      }
    }));
    const usedNames = new Set<string>();
    for (const result of results) {
      if ("definitions" in result) {
        this.connections.set(result.name, result.connection);
        const tools = result.definitions.map((definition) => {
          const tool = this.adaptTool(result.name, result.config, result.connection, definition);
          const original = tool.name;
          let suffix = 2;
          while (usedNames.has(tool.name)) {
            const marker = `_${suffix++}`;
            tool.name = `${original.slice(0, 64 - marker.length)}${marker}`;
          }
          usedNames.add(tool.name);
          return tool;
        });
        this.activeTools.push(...tools);
        this.serverStatuses.push({ name: result.name, transport: result.transport, state: "connected", tools: tools.length });
      } else this.serverStatuses.push({ name: result.name, transport: result.transport, state: result.authRequired ? "auth-required" : "failed", tools: 0, error: result.error });
    }
    return this.status();
  }

  private adaptTool(name: string, config: McpServerConfig, connection: McpConnectionLike, definition: McpToolDefinition): AgentTool {
    const risk = config.toolRisks?.[definition.name] ?? config.risk ?? "execute";
    // Risk describes the side effects of a remote call (including external
    // account changes). Workspace verification is a separate boundary and is
    // enabled only when the MCP configuration explicitly declares it.
    const changesWorkspace = config.toolChangesWorkspace?.[definition.name] ?? config.changesWorkspace ?? false;
    const toolName = `mcp__${safeName(name)}__${safeName(definition.name)}`.slice(0, 64);
    return {
      name: toolName,
      description: `[MCP: ${name}] ${definition.description ?? definition.name}`,
      inputSchema: definition.inputSchema ?? { type: "object", properties: {} },
      risk,
      replaySafety: risk === "read" ? "safe" : "side-effecting",
      maxAttempts: risk === "read" ? 3 : 1,
      changesWorkspace,
      describe: (input) => `call MCP tool ${name}/${definition.name} with ${truncate(JSON.stringify(input)).slice(0, 500)}`,
      preview: async (input) => truncate(JSON.stringify(input, null, 2)).slice(0, 4_000),
      execute: async (input, context) => {
        try { return await connection.callTool(definition.name, input, context.signal); }
        catch (error) {
          if (!(error instanceof InsufficientScopeError) || !config.auth || !config.url) {
            throw sanitizeOAuthError(error, await this.redactionValues(config.url));
          }
          const required = [...new Set((error.requiredScope ?? "").split(/\s+/).filter(Boolean))];
          const existing = (await new XiuMcpOAuthProvider(config.url, config.auth, this.authStore).status()).scopes;
          const added = required.filter((scope) => !existing.includes(scope));
          const scopes = [...new Set([...existing, ...required])];
          const approved = await context.approve({
            risk: "execute",
            description: `authorize additional OAuth scope for MCP ${name}`,
            preview: `New scopes: ${added.join(" ") || required.join(" ") || "server-defined"}\nThe rejected request will be retried once only after authorization succeeds.`,
          });
          if (!approved) throw new Error(`Additional OAuth scope was declined for MCP ${name}`);
          context.reportProgress?.(`Authorizing additional OAuth scope for MCP ${name}: ${added.join(" ") || "server-defined"}`);
          const interaction: McpOAuthInteraction = {
            ...this.stepUpInteraction,
            interactive: true,
            signal: context.signal,
            confirmAuthorizationServer: async () => true,
            authorizationUrlReady: async (url, opened, browserError) => {
              await this.stepUpInteraction.authorizationUrlReady?.(url, opened, browserError);
              context.reportProgress?.(opened
                ? `Browser launch requested for MCP ${name}; manual URL: ${url.toString()}`
                : `Open this URL to authorize MCP ${name}: ${url.toString()} (${browserError?.message ?? "browser unavailable"})`);
            },
          };
          await loginMcpOAuth(new XiuMcpOAuthProvider(config.url, config.auth, this.authStore, interaction), interaction, scopes);
          return await connection.callTool(definition.name, input, context.signal);
        }
      },
    };
  }

  tools(): AgentTool[] { return [...this.activeTools]; }
  status(): McpServerStatus[] { return this.serverStatuses.map((item) => ({ ...item })); }

  async credentialStatus(): Promise<CredentialBackendStatus> { return await this.authStore.status(); }

  attachOAuthCredentialStore(store: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">): void {
    this.authStore.attachSystemCredentialStore(store);
  }

  private async oauthResource(name: string, includeProject = true): Promise<string> {
    const config = (await this.configuredServers(includeProject))[name];
    if (!config?.url || config.auth?.type !== "oauth") throw new Error(`MCP server ${name} is not configured for OAuth`);
    return config.url;
  }

  async oauthCredentialInfo(name: string, includeProject = true): Promise<McpAuthCredentialInfo[]> {
    return await this.authStore.credentialInfo(await this.oauthResource(name, includeProject));
  }

  async migrateOAuthCredentials(name: string, store: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">, includeProject = true): Promise<number> {
    const migrated = await this.authStore.migrateResource(await this.oauthResource(name, includeProject), store);
    this.authStore.attachSystemCredentialStore(store);
    return migrated;
  }

  async cleanupOAuthCredentials(name: string, includeProject = true): Promise<number> {
    return await this.authStore.cleanupResource(await this.oauthResource(name, includeProject));
  }

  async rollbackOAuthCredentials(name: string, includeProject = true): Promise<number> {
    return await this.authStore.rollbackResource(await this.oauthResource(name, includeProject));
  }

  connectedServerNames(): string[] {
    return [...this.connections.keys()].sort((left, right) => left.localeCompare(right));
  }

  async permissionManifests(includeProject = true): Promise<Array<ExtensionPermissionManifest & { approved: boolean; added: ExtensionPermission[] }>> {
    const servers = await this.configuredServers(includeProject);
    return await Promise.all(Object.entries(servers).filter(([, config]) => config.enabled !== false).map(async ([name, config]) => {
      const manifest = mcpManifest(name, `${this.serverOrigins.get(name) ?? "user"}:${name}`, config);
      const previous = await this.permissionStore.approvedManifest(manifest);
      return { ...manifest, approved: await this.permissionStore.isApproved(manifest), added: addedPermissions(previous, manifest) };
    }));
  }

  async approvePermissions(name: string, includeProject = true): Promise<ExtensionPermissionManifest> {
    const servers = await this.configuredServers(includeProject);
    const config = servers[name];
    if (!config || config.enabled === false) throw new Error(`MCP server ${name} was not found or is disabled`);
    const manifest = mcpManifest(name, `${this.serverOrigins.get(name) ?? "user"}:${name}`, config);
    await this.permissionStore.approve(manifest);
    return manifest;
  }

  private connection(name: string): McpConnectionLike {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`MCP server ${name} is not connected`);
    return connection;
  }

  private async redactionValues(resource?: string): Promise<string[]> {
    if (!resource) return [];
    try { return await this.authStore.redactionValues(resource); }
    catch { return []; }
  }

  private async serverRedactionValues(name: string): Promise<string[]> {
    return await this.redactionValues(this.activeConfigs.get(name)?.url);
  }

  async listResources(name: string, signal?: AbortSignal): Promise<McpResourceCatalog> {
    try {
      const result = await this.connection(name).listResources(signal);
      return { server: name, ...result };
    } catch (error) { throw sanitizeOAuthError(error, await this.serverRedactionValues(name)); }
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<McpRenderedContent> {
    try { return await this.connection(name).readResource(uri, signal); }
    catch (error) { throw sanitizeOAuthError(error, await this.serverRedactionValues(name)); }
  }

  async listPrompts(name: string, signal?: AbortSignal): Promise<McpPromptCatalog> {
    try {
      const result = await this.connection(name).listPrompts(signal);
      return { server: name, ...result };
    } catch (error) { throw sanitizeOAuthError(error, await this.serverRedactionValues(name)); }
  }

  async getPrompt(name: string, prompt: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpRenderedContent> {
    try { return await this.connection(name).getPrompt(prompt, args, signal); }
    catch (error) { throw sanitizeOAuthError(error, await this.serverRedactionValues(name)); }
  }

  async userServerNames(): Promise<string[]> {
    return Object.keys(await readConfig(this.globalConfig)).sort((left, right) => left.localeCompare(right));
  }

  async oauthServerNames(includeProject = true): Promise<string[]> {
    const servers = await this.configuredServers(includeProject);
    return Object.entries(servers)
      .filter(([, config]) => config.enabled !== false && config.auth?.type === "oauth")
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  async login(name: string, interaction: McpOAuthInteraction = {}, includeProject = true): Promise<void> {
    const config = (await this.configuredServers(includeProject))[name];
    if (!config) throw new Error(`MCP server ${name} was not found`);
    if (!config.url || config.auth?.type !== "oauth") throw new Error(`MCP server ${name} is not configured for OAuth`);
    const existing = this.serverStatuses.find((server) => server.name === name);
    if (existing) existing.state = "authorizing";
    try {
      const interactive = { ...interaction, interactive: true };
      await loginMcpOAuth(new XiuMcpOAuthProvider(config.url, config.auth, this.authStore, interactive), interactive);
    } catch (error) {
      const sanitized = sanitizeOAuthError(error, await this.redactionValues(config.url));
      if (existing) {
        existing.state = "auth-required";
        existing.error = sanitized.message;
      }
      throw sanitized;
    }
  }

  async authStatus(name?: string, includeProject = true): Promise<Array<McpOAuthStatus & { name: string }>> {
    const servers = await this.configuredServers(includeProject);
    const entries = Object.entries(servers).filter(([serverName, config]) => (!name || serverName === name) && config.auth?.type === "oauth" && config.url);
    return await Promise.all(entries.map(async ([serverName, config]) => ({
      name: serverName,
      ...await new XiuMcpOAuthProvider(config.url!, config.auth!, this.authStore).status(),
    })));
  }

  async logout(name: string, forgetClient = false, includeProject = true): Promise<{ cleared: number; revoked: boolean; warning?: string }> {
    const config = (await this.configuredServers(includeProject))[name];
    if (!config?.url || config.auth?.type !== "oauth") throw new Error(`MCP server ${name} is not configured for OAuth`);
    const result = await logoutMcpOAuth(new XiuMcpOAuthProvider(config.url, config.auth, this.authStore), forgetClient);
    const connection = this.connections.get(name);
    if (connection) await connection.close();
    this.connections.delete(name);
    this.activeTools = this.activeTools.filter((tool) => !tool.name.startsWith(`mcp__${safeName(name)}__`));
    const status = this.serverStatuses.find((item) => item.name === name);
    if (status) Object.assign(status, { state: "auth-required", tools: 0, error: undefined });
    return result;
  }

  async addUserHttpServer(name: string, url: string, bearerTokenEnvironment?: string, risk: ToolRisk = "execute"): Promise<void> {
    const servers = await readConfig(this.globalConfig);
    if (servers[name]) throw new Error(`MCP server ${name} already exists in user configuration`);
    if (bearerTokenEnvironment && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvironment)) throw new Error("MCP bearer token environment variable name is invalid");
    const draft = {
      transport: "streamable-http",
      url,
      ...(bearerTokenEnvironment ? { headers: { Authorization: `Bearer \${${bearerTokenEnvironment}}` } } : {}),
      risk,
    } as McpServerConfig;
    const config = validateServer(name, { ...draft, permissions: inferredMcpPermissions(draft) });
    servers[name] = config;
    await this.writeUserConfig(servers);
    await this.permissionStore.approve(mcpManifest(name, `user:${name}`, config));
  }

  async addUserOAuthServer(name: string, url: string, auth: McpOAuthConfig, risk: ToolRisk = "execute"): Promise<void> {
    const servers = await readConfig(this.globalConfig);
    if (servers[name]) throw new Error(`MCP server ${name} already exists in user configuration`);
    const draft = { transport: "streamable-http", url, auth, risk } as McpServerConfig;
    servers[name] = validateServer(name, { ...draft, permissions: inferredMcpPermissions(draft) });
    await this.writeUserConfig(servers);
    await this.permissionStore.approve(mcpManifest(name, `user:${name}`, servers[name]!));
  }

  async removeUserServer(name: string): Promise<boolean> {
    const servers = await readConfig(this.globalConfig);
    if (!servers[name]) return false;
    delete servers[name];
    await this.writeUserConfig(servers);
    return true;
  }

  private async writeUserConfig(servers: Record<string, McpServerConfig>): Promise<void> {
    await fs.mkdir(path.dirname(this.globalConfig), { recursive: true });
    const temporary = `${this.globalConfig}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { await fs.rename(temporary, this.globalConfig); }
    catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  summary(language: UiLanguage = "en-US"): string {
    if (!this.serverStatuses.length) return localize(language, "未配置 MCP 服务器。", "No MCP servers configured.");
    return this.serverStatuses.map((server) => {
      if (server.state === "connected") return localize(language, `${server.name}：已连接（${server.tools} 个工具）`, `${server.name}: connected (${server.tools} tool${server.tools === 1 ? "" : "s"})`);
      if (server.state === "permission-required") {
        const changes = server.permissionChanges?.join(", ");
        return localize(language,
          `${server.name}：需要确认权限清单${changes ? ` - 当前变化：${changes}` : ""}`,
          `${server.name}: permission manifest approval required${changes ? ` - current changes: ${changes}` : ""}`);
      }
      if (server.state === "auth-required") return localize(language, `${server.name}：需要 OAuth 登录`, `${server.name}: OAuth authentication required`);
      if (server.state === "authorizing") return localize(language, `${server.name}：正在等待 OAuth 授权`, `${server.name}: waiting for OAuth authorization`);
      if (server.state === "refreshing") return localize(language, `${server.name}：正在刷新 OAuth 凭证`, `${server.name}: refreshing OAuth credentials`);
      if (server.state === "scope-required") return localize(language, `${server.name}：需要额外 OAuth Scope`, `${server.name}: additional OAuth scope required`);
      return localize(language, `${server.name}：连接失败 - ${server.error}`, `${server.name}: failed - ${server.error}`);
    }).join("\n");
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.activeTools = [];
    this.serverStatuses = [];
    await Promise.all(connections.map(async (connection) => await connection.close()));
  }
}
