import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { LegacyCredentialStore, type CredentialBackendStatus } from "./credential-store.js";

const STORE_VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_STRING = 16_384;

export interface McpAuthIdentity {
  resource: string;
  issuer: string;
  clientId: string;
}

export interface McpAuthRecord extends McpAuthIdentity {
  tokens?: StoredOAuthTokens;
  clientInformation?: StoredOAuthClientInformation;
  resourceMetadataUrl?: string;
  expiresAt?: number;
  updatedAt?: string;
}

interface McpAuthFile {
  version: 1;
  entries: Record<string, McpAuthRecord>;
  revisions?: Record<string, number>;
}

function boundedString(value: unknown, label: string, maximum = MAX_STRING): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`Invalid MCP auth ${label}`);
  return value;
}

function safeUrl(value: unknown, label: string): string {
  const text = boundedString(value, label, 2_048);
  let parsed: URL;
  try { parsed = new URL(text); }
  catch { throw new Error(`Invalid MCP auth ${label}`); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error(`Invalid MCP auth ${label}`);
  return parsed.toString();
}

function normalizeIdentity(value: McpAuthIdentity): McpAuthIdentity {
  return {
    resource: safeUrl(value.resource, "resource"),
    issuer: safeUrl(value.issuer, "issuer"),
    clientId: boundedString(value.clientId, "client ID", 2_048),
  };
}

function keyOf(identity: McpAuthIdentity): string {
  const normalized = normalizeIdentity(identity);
  return createHash("sha256").update(`${normalized.resource}\n${normalized.issuer}\n${normalized.clientId}`, "utf8").digest("hex");
}

function optionalString(value: unknown, label: string, maximum = MAX_STRING): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, label, maximum);
}

function sanitizeTokens(value: StoredOAuthTokens | undefined): StoredOAuthTokens | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Invalid MCP auth tokens");
  const expiresIn = value.expires_in;
  if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 0)) throw new Error("Invalid MCP auth token expiry");
  return {
    access_token: boundedString(value.access_token, "access token"),
    token_type: boundedString(value.token_type, "token type", 128),
    ...(value.refresh_token !== undefined ? { refresh_token: optionalString(value.refresh_token, "refresh token")! } : {}),
    ...(value.scope !== undefined ? { scope: optionalString(value.scope, "token scope", 4_096)! } : {}),
    ...(value.id_token !== undefined ? { id_token: optionalString(value.id_token, "ID token")! } : {}),
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    ...(value.issuer !== undefined ? { issuer: safeUrl(value.issuer, "token issuer") } : {}),
  };
}

function sanitizeClientInformation(value: StoredOAuthClientInformation | undefined): StoredOAuthClientInformation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Invalid MCP auth client information");
  const source = value as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = { client_id: boundedString(source.client_id, "registered client ID", 2_048) };
  const stringFields = [
    "client_secret", "token_endpoint_auth_method", "application_type", "client_name", "client_uri", "logo_uri",
    "scope", "tos_uri", "policy_uri", "jwks_uri", "software_id", "software_version", "software_statement", "issuer",
  ];
  for (const field of stringFields) if (source[field] !== undefined) output[field] = boundedString(source[field], `client ${field}`);
  for (const field of ["client_id_issued_at", "client_secret_expires_at"]) {
    if (source[field] !== undefined && (!Number.isFinite(source[field]) || Number(source[field]) < 0)) throw new Error(`Invalid MCP auth client ${field}`);
    if (source[field] !== undefined) output[field] = source[field];
  }
  for (const field of ["redirect_uris", "grant_types", "response_types", "contacts"]) {
    const candidate = source[field];
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate) || candidate.length > 64 || candidate.some((item) => typeof item !== "string" || !item || item.length > 2_048)) {
      throw new Error(`Invalid MCP auth client ${field}`);
    }
    output[field] = [...candidate];
  }
  if (source.jwks !== undefined) output.jwks = structuredClone(source.jwks);
  return output as unknown as StoredOAuthClientInformation;
}

function sanitizeRecord(record: McpAuthRecord): McpAuthRecord {
  const identity = normalizeIdentity(record);
  if (record.expiresAt !== undefined && (!Number.isFinite(record.expiresAt) || record.expiresAt < 0)) throw new Error("Invalid MCP auth expiry time");
  if (record.updatedAt !== undefined && Number.isNaN(Date.parse(record.updatedAt))) throw new Error("Invalid MCP auth update time");
  return {
    ...identity,
    ...(record.tokens ? { tokens: sanitizeTokens(record.tokens) } : {}),
    ...(record.clientInformation ? { clientInformation: sanitizeClientInformation(record.clientInformation) } : {}),
    ...(record.resourceMetadataUrl ? { resourceMetadataUrl: safeUrl(record.resourceMetadataUrl, "resource metadata URL") } : {}),
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    updatedAt: record.updatedAt && !Number.isNaN(Date.parse(record.updatedAt)) ? record.updatedAt : new Date().toISOString(),
  };
}

