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

export interface KeyringEntryConstructor {
  new(service: string, username: string): KeyringEntry;
}

interface StoredEnvelope<T> {
  version: 1;
  kind: CredentialKind;
  revision: number;
  value: T;
}

export type SystemCredentialBackendId = "windows-credential-manager" | "macos-keychain" | "linux-secret-service";

/** The operating-system secret store Xiu uses on one platform; the same optional native module reaches all three. */
export interface SystemCredentialBackend {
  id: SystemCredentialBackendId;
  /** User-facing name, also the `location` of the backend status. */
  name: string;
  platform: NodeJS.Platform;
  /** What has to be running for the backend to answer; shown when a probe or operation fails. */
  requirement?: string;
}

const BACKENDS: Partial<Record<NodeJS.Platform, SystemCredentialBackend>> = {
  win32: { id: "windows-credential-manager", name: "Windows Credential Manager", platform: "win32" },
  darwin: { id: "macos-keychain", name: "macOS Keychain", platform: "darwin", requirement: "the login keychain must be unlocked; macOS may ask once to allow access when the CLI and the desktop app share an item" },
  linux: { id: "linux-secret-service", name: "Linux Secret Service", platform: "linux", requirement: "a D-Bus session bus with a Secret Service provider such as GNOME Keyring or KWallet must be running; the kernel keyring fallback is not used because it does not survive a reboot" },
};

/** The backend for a platform, or undefined where Xiu has none (BSD, unknown platforms). */
export function systemCredentialBackend(platform: NodeJS.Platform = process.platform): SystemCredentialBackend | undefined {
  return BACKENDS[platform];
}

/** The user-facing name of the current platform's backend, or a generic noun where there is none. */
export function systemCredentialBackendName(platform: NodeJS.Platform = process.platform): string {
  return systemCredentialBackend(platform)?.name ?? "system credential store";
}

export interface SystemCredentialProbeResult {
  backend?: SystemCredentialBackend;
  status: CredentialBackendStatus;
  checks: {
    /** The optional native module loaded on a supported platform. */
    module: boolean;
    /** A read of a random, nonexistent id answered "no entry" instead of failing (the service is reachable). */
    lookup?: boolean;
    write?: boolean;
    read?: boolean;
    delete?: boolean;
  };
  testedAt: string;
}

function requireBackend(platform: NodeJS.Platform): SystemCredentialBackend {
  const backend = systemCredentialBackend(platform);
  if (!backend) {
    throw new CredentialStoreError("backend-unavailable", `No system credential backend is available on ${platform}; Xiu supports Windows Credential Manager, macOS Keychain and Linux Secret Service`);
  }
  return backend;
}

function operationError(backend: SystemCredentialBackend, operation: string): CredentialStoreError {
  return new CredentialStoreError("operation-failed", `${backend.name} ${operation} failed`);
}

function encodeEnvelope<T>(backend: SystemCredentialBackend, kind: CredentialKind, revision: number, value: T): string {
  const serialized = JSON.stringify({ version: ENVELOPE_VERSION, kind, revision, value } satisfies StoredEnvelope<T>);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new CredentialStoreError("size-limit", `Credential exceeds the ${MAX_SERIALIZED_BYTES}-byte ${backend.name} safety limit`);
  }
  return serialized;
}

function decodeEnvelope<T, K extends CredentialKind>(backend: SystemCredentialBackend, serialized: string, kind: K): StoredEnvelope<T> {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new CredentialStoreError("corrupted-value", `${backend.name} entry is not valid Xiu credential data`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialStoreError("corrupted-value", `${backend.name} entry has an invalid Xiu credential envelope`);
  }
  const envelope = parsed as Partial<StoredEnvelope<T>>;
  if (envelope.version !== ENVELOPE_VERSION || envelope.kind !== kind || !Number.isSafeInteger(envelope.revision) || (envelope.revision ?? -1) < 0 || !("value" in envelope)) {
    throw new CredentialStoreError("corrupted-value", `${backend.name} entry has an incompatible Xiu credential envelope`);
  }
  return envelope as StoredEnvelope<T>;
}

