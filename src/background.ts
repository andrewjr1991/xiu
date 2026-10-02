import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { BACKGROUND_BOOTSTRAP_SOURCE } from "./background-bootstrap.js";
import { redactSecrets } from "./secret-redaction.js";

const BACKGROUND_SCHEMA_VERSION = 1 as const;
const MAX_PREVIEW = 240;
const FAILURE_STAGES = new Set(["bootstrap", "worker", "shell", "output", "state-write", "worker-exit", "stop"]);
const FAILURE_CODES = new Set(["UNKNOWN", "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOSPC", "EMFILE", "EAGAIN", "ENOMEM", "EBUSY", "EIO", "MISSING_TERMINAL", "STOP_TIMEOUT", "STOP_UNCONFIRMED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_INVALID_PACKAGE_CONFIG", "ERR_UNSUPPORTED_ESM_URL_SCHEME", "ERR_DLOPEN_FAILED"]);

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
  failure?: { stage: "bootstrap" | "worker" | "shell" | "output" | "state-write" | "worker-exit" | "stop"; code: string };
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
let workerProgram: string | undefined;
let workerSource: string | undefined;
export function configureBackgroundRuntime(program?: string, source?: string): void { workerProgram = program; workerSource = source; }

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

function validFailure(value: unknown): value is NonNullable<BackgroundProcessRecord["failure"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as NonNullable<BackgroundProcessRecord["failure"]>;
  return Object.keys(failure).length === 2 && FAILURE_STAGES.has(failure.stage) && FAILURE_CODES.has(failure.code);
}
function readFailure(id: string): BackgroundProcessRecord["failure"] {
  try {
    const file = recordFile(id).replace(/\.json$/, ".failure.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) return undefined;
    const failure: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return validFailure(failure) ? failure : undefined;
  } catch { return undefined; }
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
    && (item.failure === undefined || validFailure(item.failure))
    && (item.pid === undefined || (Number.isSafeInteger(item.pid) && item.pid! > 0))
    && (item.childPid === undefined || (Number.isSafeInteger(item.childPid) && item.childPid! > 0));
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

function backgroundRecordAlive(record: BackgroundProcessRecord): boolean {
  return knownProcessTargets(record).some(processAlive);
}

function knownPids(record: BackgroundProcessRecord): number[] {
  return [...new Set([record.pid, record.childPid].filter((pid): pid is number => pid !== undefined))];
}
function knownProcessTargets(record: BackgroundProcessRecord): number[] {
  return [...knownPids(record), ...(process.platform !== "win32" && record.pid ? [-record.pid] : [])];
}
async function waitForProcessesExit(pids: number[], attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (pids.every((pid) => !processAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !processAlive(pid));
}

function refresh(record: BackgroundProcessRecord): BackgroundProcessRecord {
  const age = Date.now() - Date.parse(record.state === "starting" ? record.startedAt : record.updatedAt);
  // Process creation and worker startup can be delayed substantially on loaded
  // Windows hosts. Keep the record recoverable during that bounded handoff
  // instead of prematurely converting a live launch into "interrupted".
  const withinHandoffGrace = (record.state === "starting" && age < 30_000) || (record.state === "running" && age < 10_000);
  if ((record.state === "starting" || record.state === "running") && !withinHandoffGrace && !backgroundRecordAlive(record)) {
    // The worker can publish its terminal record between the directory scan and
    // this liveness check. Re-read after observing the worker exit so a stale
    // in-memory "running" snapshot can never overwrite completed evidence.
    const latest = readRecord(recordFile(record.id));
    if (latest && (latest.state !== record.state || latest.updatedAt !== record.updatedAt || latest.pid !== record.pid)) return refresh(latest);
    const failure = readFailure(record.id);
    const next = { ...record, state: "interrupted" as const, updatedAt: new Date().toISOString(), outputBytes: outputSize(record.id), ...(failure ? { failure } : {}) };
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

function workerInvocation(requestFile: string, bootstrapFile: string): { program: string; args: string[] } {
  if (process.versions.electron && !workerProgram) throw new Error("XIU_NODE_NOT_FOUND: Background commands require a local Node.js runtime.");
  const source = (workerSource ?? fileURLToPath(new URL(process.versions.electron ? "./background-worker.mjs" : "./background-worker.js", import.meta.url))).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (workerSource || fs.existsSync(source)) return { program: workerProgram ?? process.execPath, args: [bootstrapFile, requestFile, pathToFileURL(source).href] };
  const development = new URL("./background-worker.ts", import.meta.url).href;
  // Resolve from this installation, never from the user's current directory.
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { program: workerProgram ?? process.execPath, args: [bootstrapFile, requestFile, development, loader] };
}

export function configureBackgroundWorkspace(cwd: string, root = path.join(os.homedir(), ".xiu", "background")): void {
  workspace = path.resolve(cwd);
  storageRoot = path.resolve(root);
  ensureSafeDirectory(workspaceDirectory());
  const cutoff = Date.now() - 5 * 60_000;
  for (const name of fs.readdirSync(workspaceDirectory()).filter((item) => /^\.[a-f0-9]{12}\.(?:request\.json|bootstrap\.cjs)$/.test(item))) {
    const file = path.join(workspaceDirectory(), name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (error) {
      // A worker or another manager can remove a launch artifact after this
      // scan's readdir or lstat. Only an already-missing entry is harmless.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function startBackgroundProcess(command: string, cwd = workspace): { id: string; pid?: number } {
  if (!command.trim()) throw new Error("Background command cannot be empty.");
  configureBackgroundWorkspace(cwd, storageRoot);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const directory = workspaceDirectory();
  ensureSafeDirectory(directory);
  const requestFile = path.join(directory, `.${id}.request.json`);
  const bootstrapFile = path.join(directory, `.${id}.bootstrap.cjs`);
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
  const invocation = workerInvocation(requestFile, bootstrapFile);
  atomicWrite(recordFile(id), record);
  fs.writeFileSync(requestFile, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const failLaunch = (error: unknown): void => {
    for (const file of [requestFile, bootstrapFile]) try { fs.unlinkSync(file); } catch { /* best effort */ }
    // Capture paths now; another foreground workspace can be selected before
    // spawn's asynchronous error event arrives.
    const current = readRecord(request.recordFile);
    if (!current || current.state !== "starting") return;
    const code = (error as NodeJS.ErrnoException)?.code;
    const safeCode = ["ENOENT", "EACCES", "EPERM", "EAGAIN", "ENOMEM"].includes(code ?? "") ? code! : "UNKNOWN";
    atomicWrite(request.recordFile, { ...current, state: "failed", updatedAt: new Date().toISOString(), failure: { stage: "bootstrap", code: safeCode } });
  };
  try {
    fs.writeFileSync(bootstrapFile, BACKGROUND_BOOTSTRAP_SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const child = spawn(invocation.program, invocation.args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.once("error", (error) => { try { failLaunch(error); } catch { /* storage unavailable; don't crash the foreground */ } });
    child.unref();
    // The worker exclusively owns state transitions after spawn. A parent-side
    // write here can race with, and overwrite, the worker's terminal record.
    return { id, pid: child.pid };
  } catch (error) {
    failLaunch(error);
    throw error;
  }
}

export function listBackgroundProcesses(): Array<{ id: string; pid?: number; command: string; state: BackgroundProcessState; running: boolean; elapsedMs: number; outputBytes: number; failure?: BackgroundProcessRecord["failure"] }> {
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
      ...(record.failure ? { failure: record.failure } : {}),
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

async function stopWindowsTree(pid: number): Promise<{ confirmed: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (confirmed: boolean, timedOut = false): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ confirmed, timedOut });
    };
    try {
      const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      child.once("exit", (code) => finish(code === 0));
      child.once("error", () => finish(false));
      timer = setTimeout(() => {
        // Only stop our own cleanup helper. Its timeout is not evidence that
        // the requested process tree stopped, even if it exits afterward.
        finish(false, true);
        try { child.kill("SIGKILL"); } catch { /* still unconfirmed */ }
        child.unref();
      }, 2_000);
    } catch { finish(false); }
  });
}

export async function stopBackgroundProcess(id: string): Promise<void> {
  const file = recordFile(id);
  const record = readRecord(file);
  if (!record) throw new Error(`Unknown background process: ${id}`);
  if (!["starting", "running"].includes(record.state)) return;
  const pids = knownPids(record);
  const targets = knownProcessTargets(record);
  let confirmed = true;
  let timedOut = false;
  if (targets.some(processAlive)) {
    if (process.platform === "win32") {
      for (const pid of pids) {
        if (!processAlive(pid)) continue;
        const result = await stopWindowsTree(pid);
        confirmed = confirmed && result.confirmed;
        timedOut = timedOut || result.timedOut;
      }
      confirmed = (await waitForProcessesExit(pids)) && confirmed;
    } else {
      let groupSignalled = false;
      if (record.pid) {
        try { process.kill(-record.pid, "SIGTERM"); groupSignalled = true; }
        catch { try { process.kill(record.pid, "SIGTERM"); } catch { /* still unconfirmed */ } }
      }
      if (!(await waitForProcessesExit(targets))) {
        if (record.pid) {
          try { process.kill(-record.pid, "SIGKILL"); groupSignalled = true; }
          catch { /* fall back only to saved owned PIDs, without claiming tree confirmation */ }
        }
        if (!groupSignalled) for (const pid of pids) {
          if (processAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* still unconfirmed */ }
        }
      }
      confirmed = (await waitForProcessesExit(targets)) && groupSignalled;
    }
  }
  // Preserve worker completion/cancellation that arrived while stopping, and
  // recheck newly published startup PIDs before declaring cancellation.
  const latest = readRecord(file);
  if (!latest) throw new Error("XIU_BACKGROUND_STOP_UNCONFIRMED: Background state is unavailable; process termination remains unknown.");
  if (!confirmed || backgroundRecordAlive(latest)) {
    const code = timedOut ? "STOP_TIMEOUT" : "STOP_UNCONFIRMED";
    try {
      // A concurrent cancellation is an intent, not shutdown proof. Keep it
      // cancellable if a known owned PID/group is still live. Preserve genuine
      // completed/failed evidence rather than rewriting it from a stop request.
      if (["starting", "running", "cancelled"].includes(latest.state)) {
        atomicWrite(file, { ...latest, state: latest.state === "cancelled" ? "running" : latest.state, updatedAt: new Date().toISOString(), failure: latest.failure ?? { stage: "stop", code } });
      }
    } catch { /* Existing active evidence remains; never manufacture cancellation. */ }
    throw new Error(`XIU_BACKGROUND_STOP_UNCONFIRMED: ${timedOut ? "Process cleanup timed out" : "Process termination could not be confirmed"}; the background task remains active or unknown.`);
  }
  if (!["starting", "running"].includes(latest.state)) return;
  // A still-unclaimed starting request has no known PID. Cancellation remains
  // a terminal gate that the bootstrap/worker must observe before executing.
  const bytes = (() => {
    try {
      const stat = fs.lstatSync(path.join(path.dirname(file), `${id}.log`));
      return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
    } catch { return 0; }
  })();
  atomicWrite(file, { ...latest, state: "cancelled", updatedAt: new Date().toISOString(), outputBytes: bytes });
}

/** Explicit test/admin cleanup. Normal Xiu shutdown deliberately does not call this. */
export async function stopAllBackgroundProcesses(): Promise<void> {
  await Promise.all(listBackgroundProcesses().filter((item) => item.running).map((item) => stopBackgroundProcess(item.id)));
}