export class McpAuthStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(private file = path.join(os.homedir(), ".xiu", "mcp-auth.json")) {}

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async read(): Promise<LegacyCredentialStore<McpAuthRecord, "mcp-oauth-record">> {
    let content: string;
    try { content = await fs.readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new LegacyCredentialStore({ kind: "mcp-oauth-record", location: this.file });
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new Error("MCP auth store contains invalid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP auth store has an invalid structure");
    const source = parsed as Record<string, unknown>;
    if (source.version !== STORE_VERSION) throw new Error(`Unsupported MCP auth store version ${String(source.version)}`);
    if (!source.entries || typeof source.entries !== "object" || Array.isArray(source.entries)) throw new Error("MCP auth store entries are invalid");
    const rawEntries = Object.entries(source.entries as Record<string, unknown>);
    if (rawEntries.length > MAX_ENTRIES) throw new Error("MCP auth store contains too many entries");
    const entries: Record<string, McpAuthRecord> = {};
    for (const [key, value] of rawEntries) {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP auth store contains an invalid entry");
      const record = sanitizeRecord(value as McpAuthRecord);
      if (keyOf(record) !== key) throw new Error("MCP auth store entry identity does not match its key");
      entries[key] = record;
    }
    const revisions = source.revisions && typeof source.revisions === "object" && !Array.isArray(source.revisions)
      ? source.revisions as Record<string, number>
      : undefined;
    return new LegacyCredentialStore({ kind: "mcp-oauth-record", location: this.file, values: entries, revisions });
  }

  private async write(store: LegacyCredentialStore<McpAuthRecord, "mcp-oauth-record">): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const document: McpAuthFile = { version: STORE_VERSION, entries: store.exportLegacyValues(), revisions: store.exportRevisions() };
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { await fs.rename(temporary, this.file); }
    catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  async get(identity: McpAuthIdentity): Promise<McpAuthRecord | undefined> {
    return await this.exclusive(async () => {
      const store = await this.read();
      return store.get(store.ref(keyOf(identity)));
    });
  }

  async find(resource: string, issuer?: string, clientId?: string): Promise<McpAuthRecord[]> {
    const normalizedResource = safeUrl(resource, "resource");
    const normalizedIssuer = issuer === undefined ? undefined : safeUrl(issuer, "issuer");
    const normalizedClientId = clientId === undefined ? undefined : boundedString(clientId, "client ID", 2_048);
    return await this.exclusive(async () => Object.values((await this.read()).exportLegacyValues())
      .filter((record) => record.resource === normalizedResource
        && (normalizedIssuer === undefined || record.issuer === normalizedIssuer)
        && (normalizedClientId === undefined || record.clientId === normalizedClientId))
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .map((record) => structuredClone(record)));
  }

  async save(record: McpAuthRecord): Promise<void> {
    await this.exclusive(async () => {
      const store = await this.read();
      const sanitized = sanitizeRecord(record);
      const key = keyOf(sanitized);
      const ref = store.ref(key);
      if (!store.has(ref) && store.list().length >= MAX_ENTRIES) throw new Error("MCP auth store contains too many entries");
      store.set(ref, sanitized);
      await this.write(store);
    });
  }

  async delete(identity: McpAuthIdentity): Promise<boolean> {
    return await this.exclusive(async () => {
      const store = await this.read();
      const key = keyOf(identity);
      const ref = store.ref(key);
      if (!store.delete(ref)) return false;
      await this.write(store);
      return true;
    });
  }

  async clearCredentials(identity: McpAuthIdentity, scope: "tokens" | "client" | "all" = "tokens"): Promise<boolean> {
    return await this.exclusive(async () => {
      const store = await this.read();
      const key = keyOf(identity);
      const ref = store.ref(key);
      const existing = store.get(ref);
      if (!existing) return false;
      if (scope === "all") store.delete(ref);
      else {
        const next = { ...existing, updatedAt: new Date().toISOString() };
        if (scope === "tokens") {
          delete next.tokens;
          delete next.expiresAt;
        } else delete next.clientInformation;
        if (!next.tokens && !next.clientInformation) store.delete(ref);
        else store.set(ref, next);
      }
      await this.write(store);
      return true;
    });
  }

  async clearResource(resource: string, forgetClients = false): Promise<number> {
    const normalizedResource = safeUrl(resource, "resource");
    return await this.exclusive(async () => {
      const store = await this.read();
      let changed = 0;
      for (const [key, record] of Object.entries(store.exportLegacyValues())) {
        if (record.resource !== normalizedResource) continue;
        changed += 1;
        const ref = store.ref(key);
        if (forgetClients) store.delete(ref);
        else {
          const next = { ...record, updatedAt: new Date().toISOString() };
          delete next.tokens;
          delete next.expiresAt;
          if (!next.clientInformation) store.delete(ref);
          else store.set(ref, next);
        }
      }
      if (changed) await this.write(store);
      return changed;
    });
  }

  async status(): Promise<CredentialBackendStatus> {
    return await this.exclusive(async () => (await this.read()).status());
  }
}
