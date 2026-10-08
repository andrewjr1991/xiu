import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isSecretField, redactSecrets } from "./secret-redaction.js";
import type { TaskChangeEntry, TaskChangeReport } from "./task-changes.js";

export const TASK_CHANGE_HISTORY_SCHEMA_VERSION = 1 as const;

const RUN_ID = /^[A-Za-z0-9-]{1,160}$/;
const MAX_CHANGES = 500;
const MAX_PREVIEW_BYTES = 16 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_BYTES = 32 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_WARNINGS = 100;
const MAX_LIMITATIONS = 20;

interface TaskChangeHistoryEnvelope {
  schemaVersion: typeof TASK_CHANGE_HISTORY_SCHEMA_VERSION;
  runId: string;
  savedAt: string;
  report: TaskChangeReport;
  /** Dedicated review data, never copied into journals or generic audit logs. */
  diffs?: Array<{ path: string; text: string }>;
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error("Invalid task change history run ID.");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function safeRelativePath(value: unknown, secrets: readonly string[] = []): string {
  if (typeof value !== "string") throw new Error("Task change history contains an unsafe path.");
  const redacted = redactSecrets(value, secrets);
  if (!redacted || redacted.includes("\0") || Buffer.byteLength(redacted, "utf8") > MAX_PATH_BYTES
    || path.isAbsolute(redacted) || path.win32.isAbsolute(redacted) || path.posix.isAbsolute(redacted)) {
    throw new Error("Task change history contains an unsafe path.");
  }
  const normalized = redacted.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".xiu")) {
    throw new Error("Task change history contains an unsafe path.");
  }
  return normalized;
}

function runtimeSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => isSecretField(key) && value)
    .map(([, value]) => value!);
}

function clipUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximum) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--;
  return value.slice(0, low);
}

function boundedText(value: unknown, maximum: number, secrets: readonly string[]): string {
  if (typeof value !== "string") throw new Error("Task change history contains invalid text.");
  return clipUtf8(redactSecrets(value, secrets), maximum);
}

function sanitizeEntry(value: unknown, secrets: readonly string[]): TaskChangeEntry {
  if (!value || typeof value !== "object") throw new Error("Task change history contains an invalid change entry.");
  const item = value as Partial<TaskChangeEntry>;
  if (!(["created", "modified", "deleted", "index-only", "unknown"] as unknown[]).includes(item.kind)
    || item.source !== "unknown" || typeof item.preExisting !== "boolean" || typeof item.staged !== "boolean"
    || !Array.isArray(item.limitations)) {
    throw new Error("Task change history contains an invalid change entry.");
  }
  const limitations = item.limitations.slice(0, MAX_LIMITATIONS).map((entry) => boundedText(entry, 200, secrets));
  const preview = item.preview === undefined ? undefined : boundedText(item.preview, MAX_PREVIEW_BYTES, secrets);
  if (item.stats !== undefined && (!item.stats || !Number.isSafeInteger(item.stats.additions) || item.stats.additions < 0
    || item.stats.additions > 262_144 || !Number.isSafeInteger(item.stats.deletions) || item.stats.deletions < 0
    || item.stats.deletions > 262_144 || typeof item.stats.exact !== "boolean")) throw new Error("Task change history contains invalid statistics.");
  return {
    path: safeRelativePath(item.path, secrets), kind: item.kind as TaskChangeEntry["kind"], source: "unknown",
    preExisting: item.preExisting, staged: item.staged,
    ...(preview ? { preview } : {}), ...(item.stats ? { stats: { additions: item.stats.additions, deletions: item.stats.deletions, exact: item.stats.exact } } : {}), limitations,
  };
}

function sanitizeReport(value: unknown, strict = false): TaskChangeReport {
  if (!value || typeof value !== "object") throw new Error("Task change history contains an invalid report.");
  const report = value as Partial<TaskChangeReport>;
  if (!(["task", "workspace", "staged"] as unknown[]).includes(report.view) || typeof report.git !== "boolean"
    || typeof report.complete !== "boolean" || !Array.isArray(report.changes)
    || !Array.isArray(report.preExisting) || !Array.isArray(report.warnings)) {
    throw new Error("Task change history contains an invalid report.");
  }
  if (strict && (report.changes.length > MAX_CHANGES || report.preExisting.length > MAX_CHANGES || report.warnings.length > MAX_WARNINGS)) {
    throw new Error("Task change history exceeds its item limits.");
  }
  const secrets = runtimeSecrets();
  const changes = report.changes.slice(0, MAX_CHANGES).map((entry) => sanitizeEntry(entry, secrets));
  const preExisting = report.preExisting.slice(0, MAX_CHANGES).map((entry) => safeRelativePath(entry, secrets));
  const warnings = report.warnings.slice(0, MAX_WARNINGS).map((warning) => boundedText(warning, 2_000, secrets));
  if (!strict && report.changes.length > MAX_CHANGES) warnings.push(`history-file-limit: only the first ${MAX_CHANGES} changed files were saved.`);
  return {
    view: report.view as TaskChangeReport["view"], git: report.git,
    ...(typeof report.capturedAt === "string" ? { capturedAt: boundedText(report.capturedAt, 100, secrets) } : {}),
    changes, preExisting, complete: report.complete && report.changes.length <= MAX_CHANGES,
    warnings: [...new Set(warnings)].slice(0, MAX_WARNINGS),
  };
}

