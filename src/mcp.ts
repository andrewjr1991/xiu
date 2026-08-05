import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentTool, JsonSchema, ToolRisk } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
const MAX_OUTPUT = 60_000;
const VALID_RISKS = new Set<ToolRisk>(["read", "write", "execute", "dangerous"]);

interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  risk?: ToolRisk;
  toolRisks?: Record<string, ToolRisk>;
  changesWorkspace?: boolean;
  toolChangesWorkspace?: Record<string, boolean>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
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
  state: "connected" | "failed";
  tools: number;
  error?: string;
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

function validateServer(name: string, value: unknown): McpServerConfig {
  if (!value || typeof value !== "object") throw new Error(`MCP server ${name} must be an object`);
  const config = value as Record<string, unknown>;
  if (typeof config.command !== "string" || !config.command.trim()) throw new Error(`MCP server ${name} requires command`);
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((item) => typeof item !== "string"))) {
    throw new Error(`MCP server ${name} args must be an array of strings`);
  }
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env)
    || Object.values(config.env).some((item) => typeof item !== "string"))) {
    throw new Error(`MCP server ${name} env must contain string values`);
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
  return config as unknown as McpServerConfig;
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

class McpConnection {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderr = "";
  private closed = false;

  constructor(private name: string, private config: McpServerConfig, private workspace: string) {}

  async start(): Promise<McpToolDefinition[]> {
    const configuredCwd = this.config.cwd
      ? path.resolve(this.workspace, this.config.cwd)
      : this.workspace;
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: configuredCwd,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(this.config.env ?? {}).map(([key, value]) => [key, expandEnvironment(value)])),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr = truncate(`${this.stderr}${chunk}`); });
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) this.failAll(new Error(`MCP server ${this.name} exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
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

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args }, 120_000, signal) as Record<string, unknown>;
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

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private activeTools: AgentTool[] = [];
  private serverStatuses: McpServerStatus[] = [];

  constructor(
    private workspace: string,
    private globalConfig = path.join(os.homedir(), ".xiu", "mcp.json"),
  ) {}

  async start(includeProject = true): Promise<McpServerStatus[]> {
    const globalServers = await readConfig(this.globalConfig);
    const projectServers = includeProject ? await readConfig(path.join(this.workspace, ".xiu", "mcp.json")) : {};
    const servers = { ...globalServers, ...projectServers };
    await this.close();
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      const connection = new McpConnection(name, config, this.workspace);
      try {
        const definitions = await connection.start();
        this.connections.set(name, connection);
        const usedNames = new Set(this.activeTools.map((tool) => tool.name));
        const tools = definitions.map((definition) => {
          const tool = this.adaptTool(name, config, connection, definition);
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
        this.serverStatuses.push({ name, state: "connected", tools: tools.length });
      } catch (error) {
        await connection.close();
        this.serverStatuses.push({ name, state: "failed", tools: 0, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.status();
  }

  private adaptTool(name: string, config: McpServerConfig, connection: McpConnection, definition: McpToolDefinition): AgentTool {
    const risk = config.toolRisks?.[definition.name] ?? config.risk ?? "execute";
    const changesWorkspace = config.toolChangesWorkspace?.[definition.name] ?? config.changesWorkspace ?? risk === "write";
    const toolName = `mcp__${safeName(name)}__${safeName(definition.name)}`.slice(0, 64);
    return {
      name: toolName,
      description: `[MCP: ${name}] ${definition.description ?? definition.name}`,
      inputSchema: definition.inputSchema ?? { type: "object", properties: {} },
      risk,
      changesWorkspace,
      describe: (input) => `call MCP tool ${name}/${definition.name} with ${truncate(JSON.stringify(input)).slice(0, 500)}`,
      preview: async (input) => truncate(JSON.stringify(input, null, 2)).slice(0, 4_000),
      execute: async (input, context) => await connection.callTool(definition.name, input, context.signal),
    };
  }

  tools(): AgentTool[] { return [...this.activeTools]; }
  status(): McpServerStatus[] { return this.serverStatuses.map((item) => ({ ...item })); }

  summary(): string {
    if (!this.serverStatuses.length) return "No MCP servers configured.";
    return this.serverStatuses.map((server) => server.state === "connected"
      ? `${server.name}: connected (${server.tools} tool${server.tools === 1 ? "" : "s"})`
      : `${server.name}: failed - ${server.error}`).join("\n");
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.activeTools = [];
    this.serverStatuses = [];
    await Promise.all(connections.map(async (connection) => await connection.close()));
  }
}