/** A read-only search of one service in the platform store; on Linux it only ever goes through Secret Service. */
export type KeyringSearch = (service: string) => unknown;

interface Keyring {
  Entry: KeyringEntryConstructor;
  findCredentials?: KeyringSearch;
}

export interface SystemCredentialStoreOptions {
  /** Platform to select the backend for; tests pass one, production code never does. */
  platform?: NodeJS.Platform;
  /** Replacement for the native `Entry` class; tests pass a fake, production code never does. */
  Entry?: KeyringEntryConstructor;
  /** Replacement for the native search used by the Linux reachability check; tests pass a fake, production code never does. */
  findCredentials?: KeyringSearch;
}

async function loadKeyring(backend: SystemCredentialBackend, options: SystemCredentialStoreOptions): Promise<Keyring> {
  if (options.Entry) return { Entry: options.Entry, findCredentials: options.findCredentials };
  try {
    const module = await import("@napi-rs/keyring");
    if (typeof module.Entry !== "function") throw new Error("Entry export unavailable");
    return { Entry: module.Entry as KeyringEntryConstructor, findCredentials: typeof module.findCredentials === "function" ? module.findCredentials as KeyringSearch : undefined };
  } catch {
    throw new CredentialStoreError("backend-unavailable", `Optional native ${backend.name} backend is not installed or was blocked by system policy`);
  }
}

/**
 * Linux only: the native module silently falls back to the kernel keyring (keyutils) when no
 * Secret Service answers a read, and keys written there vanish at reboot. A credential that was
 * migrated and then cleaned up would be lost. `findCredentials` goes through Secret Service alone
 * and throws without a D-Bus session or provider, so it decides whether the backend exists at all,
 * before any `Entry` operation can pick the fallback.
 */
function assertServiceReachable(backend: SystemCredentialBackend, keyring: Keyring): void {
  if (backend.platform !== "linux" || !keyring.findCredentials) return;
  try { keyring.findCredentials(`${SERVICE_PREFIX}.probe`); }
  catch { throw new CredentialStoreError("backend-unavailable", `${backend.name} is not reachable (${backend.requirement})`); }
}

/**
 * Operating-system credential store: Windows Credential Manager, macOS Keychain or Linux
 * Secret Service, whichever the platform offers. Provider credentials select it only through an
 * explicit, verified migration; it is never chosen merely because an entry exists, and a selected
 * backend that stops answering makes operations fail instead of falling back to plaintext.
 */
export class SystemCredentialStore<T, K extends CredentialKind = CredentialKind> implements CredentialStore<T, K> {
  readonly backend = "system" as const;
  readonly system: SystemCredentialBackend;
  private readonly ids: string[];

  constructor(readonly kind: K, private readonly Entry: KeyringEntryConstructor, ids: string[] = [], system: SystemCredentialBackend = requireBackend(process.platform)) {
    this.system = system;
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
    catch { throw operationError(this.system, "read"); }
    if (serialized === null) return undefined;
    const envelope = decodeEnvelope<T, K>(this.system, serialized, this.kind);
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
      if (existing !== null) revision = decodeEnvelope<T, K>(this.system, existing, this.kind).revision;
      revision += 1;
      entry.setPassword(encodeEnvelope(this.system, this.kind, revision, structuredClone(value)));
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw operationError(this.system, "write");
    }
    return this.ref(ref.id, revision);
  }

  delete(ref: CredentialRef<K>): boolean {
    this.check(ref);
    try { return this.entry(ref.id).deleteCredential(); }
    catch { throw operationError(this.system, "delete"); }
  }

  list(): CredentialRef<K>[] {
    return this.ids.map((id) => this.ref(id));
  }

  status(): CredentialBackendStatus {
    return {
      backend: this.backend,
      available: true,
      secure: true,
      location: this.system.name,
      entries: this.ids.length,
      reason: "selected only by explicit verified references",
    };
  }
}

