import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { compareStartTimes, currentProcessStartedAt, processStartTime } from "./process-identity.js";

/** When this process started, recorded in the lock so a later reader can tell this PID from one the OS reused. */

export const PROVIDER_CONFIGURATION_VERSION = 5;
export const PROVIDER_CONFIGURATION_COMPATIBILITY_NOTICE = "Provider schema v5 requires matching upgraded CLI and desktop clients. Close all other Xiu clients before recovery; older clients do not honor this version's write lock.";
const MAX_BYTES = 4 * 1024 * 1024;
const BACKUP_ID = /^[a-f0-9-]{36}$/;

export interface ProviderConfigurationBackup {
  id: string;
  sourceVersion: number | null;
  reason: "upgrade" | "recovery";
  createdAt: string;
}
export interface ProviderConfigurationDiagnostics {
  supportedVersion: 5;
  sourceVersion: number | null;
  state: "missing" | "current" | "upgrade-required" | "unsupported" | "invalid" | "blocked";
  backups: ProviderConfigurationBackup[];
  issues: string[];
  compatibilityNotice: string;
}
export interface ProviderConfigurationRecoveryPreview {
  /** Reserved backupId "current" keeps settings unchanged and clears a dead-owner lock. */
  action: "restore-backup" | "keep-current";
  token: string;
  backupId: string;
  sourceVersion: number;
  currentVersion: number | null;
  expiresAt: string;
  warnings: string[];
}
export class ProviderConfigurationError extends Error {
  constructor(readonly code: string, message: string, readonly replacementMayHaveCommitted = false) { super(message); this.name = "ProviderConfigurationError"; }
}
function failure(code: string): ProviderConfigurationError {
  const messages: Record<string, string> = {
    changed: "Provider settings changed in another client. Close other CLI/desktop clients, reload, and inspect configuration diagnostics before retrying.",
    busy: "Provider settings have an active or interrupted write lock. Close other clients; use explicit backup recovery for an interrupted write. No settings were replaced.",
    unsafe: "Provider configuration storage is not a protected regular file/directory. Close other clients and inspect storage before retrying.",
    "size-limit": "Provider configuration exceeds the 4 MiB safety limit. No replacement was attempted.",
    backup: "Provider configuration backup is missing, corrupt, or unverifiable. No settings were replaced.",
    unsupported: "Unsupported provider configuration format. Upgrade CLI and desktop together; the settings were left unchanged.",
    invalid: "Provider configuration is invalid. It was left unchanged; use explicit backup recovery if needed.",
    confirmation: "Provider recovery requires a fresh preview and explicit confirmation.",
    restart: "Provider settings were restored. Restart this client before using or changing providers.",
    io: "Provider configuration storage operation failed. Reload and inspect configuration diagnostics before retrying; existing backups were retained.",
  };
  return new ProviderConfigurationError(code, messages[code] ?? messages.io!);
}

