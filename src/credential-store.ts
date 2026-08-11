export type CredentialBackend = "environment" | "legacy-file" | "system";
export type CredentialKind = "provider-api-key" | "mcp-oauth-record";

export interface CredentialRef<K extends CredentialKind = CredentialKind> {
  backend: CredentialBackend;
  kind: K;
  id: string;
  revision: number;
}

export interface CredentialBackendStatus {
  backend: CredentialBackend;
  available: boolean;
  secure: boolean;
  location?: string;
  entries: number;
  reason?: string;
}

export interface CredentialStore<T, K extends CredentialKind = CredentialKind> {
  readonly backend: CredentialBackend;
  readonly kind: K;
  get(ref: CredentialRef<K>): T | undefined;
  has(ref: CredentialRef<K>): boolean;
  set(ref: CredentialRef<K>, value: T): CredentialRef<K>;
  delete(ref: CredentialRef<K>): boolean;
  list(): CredentialRef<K>[];
  status(): CredentialBackendStatus;
}

export type CredentialStoreErrorCode = "invalid-reference" | "backend-mismatch" | "kind-mismatch" | "read-only";

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

function validId(id: string): string {
  if (!id || id.length > 512 || /[\r\n\0]/.test(id)) throw new CredentialStoreError("invalid-reference", "Credential id must be 1-512 characters without control line breaks");
  return id;
}

function validRevision(revision: number | undefined): number {
  if (revision === undefined) return 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new CredentialStoreError("invalid-reference", "Credential revision must be a non-negative safe integer");
  return revision;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function credentialRef<K extends CredentialKind>(backend: CredentialBackend, kind: K, id: string, revision = 0): CredentialRef<K> {
  return { backend, kind, id: validId(id), revision: validRevision(revision) };
}

export function readEnvironmentCredential(id: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!id) return undefined;
  const store = new EnvironmentCredentialStore({ kind: "provider-api-key", ids: [id], env });
  return store.get(credentialRef("environment", "provider-api-key", id));
}

/** Read-only view over explicitly named environment variables. */
export class EnvironmentCredentialStore<K extends CredentialKind = CredentialKind> implements CredentialStore<string, K> {
  readonly backend = "environment" as const;
  readonly kind: K;
  private readonly ids: string[];

  constructor(options: { kind: K; ids: string[]; env?: NodeJS.ProcessEnv }) {
    this.kind = options.kind;
    this.ids = [...new Set(options.ids.map(validId))];
    this.env = options.env ?? process.env;
  }

  private readonly env: NodeJS.ProcessEnv;

  private check(ref: CredentialRef<K>): void {
    if (ref.backend !== this.backend) throw new CredentialStoreError("backend-mismatch", `Credential backend mismatch: expected ${this.backend}`);
    if (ref.kind !== this.kind) throw new CredentialStoreError("kind-mismatch", `Credential kind mismatch: expected ${this.kind}`);
    validId(ref.id);
  }

  get(ref: CredentialRef<K>): string | undefined { this.check(ref); return this.env[ref.id]; }
  has(ref: CredentialRef<K>): boolean { return this.get(ref) !== undefined; }
  set(): CredentialRef<K> { throw new CredentialStoreError("read-only", "Environment credentials are read-only"); }
  delete(): boolean { throw new CredentialStoreError("read-only", "Environment credentials are read-only"); }
  list(): CredentialRef<K>[] {
    return this.ids.filter((id) => this.env[id] !== undefined).sort().map((id) => credentialRef(this.backend, this.kind, id));
  }
  status(): CredentialBackendStatus {
    return { backend: this.backend, available: true, secure: false, entries: this.list().length, reason: "process environment" };
  }
}

/**
 * Compatibility store for credentials that still live in an existing local
 * JSON document. Values are deliberately excluded from list() and status().
 * The owning codec remains responsible for atomic persistence during phase A.
 */
export class LegacyCredentialStore<T, K extends CredentialKind = CredentialKind> implements CredentialStore<T, K> {
  readonly backend = "legacy-file" as const;
  readonly kind: K;
  private values = new Map<string, T>();
  private revisions = new Map<string, number>();
  private readonly location: string;

  constructor(options: { kind: K; location: string; values?: Record<string, T>; revisions?: Record<string, number> }) {
    this.kind = options.kind;
    this.location = options.location;
    for (const [id, value] of Object.entries(options.values ?? {})) {
      validId(id);
      this.values.set(id, clone(value));
      this.revisions.set(id, validRevision(options.revisions?.[id]));
    }
  }

  private check(ref: CredentialRef<K>): void {
    if (ref.backend !== this.backend) throw new CredentialStoreError("backend-mismatch", `Credential backend mismatch: expected ${this.backend}`);
    if (ref.kind !== this.kind) throw new CredentialStoreError("kind-mismatch", `Credential kind mismatch: expected ${this.kind}`);
    validId(ref.id);
    validRevision(ref.revision);
  }

  ref(id: string): CredentialRef<K> {
    validId(id);
    return credentialRef(this.backend, this.kind, id, this.revisions.get(id) ?? 0);
  }

  get(ref: CredentialRef<K>): T | undefined {
    this.check(ref);
    const value = this.values.get(ref.id);
    return value === undefined ? undefined : clone(value);
  }

  has(ref: CredentialRef<K>): boolean {
    this.check(ref);
    return this.values.has(ref.id);
  }

  set(ref: CredentialRef<K>, value: T): CredentialRef<K> {
    this.check(ref);
    const revision = (this.revisions.get(ref.id) ?? 0) + 1;
    this.values.set(ref.id, clone(value));
    this.revisions.set(ref.id, revision);
    return credentialRef(this.backend, this.kind, ref.id, revision);
  }

  delete(ref: CredentialRef<K>): boolean {
    this.check(ref);
    const deleted = this.values.delete(ref.id);
    if (deleted) this.revisions.set(ref.id, (this.revisions.get(ref.id) ?? 0) + 1);
    return deleted;
  }

  list(): CredentialRef<K>[] {
    return [...this.values.keys()].sort((left, right) => left.localeCompare(right)).map((id) => this.ref(id));
  }

  status(): CredentialBackendStatus {
    return { backend: this.backend, available: true, secure: false, location: this.location, entries: this.values.size };
  }

  exportLegacyValues(): Record<string, T> {
    return Object.fromEntries([...this.values.entries()].map(([id, value]) => [id, clone(value)]));
  }

  exportRevisions(): Record<string, number> {
    return Object.fromEntries([...this.revisions.entries()].filter(([id]) => this.values.has(id)));
  }
}