async function storageDirectory(workspace: string, create: boolean): Promise<string | undefined> {
  const root = await fs.realpath(workspace);
  const xiu = path.join(root, ".xiu");
  const directory = path.join(xiu, "task-change-history");
  if (create) {
    await fs.mkdir(xiu, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
  for (const candidate of [xiu, directory]) {
    const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe task change history directory.");
    const real = await fs.realpath(candidate);
    if (!samePath(real, candidate)) throw new Error("Unsafe task change history directory.");
  }
  return directory;
}

function historyFile(directory: string, runId: string): string {
  assertRunId(runId);
  return path.join(directory, `${runId}.json`);
}

function serializeBounded(runId: string, report: TaskChangeReport): string {
  const envelope: TaskChangeHistoryEnvelope = {
    schemaVersion: TASK_CHANGE_HISTORY_SCHEMA_VERSION,
    runId,
    savedAt: new Date().toISOString(),
    report: sanitizeReport(report),
  };
  let serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_BYTES) {
    let index = envelope.report.changes.length - 1;
    while (index >= 0 && Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_BYTES) {
      for (let count = 0; count < 25 && index >= 0; count++, index--) {
        delete envelope.report.changes[index]!.preview;
        if (!envelope.report.changes[index]!.limitations.includes("history-size-limit")) envelope.report.changes[index]!.limitations.push("history-size-limit");
      }
      envelope.report.complete = false;
      serialized = `${JSON.stringify(envelope)}\n`;
    }
    envelope.report.warnings = [...new Set([...envelope.report.warnings, "history-size-limit: some previews were omitted to keep the saved snapshot bounded."])].slice(0, MAX_WARNINGS);
    serialized = `${JSON.stringify(envelope)}\n`;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_BYTES) throw new Error("Task change history exceeds the 1 MiB storage limit.");
  const diffs: NonNullable<TaskChangeHistoryEnvelope["diffs"]> = [];
  let remaining = MAX_REVIEW_BYTES - 64 * 1024;
  const secrets = runtimeSecrets();
  for (const entry of envelope.report.changes) {
    const original = report.changes.find(change => change.path === entry.path)?.fullDiff;
    if (original === undefined) continue;
    const text = redactSecrets(original, secrets);
    const size = Buffer.byteLength(JSON.stringify({ path: entry.path, text }), "utf8") + 1;
    if (Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES || size > remaining) {
      entry.limitations.push("full-diff-size-limit");
      continue;
    }
    remaining -= size;
    diffs.push({ path: entry.path, text });
  }
  if (diffs.length) envelope.diffs = diffs;
  serialized = `${JSON.stringify(envelope)}\n`;
  return serialized;
}

/** Persist only a bounded, redacted TaskChangeReport. TaskChangeSnapshot must never be passed here. */
export async function saveTaskChangeHistory(workspace: string, runId: string, report: TaskChangeReport): Promise<void> {
  assertRunId(runId);
  const directory = (await storageDirectory(workspace, true))!;
  const file = historyFile(directory, runId);
  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe task change history file.");
  const temporary = path.join(directory, `.${runId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, serializeBounded(runId, report), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function loadTaskChangeHistory(workspace: string, runId: string): Promise<TaskChangeReport | undefined> {
  assertRunId(runId);
  const directory = await storageDirectory(workspace, false);
  if (!directory) return undefined;
  const file = historyFile(directory, runId);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HISTORY_BYTES + MAX_REVIEW_BYTES) throw new Error("Unsafe or oversized task change history file.");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<TaskChangeHistoryEnvelope>;
  if (parsed.schemaVersion !== TASK_CHANGE_HISTORY_SCHEMA_VERSION || parsed.runId !== runId || typeof parsed.savedAt !== "string") {
    throw new Error("Unsupported or corrupt task change history file.");
  }
  const report = sanitizeReport(parsed.report, true);
  if (parsed.diffs !== undefined) {
    if (!Array.isArray(parsed.diffs) || parsed.diffs.length > MAX_CHANGES) throw new Error("Invalid full diff storage.");
    const seen = new Set<string>();
    for (const item of parsed.diffs) {
      const file = safeRelativePath(item?.path);
      if (seen.has(file) || typeof item.text !== "string" || Buffer.byteLength(item.text, "utf8") > MAX_DIFF_BYTES) throw new Error("Invalid full diff storage.");
      seen.add(file);
      const entry = report.changes.find(change => change.path === file);
      if (!entry) throw new Error("Unattributed full diff storage.");
      entry.fullDiff = redactSecrets(item.text, runtimeSecrets());
    }
  }
  return report;
}

export async function deleteTaskChangeHistory(workspace: string, runId: string): Promise<boolean> {
  assertRunId(runId);
  const directory = await storageDirectory(workspace, false);
  if (!directory) return false;
  const file = historyFile(directory, runId);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe task change history file.");
  await fs.unlink(file);
  return true;
}
