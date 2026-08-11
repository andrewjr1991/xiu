import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CredentialStoreError,
  credentialRef,
  type CredentialBackendStatus,
  type CredentialKind,
  type CredentialRef,
  type CredentialStore,
} from "./credential-store.js";

const SERVICE_PREFIX = "xiu-ai.credentials";
const ENVELOPE_VERSION = 1;
const MAX_SERIALIZED_BYTES = 2_400;

interface KeyringEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  deleteCredential(): boolean;
}

interface KeyringEntryConstructor {
  new(service: string, username: string): KeyringEntry;
}

interface StoredEnvelope<T> {
  version: 1;
  kind: CredentialKind;
  revision: number;
  value: T;
}

export interface WindowsCredentialProbeResult {
  status: CredentialBackendStatus;
  checks: {
    module: boolean;
    write?: boolean;
    read?: boolean;
    delete?: boolean;
  };
  testedAt: string;
}

function checkPlatform(platform = process.platform): void {
  if (platform !== "win32") throw new CredentialStoreError("backend-unavailable", "Windows Credential Manager is available only on Windows");
}

function safeOperationError(operation: string): CredentialStoreError {
  return new CredentialStoreError("operation-failed", `Windows Credential Manager ${operation} failed`);
}

function encodeEnvelope<T>(kind: CredentialKind, revision: number, value: T): string {
  const serialized = JSON.stringify({ version: ENVELOPE_VERSION, kind, revision, value } satisfies StoredEnvelope<T>);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new CredentialStoreError("size-limit", `Credential exceeds the ${MAX_SERIALIZED_BYTES}-byte Windows Credential Manager safety limit`);
  }
  return serialized;
}

function decodeEnvelope<T, K extends CredentialKind>(serialized: string, kind: K): StoredEnvelope<T> {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new CredentialStoreError("corrupted-value", "Windows Credential Manager entry is not valid Xiu credential data"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialStoreError("corrupted-value", "Windows Credential Manager entry has an invalid Xiu credential envelope");
  }
  const envelope = parsed as Partial<StoredEnvelope<T>>;
  if (envelope.version !== ENVELOPE_VERSION || envelope.kind !== kind || !Number.isSafeInteger(envelope.revision) || (envelope.revision ?? -1) < 0 || !("value" in envelope)) {
    throw new CredentialStoreError("corrupted-value", "Windows Credential Manager entry has an incompatible Xiu credential envelope");
  }
  return envelope as StoredEnvelope<T>;
}

async function loadKeyringEntry(): Promise<KeyringEntryConstructor> {
  checkPlatform();
  try {
    const module = await import("@napi-rs/keyring");
    if (typeof module.Entry !== "function") throw new Error("Entry export unavailable");
    return module.Entry as KeyringEntryConstructor;
  } catch {
    throw new CredentialStoreError("backend-unavailable", "Optional native Windows Credential Manager backend is not installed or was blocked by system policy");
  }
}

/**
 * Windows system store. Provider credentials select it only through an
 * explicit, verified migration; it is never chosen merely because an entry exists.
 */
export class WindowsSystemCredentialStore<T, K extends CredentialKind = CredentialKind> implements CredentialStore<T, K> {
  readonly backend = "system" as const;
  private readonly ids: string[];

  constructor(readonly kind: K, private readonly Entry: KeyringEntryConstructor, ids: string[] = []) {
    this.ids = [...new Set(ids.map((id) => credentialRef("system", kind, id).id))];
  }

  private check(ref: CredentialRef<K>): void {
    if (ref.backend !== this.backend) throw new CredentialStoreError("backend-mismatch", `Credential backend mismatch: expected ${this.backend}`);
    if (ref.kind !== this.kind) throw new CredentialStoreError("kind-mismatch", `Credential kind mismatch: expected ${this.kind}`);
    credentialRef(this.backend, this.kind, ref.id, ref.revision);
  }

  private entry(id: string): KeyringEntry {
    return new this.Entry(`${SERVICE_PREFIX}.${this.kind}`, id);
  }

