import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { credentialRef, type CredentialBackendStatus, type CredentialRef, type CredentialStore } from "./credential-store.js";

const STORE_VERSION = 2;
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

export interface McpAuthSecretRecord {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  clientSecret?: string;
}

interface McpTokenMetadata {
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
  issuer?: string;
}

interface McpAuthMigrationReceipt {
  to: CredentialRef<"mcp-oauth-record">;
  migratedAt: string;
  legacyCopyPresent: boolean;
}

interface McpAuthMigrationIntent {
  targetId: string;
  preparedAt: string;
}

interface McpAuthEntry extends McpAuthIdentity {
  tokenMetadata?: McpTokenMetadata;
  clientInformation?: StoredOAuthClientInformation;
  resourceMetadataUrl?: string;
  expiresAt?: number;
  updatedAt?: string;
  legacySecrets?: McpAuthSecretRecord;
  credentialRef?: CredentialRef<"mcp-oauth-record">;
  migration?: McpAuthMigrationReceipt;
  migrationIntent?: McpAuthMigrationIntent;
}

interface McpAuthFileV1 {
  version: 1;
  entries: Record<string, McpAuthRecord>;
  revisions?: Record<string, number>;
}

interface McpAuthFile {
  version: 2;
  entries: Record<string, McpAuthEntry>;
}

export interface McpAuthCredentialInfo extends McpAuthIdentity {
  key: string;
  source: "legacy-file" | "system" | "none";
  legacyCopyPresent: boolean;
  systemCopyPresent: boolean;
  interruptedMigration: boolean;
  migratedAt?: string;
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

function systemId(key: string): string { return `mcp:${key}:oauth`; }

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
    ...(value.scope !== undefined ? { scope: optionalString(value.scope, "token scope", 16_384)! } : {}),
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

function splitRecord(record: McpAuthRecord): { publicEntry: McpAuthEntry; secrets: McpAuthSecretRecord } {
  const sanitized = sanitizeRecord(record);
  const client = sanitized.clientInformation ? structuredClone(sanitized.clientInformation) as unknown as Record<string, unknown> : undefined;
  const clientSecret = typeof client?.client_secret === "string" ? client.client_secret : undefined;
  if (client) delete client.client_secret;
  const tokens = sanitized.tokens;
  const publicEntry: McpAuthEntry = {
    resource: sanitized.resource,
    issuer: sanitized.issuer,
    clientId: sanitized.clientId,
    ...(tokens ? { tokenMetadata: {
      tokenType: tokens.token_type,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(tokens.expires_in !== undefined ? { expiresIn: tokens.expires_in } : {}),
      ...(tokens.issuer ? { issuer: tokens.issuer } : {}),
    } } : {}),
    ...(client ? { clientInformation: client as unknown as StoredOAuthClientInformation } : {}),
    ...(sanitized.resourceMetadataUrl ? { resourceMetadataUrl: sanitized.resourceMetadataUrl } : {}),
    ...(sanitized.expiresAt !== undefined ? { expiresAt: sanitized.expiresAt } : {}),
    updatedAt: sanitized.updatedAt,
  };
  return {
    publicEntry,
    secrets: {
      ...(tokens?.access_token ? { accessToken: tokens.access_token } : {}),
      ...(tokens?.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens?.id_token ? { idToken: tokens.id_token } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
  };
}

function hasSecrets(value: McpAuthSecretRecord | undefined): boolean {
  return Boolean(value && (value.accessToken || value.refreshToken || value.idToken || value.clientSecret));
}

function sanitizeSecrets(value: unknown): McpAuthSecretRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP auth secrets");
  const source = value as Record<string, unknown>;
  const result: McpAuthSecretRecord = {
    ...(source.accessToken !== undefined ? { accessToken: boundedString(source.accessToken, "access token") } : {}),
    ...(source.refreshToken !== undefined ? { refreshToken: boundedString(source.refreshToken, "refresh token") } : {}),
    ...(source.idToken !== undefined ? { idToken: boundedString(source.idToken, "ID token") } : {}),
    ...(source.clientSecret !== undefined ? { clientSecret: boundedString(source.clientSecret, "client secret") } : {}),
  };
  return hasSecrets(result) ? result : undefined;
}

function sanitizeTokenMetadata(value: unknown): McpTokenMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP auth token metadata");
  const source = value as Record<string, unknown>;
  if (source.expiresIn !== undefined && (!Number.isFinite(source.expiresIn) || Number(source.expiresIn) < 0)) throw new Error("Invalid MCP auth token expiry");
  return {
    ...(source.tokenType !== undefined ? { tokenType: boundedString(source.tokenType, "token type", 128) } : {}),
    ...(source.scope !== undefined ? { scope: boundedString(source.scope, "token scope", 16_384) } : {}),
    ...(source.expiresIn !== undefined ? { expiresIn: Number(source.expiresIn) } : {}),
    ...(source.issuer !== undefined ? { issuer: safeUrl(source.issuer, "token issuer") } : {}),
  };
}

function sanitizeCredentialReference(value: unknown): CredentialRef<"mcp-oauth-record"> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP auth store contains an invalid system credential reference");
  const source = value as Partial<CredentialRef<"mcp-oauth-record">>;
  if (source.backend !== "system" || source.kind !== "mcp-oauth-record" || typeof source.id !== "string" || !source.id || !Number.isSafeInteger(source.revision) || Number(source.revision) < 0) {
    throw new Error("MCP auth store contains an invalid system credential reference");
  }
  return credentialRef("system", "mcp-oauth-record", source.id, Number(source.revision));
}

