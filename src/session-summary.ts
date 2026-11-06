import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionListItem } from "./session.js";
import { assertSessionStorageParents } from "./session-storage.js";

const MAX_SUMMARY_BYTES = 64 * 1024;
// Validation semantics changed: old caches cannot attest the saved-state damage count.
const SUMMARY_VERSION = 2;

function stamp(stat: Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs]);
}

async function regularSource(file: string): Promise<Stats> {
  await assertSessionStorageParents(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe session summary source.");
  return stat;
}

export interface SessionSummaryStorage {
  files: number;
  bytes: number;
  missing: number;
  unsafe: number;
  unreadable: Array<{ reason: string }>;
}

/** Metadata only, for caches attached to the supplied readable logs. Never opens a cache. */
export async function inspectSessionSummaryStorage(files: readonly string[]): Promise<SessionSummaryStorage> {
  const result: SessionSummaryStorage = { files: 0, bytes: 0, missing: 0, unsafe: 0, unreadable: [] };
  for (const file of files) {
    try {
      await regularSource(file);
      const stat = await fs.lstat(`${file}.summary.json`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) result.missing++;
      else if (!stat.isFile() || stat.isSymbolicLink()) result.unsafe++;
      else { result.files++; result.bytes += stat.size; }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      result.unreadable.push({ reason: typeof code === "string" && code ? code : "unreadable" });
    }
  }
  return result;
}

/** Display acceleration only. Restore and recovery must read original evidence. */
export async function readSessionSummary(file: string, source: Stats): Promise<SessionListItem | undefined> {
  if (!source.isFile()) return undefined;
  try {
    if (stamp(await regularSource(file)) !== stamp(source)) return undefined;
    const entry = await fs.lstat(`${file}.summary.json`);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SUMMARY_BYTES) return undefined;
    // A regular cache can be replaced after lstat; never wait for a FIFO writer.
    const handle = await fs.open(`${file}.summary.json`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SUMMARY_BYTES) return undefined;
      const current = await fs.lstat(`${file}.summary.json`);
      if (!current.isFile() || current.isSymbolicLink()
        || stamp(entry) !== stamp(stat) || stamp(current) !== stamp(stat)) return undefined;
      if (stamp(await regularSource(file)) !== stamp(source)) return undefined;
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== stat.size) return undefined;
      // A cache modified or replaced during the bounded read cannot attest a
      // stable snapshot, even if its saved source stamp still matches the log.
      if (stamp(await handle.stat()) !== stamp(stat)
        || stamp(await fs.lstat(`${file}.summary.json`)) !== stamp(stat)) return undefined;
      const value = JSON.parse(bytes.subarray(0, length).toString("utf8")) as Record<string, unknown> | null;
      if (!value || value.version !== SUMMARY_VERSION || value.source !== stamp(source)) return undefined;
      const item = value.item as Record<string, unknown> | null;
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      for (const key of ["createdAt", "updatedAt", "firstTask"]) {
        if (typeof item[key] !== "string" || (item[key] as string).length > 32_768) return undefined;
      }
      for (const key of ["model", "providerId"]) {
        if (item[key] !== undefined && (typeof item[key] !== "string" || (item[key] as string).length > 2048)) return undefined;
      }
      if (item.damagedLines !== undefined && (!Number.isSafeInteger(item.damagedLines) || Number(item.damagedLines) < 0)) return undefined;
      if (stamp(await regularSource(file)) !== stamp(source)) return undefined;
      return {
        id: path.basename(file, ".jsonl"), file, size: source.size,
        createdAt: item.createdAt as string, updatedAt: item.updatedAt as string, firstTask: item.firstTask as string,
        ...(typeof item.model === "string" ? { model: item.model } : {}),
        ...(typeof item.providerId === "string" ? { providerId: item.providerId } : {}),
        ...(typeof item.damagedLines === "number" ? { damagedLines: item.damagedLines } : {}),
      };
    } finally { await handle.close(); }
  } catch { return undefined; /* Missing, stale or corrupt acceleration data is rebuilt from the log. */ }
}

/** Called only from a writer path, never from doctor or a listing operation. */
export async function writeSessionSummary(file: string, build: (source: Stats) => Promise<SessionListItem>): Promise<boolean> {
  const source = await regularSource(file);
  const item = await build(source);
  const serialized = JSON.stringify({ version: SUMMARY_VERSION, source: stamp(source), item: {
    createdAt: item.createdAt, updatedAt: item.updatedAt, firstTask: item.firstTask,
    model: item.model, providerId: item.providerId, damagedLines: item.damagedLines,
  } });
  if (Buffer.byteLength(serialized) > MAX_SUMMARY_BYTES || stamp(await regularSource(file)) !== stamp(source)) return false;
  const target = `${file}.summary.json`;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Recheck the source after writing. A concurrent append makes the cache unusable.
    if (stamp(await regularSource(file)) !== stamp(source)) return false;
    await fs.rename(temporary, target);
    return true;
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