  ref(id: string, revision = 0): CredentialRef<K> {
    return credentialRef(this.backend, this.kind, id, revision);
  }

  get(ref: CredentialRef<K>): T | undefined {
    this.check(ref);
    let serialized: string | null;
    try { serialized = this.entry(ref.id).getPassword(); }
    catch { throw safeOperationError("read"); }
    if (serialized === null) return undefined;
    const envelope = decodeEnvelope<T, K>(serialized, this.kind);
    // The credential ID is authoritative. A newer envelope may exist when the
    // system write succeeded but the referencing JSON file could not be
    // replaced. Accepting that newer revision makes the cross-backend update
    // recoverable instead of turning a valid rotated credential into an outage.
    return structuredClone(envelope.value);
  }

  has(ref: CredentialRef<K>): boolean { return this.get(ref) !== undefined; }

  set(ref: CredentialRef<K>, value: T): CredentialRef<K> {
    this.check(ref);
    const entry = this.entry(ref.id);
    let revision = 0;
    try {
      const existing = entry.getPassword();
      if (existing !== null) revision = decodeEnvelope<T, K>(existing, this.kind).revision;
      revision += 1;
      entry.setPassword(encodeEnvelope(this.kind, revision, structuredClone(value)));
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw safeOperationError("write");
    }
    return this.ref(ref.id, revision);
  }

  delete(ref: CredentialRef<K>): boolean {
    this.check(ref);
    try { return this.entry(ref.id).deleteCredential(); }
    catch { throw safeOperationError("delete"); }
  }

  list(): CredentialRef<K>[] {
    return this.ids.map((id) => this.ref(id));
  }

  status(): CredentialBackendStatus {
    return {
      backend: this.backend,
      available: true,
      secure: true,
      location: "Windows Credential Manager",
      entries: this.ids.length,
      reason: "selected only by explicit verified references",
    };
  }
}

export async function createWindowsSystemCredentialStore<T, K extends CredentialKind>(kind: K, ids: string[] = []): Promise<WindowsSystemCredentialStore<T, K>> {
  return new WindowsSystemCredentialStore(kind, await loadKeyringEntry(), ids);
}

export async function probeWindowsSystemCredentialStore(writeTest = false): Promise<WindowsCredentialProbeResult> {
  const testedAt = new Date().toISOString();
  let store: WindowsSystemCredentialStore<string, "provider-api-key">;
  try {
    store = await createWindowsSystemCredentialStore("provider-api-key");
  } catch (error) {
    return {
      status: {
        backend: "system", available: false, secure: true, entries: 0,
        location: "Windows Credential Manager",
        reason: error instanceof CredentialStoreError ? error.message : "Windows Credential Manager probe failed",
      },
      checks: { module: false },
      testedAt,
    };
  }
  if (!writeTest) return { status: store.status(), checks: { module: true }, testedAt };

  const id = `probe:${randomUUID()}`;
  const ref = store.ref(id);
  const secret = randomBytes(32).toString("base64url");
  let written = false;
  let write = false;
  let read = false;
  let deleted = false;
  try {
    if (store.has(ref)) throw new CredentialStoreError("operation-failed", "Windows Credential Manager probe target already exists");
    store.set(ref, secret);
    written = true;
    write = true;
    const restored = store.get(ref);
    read = typeof restored === "string" && timingSafeEqual(Buffer.from(restored), Buffer.from(secret));
    if (!read) throw safeOperationError("round-trip verification");
    deleted = store.delete(ref);
    written = false;
    if (!deleted || store.has(ref)) throw safeOperationError("cleanup verification");
    return { status: store.status(), checks: { module: true, write, read, delete: deleted }, testedAt };
  } catch (error) {
    return {
      status: { ...store.status(), available: false, reason: error instanceof CredentialStoreError ? error.message : "Windows Credential Manager canary probe failed" },
      checks: { module: true, write, read, delete: deleted },
      testedAt,
    };
  } finally {
    if (written) {
      try { store.delete(ref); }
      catch { /* Exact unique canary cleanup failed; the status above remains unavailable. */ }
    }
  }
}
