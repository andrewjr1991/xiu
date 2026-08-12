import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./secret-redaction.js";

const BACKGROUND_SCHEMA_VERSION = 1 as const;
const MAX_PREVIEW = 240;

export type BackgroundProcessState = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface BackgroundProcessRecord {
  version: typeof BACKGROUND_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  commandPreview: string;
  state: BackgroundProcessState;
  startedAt: string;
  updatedAt: string;
  pid?: number;
  childPid?: number;
  exitCode?: number | null;
  signal?: string;
  outputBytes: number;
}

export interface BackgroundOutputPage {
  id: string;
  text: string;
  cursor: number;
  nextCursor: number;
  outputBytes: number;
  state: BackgroundProcessState;
}

interface BackgroundRequest {
  version: typeof BACKGROUND_SCHEMA_VERSION;
  recordFile: string;
  outputFile: string;
  cwd: string;
  command: string;
}

let workspace = process.cwd();
let storageRoot = path.join(os.homedir(), ".xiu", "background");

function workspaceIdentity(value: string): string {
  return createHash("sha256").update(path.resolve(value).replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 24);
}

function workspaceDirectory(): string { return path.join(storageRoot, workspaceIdentity(workspace)); }
function recordFile(id: string): string { return path.join(workspaceDirectory(), `${id}.json`); }
function outputFile(id: string): string { return path.join(workspaceDirectory(), `${id}.log`); }

function atomicWrite(file: string, value: unknown): void {
  ensureSafeDirectory(path.dirname(file));
  const existing = (() => { try { return fs.lstatSync(file); } catch { return undefined; } })();
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`Unsafe background state path: ${file}`);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

function ensureSafeDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe background state directory: ${directory}`);
}

function validRecord(value: unknown): value is BackgroundProcessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<BackgroundProcessRecord>;
  return item.version === BACKGROUND_SCHEMA_VERSION
    && typeof item.id === "string" && /^[a-f0-9]{12}$/.test(item.id)
    && typeof item.workspaceId === "string"
    && typeof item.commandPreview === "string" && item.commandPreview.length <= MAX_PREVIEW
    && ["starting", "running", "completed", "failed", "cancelled", "interrupted"].includes(String(item.state))
    && typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt))
    && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt))
    && Number.isSafeInteger(item.outputBytes) && item.outputBytes! >= 0
    && (item.pid === undefined || (Number.isSafeInteger(item.pid) && item.pid! > 0));
}

function readRecord(file: string): BackgroundProcessRecord | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return validRecord(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function refresh(record: BackgroundProcessRecord): BackgroundProcessRecord {
  const withinStartupGrace = record.state === "starting" && Date.now() - Date.parse(record.startedAt) < 10_000;
  if ((record.state === "starting" || record.state === "running") && !withinStartupGrace && !processAlive(record.pid)) {
    const next = { ...record, state: "interrupted" as const, updatedAt: new Date().toISOString(), outputBytes: outputSize(record.id) };
    atomicWrite(recordFile(record.id), next);
    return next;
  }
  const size = outputSize(record.id);
  return size === record.outputBytes ? record : { ...record, outputBytes: size };
}

function outputSize(id: string): number {
  try {
    const stat = fs.lstatSync(outputFile(id));
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
  } catch { return 0; }
}

function workerInvocation(requestFile: string): { program: string; args: string[] } {
  const source = fileURLToPath(new URL("./background-worker.js", import.meta.url));
  if (fs.existsSync(source)) return { program: process.execPath, args: [source, requestFile] };
  const development = fileURLToPath(new URL("./background-worker.ts", import.meta.url));
  return { program: process.execPath, args: ["--import", "tsx", development, requestFile] };
}

export function configureBackgroundWorkspace(cwd: string, root = path.join(os.homedir(), ".xiu", "background")): void {
  workspace = path.resolve(cwd);
  storageRoot = path.resolve(root);
  ensureSafeDirectory(workspaceDirectory());
  const cutoff = Date.now() - 5 * 60_000;
  for (const name of fs.readdirSync(workspaceDirectory()).filter((item) => /^\.[a-f0-9]{12}\.request\.json$/.test(item))) {
    const file = path.join(workspaceDirectory(), name);
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
  }
}

export function startBackgroundProcess(command: string, cwd = workspace): { id: string; pid?: number } {
  if (!command.trim()) throw new Error("Background command cannot be empty.");
  configureBackgroundWorkspace(cwd, storageRoot);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const directory = workspaceDirectory();
  ensureSafeDirectory(directory);
  const requestFile = path.join(directory, `.${id}.request.json`);
  const now = new Date().toISOString();
  const record: BackgroundProcessRecord = {
    version: BACKGROUND_SCHEMA_VERSION,
    id,
    workspaceId: workspaceIdentity(workspace),
    commandPreview: redactSecrets(command).replace(/\s+/g, " ").trim().slice(0, MAX_PREVIEW),
    state: "starting",
    startedAt: now,
    updatedAt: now,
    outputBytes: 0,
  };
  const request: BackgroundRequest = { version: BACKGROUND_SCHEMA_VERSION, recordFile: recordFile(id), outputFile: outputFile(id), cwd: workspace, command };
  atomicWrite(recordFile(id), record);
  fs.writeFileSync(requestFile, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const invocation = workerInvocation(requestFile);
  try {
    const child = spawn(invocation.program, invocation.args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
    const latest = readRecord(recordFile(id));
    if (!latest || latest.state === "starting") {
      record.pid = child.pid;
      record.state = "running";
      record.updatedAt = new Date().toISOString();
      atomicWrite(recordFile(id), record);
    }
    return { id, pid: child.pid };
  } catch (error) {
    try { fs.unlinkSync(requestFile); } catch { /* best effort */ }
    record.state = "failed";
    record.updatedAt = new Date().toISOString();
    atomicWrite(recordFile(id), record);
    throw error;
  }
}

export function listBackgroundProcesses(): Array<{ id: string; pid?: number; command: string; state: BackgroundProcessState; running: boolean; elapsedMs: number; outputBytes: number }> {
  let names: string[];
  try { names = fs.readdirSync(workspaceDirectory()); }
  catch { return []; }
  return names.filter((name) => /^[a-f0-9]{12}\.json$/.test(name))
    .map((name) => readRecord(path.join(workspaceDirectory(), name)))
    .filter((record): record is BackgroundProcessRecord => Boolean(record))
    .map(refresh)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((record) => ({
      id: record.id, pid: record.pid, command: record.commandPreview, state: record.state,
      running: record.state === "starting" || record.state === "running",
      elapsedMs: Math.max(0, Date.now() - Date.parse(record.startedAt)), outputBytes: record.outputBytes,
    }));
}

export function readBackgroundProcessOutput(id: string, cursor = 0, maximumBytes = 40_000): BackgroundOutputPage {
  const record = readRecord(recordFile(id));
  if (!record) throw new Error(`Unknown background process: ${id}`);
  const file = outputFile(id);
  const size = outputSize(id);
  const safeCursor = Math.max(0, Math.min(Number.isSafeInteger(cursor) ? cursor : 0, size));
  const start = Math.max(safeCursor, size - maximumBytes);
  let text = "";
  if (size > start) {
    const descriptor = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally { fs.closeSync(descriptor); }
  }
  return { id, text: text || "No output yet.", cursor: start, nextCursor: size, outputBytes: size, state: refresh(record).state };
}

export function backgroundProcessOutput(id: string): string { return readBackgroundProcessOutput(id).text; }

export async function stopBackgroundProcess(id: string): Promise<void> {
  const record = readRecord(recordFile(id));
  if (!record) throw new Error(`Unknown background process: ${id}`);
  if (!["starting", "running"].includes(record.state)) return;
  if (process.platform === "win32" && record.pid) {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      child.once("exit", () => resolve()); child.once("error", () => resolve());
    });
  } else if (record.pid) {
    try { process.kill(-record.pid, "SIGTERM"); } catch { try { process.kill(record.pid, "SIGTERM"); } catch { /* already gone */ } }
  }
  const next = { ...record, state: "cancelled" as const, updatedAt: new Date().toISOString(), outputBytes: outputSize(id) };
  atomicWrite(recordFile(id), next);
}

/** Explicit test/admin cleanup. Normal Xiu shutdown deliberately does not call this. */
export async function stopAllBackgroundProcesses(): Promise<void> {
  await Promise.all(listBackgroundProcesses().filter((item) => item.running).map((item) => stopBackgroundProcess(item.id)));
}