function hydrate(entry: McpAuthEntry, secrets: McpAuthSecretRecord | undefined): McpAuthRecord {
  const client = entry.clientInformation ? structuredClone(entry.clientInformation) as unknown as Record<string, unknown> : undefined;
  if (client && secrets?.clientSecret) client.client_secret = secrets.clientSecret;
  const tokens = secrets?.accessToken ? {
    access_token: secrets.accessToken,
    token_type: entry.tokenMetadata?.tokenType ?? "Bearer",
    ...(secrets.refreshToken ? { refresh_token: secrets.refreshToken } : {}),
    ...(secrets.idToken ? { id_token: secrets.idToken } : {}),
    ...(entry.tokenMetadata?.scope ? { scope: entry.tokenMetadata.scope } : {}),
    ...(entry.tokenMetadata?.expiresIn !== undefined ? { expires_in: entry.tokenMetadata.expiresIn } : {}),
    ...(entry.tokenMetadata?.issuer ? { issuer: entry.tokenMetadata.issuer } : {}),
  } satisfies StoredOAuthTokens : undefined;
  return {
    resource: entry.resource,
    issuer: entry.issuer,
    clientId: entry.clientId,
    ...(tokens ? { tokens } : {}),
    ...(client ? { clientInformation: client as unknown as StoredOAuthClientInformation } : {}),
    ...(entry.resourceMetadataUrl ? { resourceMetadataUrl: entry.resourceMetadataUrl } : {}),
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function safeEntry(raw: unknown): McpAuthEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP auth store contains an invalid entry");
  const source = structuredClone(raw) as McpAuthEntry;
  const identity = normalizeIdentity(source);
  if (source.expiresAt !== undefined && (!Number.isFinite(source.expiresAt) || source.expiresAt < 0)) throw new Error("Invalid MCP auth expiry time");
  if (source.updatedAt !== undefined && Number.isNaN(Date.parse(source.updatedAt))) throw new Error("Invalid MCP auth update time");
  const secrets = sanitizeSecrets(source.legacySecrets) ?? {};
  const client = source.clientInformation ? sanitizeClientInformation(source.clientInformation) : undefined;
  const clientSource = client ? structuredClone(client) as unknown as Record<string, unknown> : undefined;
  const embeddedClientSecret = typeof clientSource?.client_secret === "string" ? clientSource.client_secret : undefined;
  if (clientSource) delete clientSource.client_secret;
  const credential = sanitizeCredentialReference(source.credentialRef);
  const migrationTo = sanitizeCredentialReference(source.migration?.to);
  if (source.migration && (!migrationTo || typeof source.migration.migratedAt !== "string" || Number.isNaN(Date.parse(source.migration.migratedAt)) || typeof source.migration.legacyCopyPresent !== "boolean")) {
    throw new Error("MCP auth store contains an invalid migration receipt");
  }
  if (source.migrationIntent && (typeof source.migrationIntent.targetId !== "string" || !source.migrationIntent.targetId || typeof source.migrationIntent.preparedAt !== "string" || Number.isNaN(Date.parse(source.migrationIntent.preparedAt)))) {
    throw new Error("MCP auth store contains an invalid migration intent");
  }
  if (embeddedClientSecret) {
    if (credential) throw new Error("MCP auth store contains plaintext client secret beside a system reference");
    secrets.clientSecret = embeddedClientSecret;
  }
  if (source.migration && (!credential || !migrationTo || credential.id !== migrationTo.id || credential.revision !== migrationTo.revision)) throw new Error("MCP auth store migration receipt does not match its credential reference");
  if (credential && source.migrationIntent) throw new Error("MCP auth store contains both an active reference and migration intent");
  return {
    ...identity,
    ...(source.tokenMetadata ? { tokenMetadata: sanitizeTokenMetadata(source.tokenMetadata) } : {}),
    ...(clientSource ? { clientInformation: clientSource as unknown as StoredOAuthClientInformation } : {}),
    ...(source.resourceMetadataUrl ? { resourceMetadataUrl: safeUrl(source.resourceMetadataUrl, "resource metadata URL") } : {}),
    ...(source.expiresAt !== undefined ? { expiresAt: source.expiresAt } : {}),
    ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
    ...(hasSecrets(secrets) ? { legacySecrets: secrets } : {}),
    ...(credential ? { credentialRef: credential } : {}),
    ...(source.migration && migrationTo ? { migration: { ...source.migration, to: migrationTo } } : {}),
    ...(source.migrationIntent ? { migrationIntent: structuredClone(source.migrationIntent) } : {}),
  };
}

function equalSecrets(left: McpAuthSecretRecord, right: McpAuthSecretRecord): boolean {
  const a = Buffer.from(JSON.stringify(left));
  const b = Buffer.from(JSON.stringify(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class McpAuthStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private file = path.join(os.homedir(), ".xiu", "mcp-auth.json"),
    private systemCredentials?: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">,
  ) {}

  attachSystemCredentialStore(store: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">): void { this.systemCredentials = store; }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async read(): Promise<McpAuthFile> {
    let content: string;
    try { content = await fs.readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STORE_VERSION, entries: {} };
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new Error("MCP auth store contains invalid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP auth store has an invalid structure");
    const source = parsed as McpAuthFile | McpAuthFileV1;
    if (source.version !== 1 && source.version !== STORE_VERSION) throw new Error(`Unsupported MCP auth store version ${String((source as { version?: unknown }).version)}`);
    if (!source.entries || typeof source.entries !== "object" || Array.isArray(source.entries)) throw new Error("MCP auth store entries are invalid");
    const rawEntries = Object.entries(source.entries as Record<string, unknown>);
    if (rawEntries.length > MAX_ENTRIES) throw new Error("MCP auth store contains too many entries");
    const entries: Record<string, McpAuthEntry> = {};
    for (const [key, value] of rawEntries) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("MCP auth store contains an invalid entry key");
      const entry = source.version === 1
        ? (() => { const split = splitRecord(value as McpAuthRecord); return { ...split.publicEntry, ...(hasSecrets(split.secrets) ? { legacySecrets: split.secrets } : {}) }; })()
        : safeEntry(value);
      if (keyOf(entry) !== key) throw new Error("MCP auth store entry identity does not match its key");
      entries[key] = entry;
    }
    return { version: STORE_VERSION, entries };
  }

  private async write(document: McpAuthFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { await fs.rename(temporary, this.file); }
    catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  private secrets(entry: McpAuthEntry): McpAuthSecretRecord | undefined {
    if (!entry.credentialRef) return entry.legacySecrets ? structuredClone(entry.legacySecrets) : undefined;
    if (!this.systemCredentials) return undefined;
    try { return this.systemCredentials.get(entry.credentialRef); }
    catch { return undefined; }
  }

  async redactionValues(resource?: string): Promise<string[]> {
    const normalizedResource = resource === undefined ? undefined : safeUrl(resource, "resource");
    return await this.exclusive(async () => {
      const values = Object.values((await this.read()).entries)
        .filter((entry) => normalizedResource === undefined || entry.resource === normalizedResource)
        .flatMap((entry) => {
          const secret = this.secrets(entry);
          return secret ? [secret.accessToken, secret.refreshToken, secret.idToken, secret.clientSecret] : [];
        })
        .filter((value): value is string => typeof value === "string" && value.length >= 4);
      return [...new Set(values)];
    });
  }

  async get(identity: McpAuthIdentity): Promise<McpAuthRecord | undefined> {
    return await this.exclusive(async () => {
      const entry = (await this.read()).entries[keyOf(identity)];
      return entry ? hydrate(entry, this.secrets(entry)) : undefined;
    });
  }

  async find(resource: string, issuer?: string, clientId?: string): Promise<McpAuthRecord[]> {
    const normalizedResource = safeUrl(resource, "resource");
    const normalizedIssuer = issuer === undefined ? undefined : safeUrl(issuer, "issuer");
    const normalizedClientId = clientId === undefined ? undefined : boundedString(clientId, "client ID", 2_048);
    return await this.exclusive(async () => Object.values((await this.read()).entries)
      .filter((entry) => entry.resource === normalizedResource
        && (normalizedIssuer === undefined || entry.issuer === normalizedIssuer)
        && (normalizedClientId === undefined || entry.clientId === normalizedClientId))
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .map((entry) => hydrate(entry, this.secrets(entry))));
  }

  async save(record: McpAuthRecord): Promise<void> {
    await this.exclusive(async () => {
      const document = await this.read();
      const sanitized = sanitizeRecord(record);
      const key = keyOf(sanitized);
      if (!document.entries[key] && Object.keys(document.entries).length >= MAX_ENTRIES) throw new Error("MCP auth store contains too many entries");
      const previous = document.entries[key];
      const { publicEntry, secrets } = splitRecord(sanitized);
      if (previous?.credentialRef) {
        if (!this.systemCredentials) throw new Error("Windows Credential Manager is unavailable; OAuth credentials were not updated");
        const nextRef = this.systemCredentials.set(previous.credentialRef, secrets);
        document.entries[key] = {
          ...publicEntry,
          credentialRef: nextRef,
          ...(previous.legacySecrets ? { legacySecrets: previous.legacySecrets } : {}),
          ...(previous.migration ? { migration: { ...previous.migration, to: nextRef, migratedAt: new Date().toISOString() } } : {}),
        };
      } else document.entries[key] = { ...publicEntry, ...(hasSecrets(secrets) ? { legacySecrets: secrets } : {}) };
      await this.write(document);
    });
  }

  async delete(identity: McpAuthIdentity): Promise<boolean> {
    return await this.exclusive(async () => {
      const document = await this.read();
      const key = keyOf(identity);
      const entry = document.entries[key];
      if (!entry) return false;
      delete document.entries[key];
      await this.write(document);
      if (entry.credentialRef && this.systemCredentials) this.systemCredentials.delete(entry.credentialRef);
      return true;
    });
  }

  private clearEntry(entry: McpAuthEntry, scope: "tokens" | "client" | "all"): { entry?: McpAuthEntry; systemDelete?: CredentialRef<"mcp-oauth-record"> } {
    if (scope === "all") return { systemDelete: entry.credentialRef };
    const active = this.secrets(entry) ?? {};
    const legacy = structuredClone(entry.legacySecrets ?? {});
    if (scope === "tokens") {
      delete active.accessToken; delete active.refreshToken; delete active.idToken;
      delete legacy.accessToken; delete legacy.refreshToken; delete legacy.idToken;
      delete entry.tokenMetadata; delete entry.expiresAt;
    } else {
      delete active.clientSecret; delete legacy.clientSecret; delete entry.clientInformation;
    }
    entry.updatedAt = new Date().toISOString();
    entry.legacySecrets = hasSecrets(legacy) ? legacy : undefined;
    if (entry.credentialRef) {
      if (!this.systemCredentials) throw new Error("Windows Credential Manager is unavailable; OAuth credentials were not cleared");
      if (hasSecrets(active)) {
        const nextRef = this.systemCredentials.set(entry.credentialRef, active);
        entry.credentialRef = nextRef;
        if (entry.migration) entry.migration = { ...entry.migration, to: nextRef, migratedAt: new Date().toISOString(), legacyCopyPresent: hasSecrets(legacy) };
      } else {
        const old = entry.credentialRef;
        delete entry.credentialRef; delete entry.migration; delete entry.migrationIntent;
        return { entry: entry.clientInformation || entry.tokenMetadata ? entry : undefined, systemDelete: old };
      }
    }
    return { entry: entry.clientInformation || entry.tokenMetadata || hasSecrets(entry.legacySecrets) ? entry : undefined };
  }

  async clearCredentials(identity: McpAuthIdentity, scope: "tokens" | "client" | "all" = "tokens"): Promise<boolean> {
    return await this.exclusive(async () => {
      const document = await this.read();
      const key = keyOf(identity);
      const current = document.entries[key];
      if (!current) return false;
      const result = this.clearEntry(structuredClone(current), scope);
      if (result.entry) document.entries[key] = result.entry; else delete document.entries[key];
      await this.write(document);
      if (result.systemDelete && this.systemCredentials) this.systemCredentials.delete(result.systemDelete);
      return true;
    });
  }

  async clearResource(resource: string, forgetClients = false): Promise<number> {
    const normalizedResource = safeUrl(resource, "resource");
    return await this.exclusive(async () => {
      const document = await this.read();
      const deletes: CredentialRef<"mcp-oauth-record">[] = [];
      let changed = 0;
      for (const [key, current] of Object.entries(document.entries)) {
        if (current.resource !== normalizedResource) continue;
        changed += 1;
        const result = this.clearEntry(structuredClone(current), forgetClients ? "all" : "tokens");
        if (result.entry) document.entries[key] = result.entry; else delete document.entries[key];
        if (result.systemDelete) deletes.push(result.systemDelete);
      }
      if (changed) await this.write(document);
      if (this.systemCredentials) for (const ref of deletes) this.systemCredentials.delete(ref);
      return changed;
    });
  }

  async credentialInfo(resource?: string): Promise<McpAuthCredentialInfo[]> {
    const normalized = resource ? safeUrl(resource, "resource") : undefined;
    return await this.exclusive(async () => Object.entries((await this.read()).entries)
      .filter(([, entry]) => !normalized || entry.resource === normalized)
      .map(([key, entry]) => ({
        key,
        resource: entry.resource,
        issuer: entry.issuer,
        clientId: entry.clientId,
        source: entry.credentialRef ? "system" as const : hasSecrets(entry.legacySecrets) ? "legacy-file" as const : "none" as const,
        legacyCopyPresent: hasSecrets(entry.legacySecrets),
        systemCopyPresent: Boolean(entry.credentialRef && this.systemCredentials && (() => { try { return this.systemCredentials.has(entry.credentialRef!); } catch { return false; } })()),
        interruptedMigration: Boolean(entry.migrationIntent),
        ...(entry.migration?.migratedAt ? { migratedAt: entry.migration.migratedAt } : {}),
      })));
  }

  async migrateResource(resource: string, store: CredentialStore<McpAuthSecretRecord, "mcp-oauth-record">): Promise<number> {
    const normalized = safeUrl(resource, "resource");
    return await this.exclusive(async () => {
      const document = await this.read();
      const selected = Object.entries(document.entries).filter(([, entry]) => entry.resource === normalized && !entry.credentialRef && hasSecrets(entry.legacySecrets));
      if (!selected.length) throw new Error("No legacy OAuth credentials are available to migrate for this MCP server");
      for (const [key, entry] of selected) {
        const targetId = systemId(key);
        if (store.has(credentialRef("system", "mcp-oauth-record", targetId)) && entry.migrationIntent?.targetId !== targetId) {
          throw new Error("An untracked system OAuth credential already exists; forget it explicitly before retrying");
        }
        entry.migrationIntent = { targetId, preparedAt: new Date().toISOString() };
      }
      await this.write(document);
      const preparedDocument = structuredClone(document);
      const written: Array<[string, CredentialRef<"mcp-oauth-record">]> = [];
      try {
        for (const [key, entry] of selected) {
          const ref = store.set(credentialRef("system", "mcp-oauth-record", systemId(key)), entry.legacySecrets!);
          const restored = store.get(ref);
          if (!restored || !equalSecrets(entry.legacySecrets!, restored)) throw new Error("Windows Credential Manager OAuth round-trip verification failed");
          written.push([key, ref]);
        }
        const switchedDocument = structuredClone(preparedDocument);
        for (const [key, ref] of written) {
          const entry = switchedDocument.entries[key]!;
          entry.credentialRef = ref;
          entry.migration = { to: ref, migratedAt: new Date().toISOString(), legacyCopyPresent: true };
          delete entry.migrationIntent;
        }
        await this.write(switchedDocument);
        this.systemCredentials = store;
        return written.length;
      } catch (error) {
        for (const [, ref] of written) { try { store.delete(ref); } catch { /* durable intent remains */ } }
        try { await this.write(preparedDocument); } catch { /* durable intent was already written */ }
        throw error;
      }
    });
  }

  async cleanupResource(resource: string): Promise<number> {
    const normalized = safeUrl(resource, "resource");
    return await this.exclusive(async () => {
      const document = await this.read();
      const selected = Object.values(document.entries).filter((entry) => entry.resource === normalized && entry.credentialRef && entry.migration && hasSecrets(entry.legacySecrets));
      if (!selected.length) throw new Error("No migrated OAuth plaintext copy is available to clean up for this MCP server");
      if (!this.systemCredentials) throw new Error("Windows Credential Manager is unavailable; cleanup was refused");
      for (const entry of selected) {
        const restored = this.systemCredentials.get(entry.credentialRef!);
        if (!restored || !equalSecrets(entry.legacySecrets!, restored)) throw new Error("The active system OAuth credential could not be verified; cleanup was refused");
      }
      for (const entry of selected) {
        delete entry.legacySecrets;
        entry.migration!.legacyCopyPresent = false;
      }
      await this.write(document);
      return selected.length;
    });
  }

  async rollbackResource(resource: string): Promise<number> {
    const normalized = safeUrl(resource, "resource");
    return await this.exclusive(async () => {
      const document = await this.read();
      const selected = Object.values(document.entries).filter((entry) => entry.resource === normalized && entry.credentialRef && entry.migration);
      if (!selected.length) throw new Error("No migrated OAuth credential is available to roll back for this MCP server");
      const deletes: CredentialRef<"mcp-oauth-record">[] = [];
      for (const entry of selected) {
        if (!hasSecrets(entry.legacySecrets)) {
          if (!this.systemCredentials) throw new Error("Windows Credential Manager is unavailable; rollback could not restore OAuth credentials");
          const restored = this.systemCredentials.get(entry.credentialRef!);
          if (!restored) throw new Error("The active system OAuth credential could not be read for rollback");
          entry.legacySecrets = restored;
        }
        deletes.push(entry.credentialRef!);
        delete entry.credentialRef; delete entry.migration; delete entry.migrationIntent;
      }
      await this.write(document);
      if (this.systemCredentials) for (const ref of deletes) this.systemCredentials.delete(ref);
      return selected.length;
    });
  }

  async status(): Promise<CredentialBackendStatus> {
    return await this.exclusive(async () => {
      const entries = Object.values((await this.read()).entries);
      const usesSystem = entries.some((entry) => entry.credentialRef);
      return {
        backend: usesSystem ? "system" : "legacy-file",
        available: !usesSystem || Boolean(this.systemCredentials),
        secure: usesSystem,
        location: this.file,
        entries: entries.length,
        reason: usesSystem
          ? this.systemCredentials ? "explicitly migrated OAuth references" : "system credential backend unavailable"
          : "local plaintext compatibility storage",
      };
    });
  }
}
