import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./secret-redaction.js";

const AUDIT_VERSION = 1;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_TEXT = 256;

export type SecurityAuditCategory = "approval" | "credential";
export type SecurityAuditOutcome = "allowed" | "denied" | "cancelled" | "succeeded" | "failed";

export interface SecurityAuditInput {
  category: SecurityAuditCategory;
  action: string;
  outcome: SecurityAuditOutcome;
  subject?: string;
  scope?: string;
  risk?: "write" | "execute" | "dangerous";
  source?: "prompted" | "automatic" | "remembered" | "command";
}

export interface SecurityAuditRecord extends SecurityAuditInput {
  version: 1;
  id: string;
  timestamp: string;
  workspace: string;
}

export interface SecurityAuditReadResult {
  records: SecurityAuditRecord[];
  invalidLines: number;
  truncated: boolean;
}

export interface SecurityAuditWriteResult {
  written: boolean;
  error?: string;
}

function bounded(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = redactSecrets(value).replace(/[\r\n\0]/g, " ").trim();
  if (!cleaned || cleaned.length > MAX_TEXT) throw new Error(`Invalid audit ${label}`);
  return cleaned;
}

function workspaceId(workspace: string): string {
  return createHash("sha256").update(path.resolve(workspace).toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is SecurityAuditRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === AUDIT_VERSION
    && typeof item.id === "string" && item.id.length <= 64
    && typeof item.timestamp === "string" && !Number.isNaN(Date.parse(item.timestamp))
    && typeof item.workspace === "string" && /^[a-f0-9]{16}$/.test(item.workspace)
    && ["approval", "credential"].includes(String(item.category))
    && ["allowed", "denied", "cancelled", "succeeded", "failed"].includes(String(item.outcome))
    && typeof item.action === "string" && item.action.length > 0 && item.action.length <= MAX_TEXT
    && ["subject", "scope", "risk", "source"].every((key) => item[key] === undefined || (typeof item[key] === "string" && item[key].length <= MAX_TEXT));
}

export class SecurityAuditLog {
  private pending = Promise.resolve();
  private lastError?: string;
  private readonly workspace: string;

  constructor(
    readonly filename = path.join(os.homedir(), ".xiu", "security-audit.jsonl"),
    workspace = process.cwd(),
    private readonly maximumBytes = DEFAULT_MAX_BYTES,
  ) {
    this.workspace = workspaceId(workspace);
  }

  status(): { filename: string; healthy: boolean; lastError?: string } {
    return { filename: this.filename, healthy: this.lastError === undefined, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  async record(input: SecurityAuditInput, sensitiveValues: readonly string[] = []): Promise<SecurityAuditWriteResult> {
    let result: SecurityAuditWriteResult = { written: false };
    const operation = this.pending.then(async () => { result = await this.write(input, sensitiveValues); });
    this.pending = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async write(input: SecurityAuditInput, sensitiveValues: readonly string[]): Promise<SecurityAuditWriteResult> {
    try {
      if (!["approval", "credential"].includes(input.category)) throw new Error("Invalid audit category");
      if (!["allowed", "denied", "cancelled", "succeeded", "failed"].includes(input.outcome)) throw new Error("Invalid audit outcome");
      const record: SecurityAuditRecord = {
        version: AUDIT_VERSION,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        workspace: this.workspace,
        category: input.category,
        action: bounded(redactSecrets(input.action, sensitiveValues), "action")!,
        outcome: input.outcome,
        ...(bounded(input.subject ? redactSecrets(input.subject, sensitiveValues) : undefined, "subject") ? { subject: bounded(redactSecrets(input.subject!, sensitiveValues), "subject") } : {}),
        ...(bounded(input.scope, "scope") ? { scope: bounded(input.scope, "scope") } : {}),
        ...(input.risk ? { risk: input.risk } : {}),
        ...(input.source ? { source: input.source } : {}),
      };
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const existing = await fs.lstat(this.filename).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("Audit path is not a regular file");
      const line = `${JSON.stringify(record)}\n`;
      if ((existing?.size ?? 0) + Buffer.byteLength(line) > this.maximumBytes) {
        const archive = `${this.filename}.1`;
        const archived = await fs.lstat(archive).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (archived?.isSymbolicLink() || (archived && !archived.isFile())) throw new Error("Audit archive path is not a regular file");
        if (archived) await fs.unlink(archive);
        if (existing) await fs.rename(this.filename, archive);
      }
      await fs.appendFile(this.filename, line, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(this.filename, 0o600).catch(() => undefined);
      this.lastError = undefined;
      return { written: true };
    } catch (error) {
      this.lastError = redactSecrets(error instanceof Error ? error.message : String(error), sensitiveValues).slice(0, MAX_TEXT);
      return { written: false, error: this.lastError };
    }
  }

  async read(options: { category?: SecurityAuditCategory; limit?: number } = {}): Promise<SecurityAuditReadResult> {
    await this.pending;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    let text: string;
    try {
      const existing = await fs.lstat(this.filename);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Audit path is not a regular file");
      text = await fs.readFile(this.filename, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], invalidLines: 0, truncated: false };
      throw new Error(`Could not read security audit log: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-MAX_RECORDS);
    const records: SecurityAuditRecord[] = [];
    let invalidLines = 0;
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) invalidLines++;
        else if (!options.category || parsed.category === options.category) records.push(parsed);
      } catch { invalidLines++; }
    }
    return { records: records.slice(-limit), invalidLines, truncated: records.length > limit || lines.length >= MAX_RECORDS };
  }
}