/** A storage check that already failed as "unsafe" stays "unsafe"; other failures map to `code`. */
function unsafeOr(error: unknown, code: string): ProviderConfigurationError {
  return error instanceof ProviderConfigurationError && error.code === "unsafe" ? error : failure(code);
}
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function revision(value: Buffer, stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${digest(value)}`; }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function sourceVersion(raw: Buffer): number | null {
  try { const parsed: unknown = JSON.parse(raw.toString("utf8")); const version = (parsed as { version?: unknown } | null)?.version; return typeof version === "number" && Number.isSafeInteger(version) ? version : null; }
  catch { return null; }
}
export interface ProviderConfigurationSnapshot { bytes: Buffer; revision: string; sourceVersion: number | null }
interface BackupEnvelope extends ProviderConfigurationBackup { version: 1; sha256: string; payload: string }
interface RecoveryIntent { preview: ProviderConfigurationRecoveryPreview; current: ProviderConfigurationSnapshot | undefined; backupRevision?: string; lockRevision?: string }

/** Only this module handles backup bytes. Diagnostics never return paths or settings. */
export class ProviderConfigurationStorage {
  private readonly directory: string;
  private readonly lock: string;
  private pending?: RecoveryIntent;
  private readonly transactionContext = new AsyncLocalStorage<{ active: boolean }>();
  constructor(private readonly filename: string) {
    this.directory = `${filename}.recovery`;
    this.lock = path.join(this.directory, "write.lock");
  }

  private async regularFile(filename: string, maximum = MAX_BYTES, privateFile = false): Promise<ProviderConfigurationSnapshot | undefined> {
    let stat: Stats;
    try { stat = await fs.lstat(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    // On Windows the user profile directory's default permissions protect
    // these files, as they do for other tools' credential files; no ACL is
    // inspected or changed. POSIX private objects must stay owner-only.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (privateFile && (stat.mode & 0o077) !== 0)))) throw failure("unsafe");
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!sameFile(stat, opened)) throw failure("changed");
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw failure("changed"); offset += read.bytesRead; }
      if (!sameFile(opened, await handle.stat()) || !sameFile(opened, await fs.lstat(filename))) throw failure("changed");
      return { bytes, revision: revision(bytes, opened), sourceVersion: sourceVersion(bytes) };
    } finally { await handle.close(); }
  }

  async read(): Promise<ProviderConfigurationSnapshot | undefined> {
    try { return await this.regularFile(this.filename); }
    catch (error) { throw error instanceof ProviderConfigurationError ? error : failure("io"); }
  }

  private async privateDirectory(create: boolean): Promise<boolean> {
    if (create) {
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      try { await fs.mkdir(this.directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    let stat: Stats;
    try { stat = await fs.lstat(this.directory); }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw failure("unsafe");
    return true;
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return; // Node cannot fsync Windows directories.
    const handle = await fs.open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async writeExclusive(filename: string, bytes: Buffer): Promise<void> {
    const handle = await fs.open(filename, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }
  async assertCurrent(expected: ProviderConfigurationSnapshot | undefined): Promise<void> {
    if ((await this.read())?.revision !== expected?.revision) throw failure("changed");
  }

  private async withLock<T>(run: () => Promise<T>, recoverLockRevision?: string, beforeTakeover?: () => Promise<void>): Promise<T> {
    await this.privateDirectory(true);
    const recoveryLock = path.join(this.directory, "recovery.lock");
    let recoveryOwned = false;
    let owned = false;
    try {
      if (recoverLockRevision) {
        try { await this.writeExclusive(recoveryLock, Buffer.from("recovery\n")); recoveryOwned = true; }
        catch (error) { throw unsafeOr(error, "busy"); }
        const stale = await this.regularFile(this.lock, 1024, true);
        if (stale?.revision !== recoverLockRevision || !(await this.deadLock(stale.bytes))) throw failure("busy");
        // Reject a stale preview before consuming even its write-lock marker.
        await beforeTakeover?.();
        await fs.unlink(this.lock);
      } else if (await this.regularFile(recoveryLock, 1024, true)) throw failure("busy");
      try { await this.writeExclusive(this.lock, Buffer.from(JSON.stringify({ pid: process.pid, nonce: randomUUID(), startedAt: currentProcessStartedAt() }))); owned = true; }
      catch (error) { throw unsafeOr(error, "busy"); }
      if (!recoveryOwned && await this.regularFile(recoveryLock, 1024, true)) throw failure("busy");
      return await run();
    } finally {
      try { if (owned) await fs.unlink(this.lock); }
      finally { if (recoveryOwned) await fs.unlink(recoveryLock); }
    }
  }
  /**
   * A write lock is dead only when its owner is proven gone: the PID no longer
   * exists, or it exists but belongs to a process that started at a different
   * time than the owner recorded (the OS reused the number). Locks written by
   * older versions carry no start time and are judged by the PID alone.
   */
  private async deadLock(bytes: Buffer): Promise<boolean> {
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as { pid?: number; nonce?: string; startedAt?: string };
      if (!Number.isSafeInteger(parsed.pid) || parsed.pid! <= 0 || typeof parsed.nonce !== "string") return false;
      try { process.kill(parsed.pid!, 0); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (typeof parsed.startedAt !== "string") return false;
      return compareStartTimes(parsed.startedAt, await processStartTime(parsed.pid!)) === "mismatch";
    } catch { return false; }
  }

  private async backup(snapshot: ProviderConfigurationSnapshot, reason: "upgrade" | "recovery"): Promise<void> {
    const envelope: BackupEnvelope = { version: 1, id: randomUUID(), sourceVersion: snapshot.sourceVersion, reason, createdAt: new Date().toISOString(), sha256: digest(snapshot.bytes), payload: snapshot.bytes.toString("base64") };
    await this.writeExclusive(path.join(this.directory, `${envelope.id}.json`), Buffer.from(`${JSON.stringify(envelope)}\n`));
    const verified = await this.readBackup(envelope.id);
    if (!verified.bytes.equals(snapshot.bytes)) throw failure("backup");
    await this.syncDirectory(this.directory);
    // The backup directory may itself be new. Persist its parent entry before
    // replacing the only original settings file.
    await this.syncDirectory(path.dirname(this.filename));
  }
  private async readBackup(id: string): Promise<{ metadata: ProviderConfigurationBackup; bytes: Buffer; revision: string }> {
    if (!BACKUP_ID.test(id)) throw failure("backup");
    await this.privateDirectory(false);
    const snapshot = await this.regularFile(path.join(this.directory, `${id}.json`), MAX_BYTES * 2, true);
    if (!snapshot) throw failure("backup");
    try {
      const item = JSON.parse(snapshot.bytes.toString("utf8")) as BackupEnvelope;
      if (item.version !== 1 || item.id !== id || !["upgrade", "recovery"].includes(item.reason) || typeof item.createdAt !== "string" || item.createdAt.length !== 24 || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt || typeof item.payload !== "string") throw failure("backup");
      const bytes = Buffer.from(item.payload, "base64");
      if (bytes.length > MAX_BYTES || bytes.toString("base64") !== item.payload || digest(bytes) !== item.sha256 || sourceVersion(bytes) !== item.sourceVersion) throw failure("backup");
      return { metadata: { id, sourceVersion: item.sourceVersion, reason: item.reason, createdAt: item.createdAt }, bytes, revision: snapshot.revision };
    } catch { throw failure("backup"); }
  }
  private async replace(expected: ProviderConfigurationSnapshot | undefined, bytes: Buffer): Promise<ProviderConfigurationSnapshot> {
    if (bytes.length > MAX_BYTES) throw failure("size-limit");
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    let replacementAttempted = false;
    try {
      await this.writeExclusive(temporary, bytes);
      await this.assertCurrent(expected);
      replacementAttempted = true;
      await fs.rename(temporary, this.filename);
      await this.syncDirectory(path.dirname(this.filename));
      const written = await this.read();
      if (!written?.bytes.equals(bytes)) throw failure("changed");
      return written;
    } catch (error) {
      if (replacementAttempted) throw new ProviderConfigurationError("write-unverified", "Provider settings replacement may have completed but could not be verified. Retain credentials and backups; reload and inspect configuration diagnostics before retrying.", true);
      throw error;
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  /** Hold the file lock across credential mutations and every dependent commit. */
  async transaction<T>(expected: ProviderConfigurationSnapshot | undefined, run: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()?.active) return run();
    let operationError: unknown;
    try {
      return await this.withLock(async () => {
        await this.assertCurrent(expected);
        const lease = { active: true };
        try {
          return await this.transactionContext.run(lease, async () => {
            try { return await run(); }
            catch (error) { operationError = error; throw error; }
          });
        } finally { lease.active = false; }
      });
    } catch (error) { throw error === operationError || error instanceof ProviderConfigurationError ? error : failure("io"); }
  }

  async commit(expected: ProviderConfigurationSnapshot | undefined, bytes: Buffer, upgrade = false): Promise<ProviderConfigurationSnapshot> {
    if (bytes.length > MAX_BYTES) throw failure("size-limit");
    const commit = async () => {
      await this.assertCurrent(expected);
      if (upgrade) { if (!expected) throw failure("changed"); await this.backup(expected, "upgrade"); }
      return this.replace(expected, bytes);
    };
    try { return this.transactionContext.getStore()?.active ? await commit() : await this.withLock(commit); }
    catch (error) { throw error instanceof ProviderConfigurationError ? error : failure("io"); }
  }

  async diagnostics(validate: (bytes: Buffer) => void): Promise<ProviderConfigurationDiagnostics> {
    const result: ProviderConfigurationDiagnostics = { supportedVersion: 5, sourceVersion: null, state: "missing", backups: [], issues: [], compatibilityNotice: PROVIDER_CONFIGURATION_COMPATIBILITY_NOTICE };
    try {
      const current = await this.read();
      if (current) {
        result.sourceVersion = current.sourceVersion;
        result.state = current.sourceVersion !== null && (current.sourceVersion > 5 || current.sourceVersion < 1) ? "unsupported" : "invalid";
        if (current.sourceVersion !== null && current.sourceVersion >= 1 && current.sourceVersion <= 5) {
          try { validate(current.bytes); result.state = current.sourceVersion === 5 ? "current" : "upgrade-required"; } catch { result.issues.push("invalid-settings"); }
        }
      }
      if (await this.privateDirectory(false)) {
        const names = await fs.readdir(this.directory);
        if (names.includes("write.lock") || names.includes("recovery.lock")) { result.state = "blocked"; result.issues.push("active-or-interrupted-write"); }
        if (names.includes("write.lock") && !names.includes("recovery.lock") && (!current || (current.sourceVersion !== null && current.sourceVersion >= 1 && current.sourceVersion <= 5))) {
          try { if (current) validate(current.bytes); const lock = await this.regularFile(this.lock, 1024, true); if (lock && await this.deadLock(lock.bytes)) result.issues.push("interrupted-write-can-keep-current"); }
          catch { /* Only positively verified stale locks are recoverable. */ }
        }
        if (names.some((name) => name.endsWith(".tmp"))) result.issues.push("interrupted-temporary-write-retained");
        for (const name of names.filter((name) => name.endsWith(".json")).sort().slice(0, 100)) {
          try { const backup = await this.readBackup(name.slice(0, -5)); validate(backup.bytes); result.backups.push(backup.metadata); }
          catch { result.issues.push("invalid-backup"); }
        }
        if (names.filter((name) => name.endsWith(".json")).length > 100) result.issues.push("backup-list-limit");
      }
    } catch (error) { result.state = "blocked"; result.issues.push(error instanceof ProviderConfigurationError ? error.code : "storage-unavailable"); }
    result.backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    result.issues = [...new Set(result.issues)];
    return result;
  }

  async previewRecovery(backupId: string, validate: (bytes: Buffer) => void): Promise<ProviderConfigurationRecoveryPreview> {
    this.pending = undefined;
    try {
      const keepCurrent = backupId === "current";
      const backup = keepCurrent ? undefined : await this.readBackup(backupId);
      if (backup) validate(backup.bytes);
      const current = await this.read();
      if (current?.sourceVersion !== null && current?.sourceVersion !== undefined && (current.sourceVersion > 5 || current.sourceVersion < 1)) throw failure("unsupported");
      if (keepCurrent && current) validate(current.bytes);
      if (await this.privateDirectory(false) && await this.regularFile(path.join(this.directory, "recovery.lock"), 1024, true)) throw failure("busy");
      const lock = await this.regularFile(this.lock, 1024, true);
      if ((keepCurrent && !lock) || (lock && !(await this.deadLock(lock.bytes)))) throw failure("busy");
      const preview: ProviderConfigurationRecoveryPreview = {
        action: keepCurrent ? "keep-current" : "restore-backup", token: randomUUID(), backupId,
        sourceVersion: keepCurrent ? current?.sourceVersion ?? 5 : backup!.metadata.sourceVersion!,
        currentVersion: current?.sourceVersion ?? null, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        warnings: keepCurrent ? [PROVIDER_CONFIGURATION_COMPATIBILITY_NOTICE,
          "Keep current settings and clear a proven dead-owner write lock. No backup is restored, no credentials are changed, and interrupted temporary files are retained.",
          current ? "Current settings remain byte-for-byte unchanged. Restart after confirming." : "The configuration file is missing and will remain missing. Restart after confirming."]
          : [PROVIDER_CONFIGURATION_COMPATIBILITY_NOTICE,
          "Recovery replaces current settings, including saved legacy credentials and credential references. The displaced file is retained in a protected backup. System credentials are neither restored nor changed, so older references may no longer resolve.",
          "Legacy backups can contain plaintext credentials. Keep these local and private. Restart after recovery; a v5 client will upgrade legacy settings again."] };
      this.pending = { preview, current, backupRevision: backup?.revision, lockRevision: lock?.revision };
      return structuredClone(preview);
    } catch (error) { throw error instanceof ProviderConfigurationError ? error : failure("backup"); }
  }
  async confirmRecovery(token: string, confirmed: boolean, validate: (bytes: Buffer) => void): Promise<{ restoredVersion: number; restartRequired: true }> {
    const intent = this.pending;
    this.pending = undefined;
    if (confirmed !== true || !intent || token !== intent.preview.token || Date.now() > Date.parse(intent.preview.expiresAt)) throw failure("confirmation");
    const checkPreview = async () => {
      await this.assertCurrent(intent.current);
      if (intent.preview.action === "restore-backup") {
        const backup = await this.readBackup(intent.preview.backupId);
        if (backup.revision !== intent.backupRevision) throw failure("changed");
        validate(backup.bytes);
      }
    };
    try {
      return await this.withLock(async () => {
        await checkPreview();
        if (intent.preview.action === "restore-backup") {
          const backup = await this.readBackup(intent.preview.backupId);
          if (backup.revision !== intent.backupRevision) throw failure("changed");
          validate(backup.bytes);
          if (intent.current) await this.backup(intent.current, "recovery");
          await this.replace(intent.current, backup.bytes);
        } else if (intent.current) validate(intent.current.bytes);
        return { restoredVersion: intent.preview.sourceVersion, restartRequired: true };
      }, intent.lockRevision, checkPreview);
    } catch (error) { throw error instanceof ProviderConfigurationError ? error : failure("io"); }
  }
}