/** Loads the native module for the platform's backend; throws `backend-unavailable` where there is none or it cannot load. */
export async function createSystemCredentialStore<T, K extends CredentialKind>(kind: K, ids: string[] = [], options: SystemCredentialStoreOptions = {}): Promise<SystemCredentialStore<T, K>> {
  const backend = requireBackend(options.platform ?? process.platform);
  const keyring = await loadKeyring(backend, options);
  assertServiceReachable(backend, keyring);
  return new SystemCredentialStore(kind, keyring.Entry, ids, backend);
}

/**
 * Reports whether the platform's backend answers. Without `writeTest` it loads the module and
 * reads one random, nonexistent id, which proves the service is reachable (a missing D-Bus
 * session or locked keychain fails here) without writing anything. With `writeTest` it also
 * writes, reads back and deletes a random canary.
 */
export async function probeSystemCredentialStore(writeTest = false, options: SystemCredentialStoreOptions = {}): Promise<SystemCredentialProbeResult> {
  const testedAt = new Date().toISOString();
  const platform = options.platform ?? process.platform;
  const backend = systemCredentialBackend(platform);
  const unavailable = (error: unknown, fallback: string, checks: SystemCredentialProbeResult["checks"], base?: CredentialBackendStatus): SystemCredentialProbeResult => {
    const message = error instanceof CredentialStoreError ? error.message : fallback;
    const reason = backend?.requirement && checks.module && !message.includes(backend.requirement) ? `${message} (${backend.requirement})` : message;
    return {
      backend,
      status: { ...(base ?? { backend: "system", secure: true, entries: 0, location: backend?.name ?? "system credential store" }), available: false, reason },
      checks,
      testedAt,
    };
  };
  if (!backend) return unavailable(new CredentialStoreError("backend-unavailable", `No system credential backend is available on ${platform}; Xiu supports Windows Credential Manager, macOS Keychain and Linux Secret Service`), "", { module: false });
  let keyring: Keyring;
  try { keyring = await loadKeyring(backend, options); }
  catch (error) { return unavailable(error, `${backend.name} probe failed`, { module: false }); }
  try { assertServiceReachable(backend, keyring); }
  catch (error) { return unavailable(error, `${backend.name} is not reachable`, { module: true, lookup: false }); }
  const store = new SystemCredentialStore<string, "provider-api-key">("provider-api-key", keyring.Entry, [], backend);
  const id = `probe:${randomUUID()}`;
  const ref = store.ref(id);
  try {
    if (store.has(ref)) throw new CredentialStoreError("operation-failed", `${store.system.name} probe target already exists`);
  } catch (error) {
    // A read that fails here means the service itself does not answer (no D-Bus session, locked keychain, policy).
    const cause = error instanceof CredentialStoreError && error.message.endsWith("probe target already exists") ? error : new CredentialStoreError("operation-failed", `${store.system.name} lookup failed`);
    return unavailable(cause, `${store.system.name} lookup failed`, { module: true, lookup: false }, store.status());
  }
  if (!writeTest) return { backend, status: store.status(), checks: { module: true, lookup: true }, testedAt };

  const secret = randomBytes(32).toString("base64url");
  let written = false;
  let write = false;
  let read = false;
  let deleted = false;
  try {
    store.set(ref, secret);
    written = true;
    write = true;
    const restored = store.get(ref);
    read = typeof restored === "string" && timingSafeEqual(Buffer.from(restored), Buffer.from(secret));
    if (!read) throw operationError(store.system, "round-trip verification");
    deleted = store.delete(ref);
    written = false;
    if (!deleted || store.has(ref)) throw operationError(store.system, "cleanup verification");
    return { backend, status: store.status(), checks: { module: true, lookup: true, write, read, delete: deleted }, testedAt };
  } catch (error) {
    return unavailable(error, `${store.system.name} canary probe failed`, { module: true, lookup: true, write, read, delete: deleted }, store.status());
  } finally {
    if (written) {
      try { store.delete(ref); }
      catch { /* Exact unique canary cleanup failed; the status above remains unavailable. */ }
    }
  }
}
