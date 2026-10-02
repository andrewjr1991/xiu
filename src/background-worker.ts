import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./secret-redaction.js";

interface Request { version: 1; recordFile: string; outputFile: string; cwd: string; command: string }
interface RecordValue { version: 1; id: string; workspaceId: string; commandPreview: string; state: string; startedAt: string; updatedAt: string; pid?: number; childPid?: number; exitCode?: number | null; signal?: string; outputBytes: number; failure?: Failure }

type FailureStage = "worker" | "shell" | "output" | "state-write" | "worker-exit";
interface Failure { stage: FailureStage; code: string }
const failureCodes = new Set(["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOSPC", "EMFILE", "EAGAIN", "ENOMEM", "EBUSY", "EIO"]);
const retryDelays = [10, 25, 50, 100, 200];
const retrySignal = new Int32Array(new SharedArrayBuffer(4));
function failureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return failureCodes.has(code ?? "") ? code! : "UNKNOWN";
}
function persistFailure(request: Request, failure: Failure): void {
  try {
    const directory = fs.lstatSync(path.dirname(request.recordFile));
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    // Separate, write-once evidence survives a locked/replaced main record.
    // Only fixed stage/code values enter this bounded file, never exceptions.
    fs.writeFileSync(request.recordFile.replace(/\.json$/, ".failure.json"), `${JSON.stringify(failure)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch { /* Preserve the first failure and never follow an existing link. */ }
}

function atomicWrite(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed */ } }
}

function update(request: Request, fields: Partial<RecordValue>): void {
  for (let attempt = 0; ; attempt++) {
    try {
      const stat = fs.lstatSync(request.recordFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe background record");
      const current = JSON.parse(fs.readFileSync(request.recordFile, "utf8")) as RecordValue;
      // Re-read on every metadata retry: cancellation/terminal evidence wins.
      if (current.state !== "starting" && current.state !== "running") return;
      atomicWrite(request.recordFile, { ...current, ...fields, pid: process.pid, updatedAt: new Date().toISOString(), outputBytes: (() => { try { return fs.statSync(request.outputFile).size; } catch { return 0; } })() });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= retryDelays.length) throw error;
      // A bounded retry of local metadata only. Never re-spawn a command or
      // replay output, and never unlink the destination to force replacement.
      Atomics.wait(retrySignal, 0, 0, retryDelays[attempt]);
    }
  }
}

function createRedactedAppender(file: string): { write(value: Buffer): void; flush(): void } {
  let pending = "";
  const persist = (value: string): void => {
    if (value) fs.appendFileSync(file, redactSecrets(value), { encoding: "utf8", mode: 0o600 });
  };
  return {
    write(value) {
      pending += value.toString("utf8");
      const boundary = pending.lastIndexOf("\n");
      if (boundary < 0) return;
      persist(pending.slice(0, boundary + 1));
      pending = pending.slice(boundary + 1);
    },
    flush() { persist(pending); pending = ""; },
  };
}

const requestFile = process.argv[2];
if (!requestFile) process.exit(2);
let child: ChildProcess | undefined;
let request: Request | undefined;
let failed = false;
let stopRequested = false;
let childClosed = false;
let activeFailure: Failure | undefined;
let shutdownConfirmed = false;
let forceTimer: NodeJS.Timeout | undefined;
function finishFailure(): void {
  if (!request || !activeFailure || (child?.pid && (!childClosed || !shutdownConfirmed))) return;
  if (forceTimer) clearTimeout(forceTimer);
  try { update(request, { state: "failed", exitCode: null, failure: activeFailure }); }
  catch { /* The independent failure receipt remains readable after exit. */ }
}
function stopOwnedTree(): void {
  if (!child?.pid) { shutdownConfirmed = true; finishFailure(); return; }
  if (process.platform === "win32") {
    const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    forceTimer = setTimeout(() => { killer.kill(); }, 1_000);
    killer.once("error", () => { if (forceTimer) clearTimeout(forceTimer); });
    killer.once("exit", (code) => {
      if (forceTimer) clearTimeout(forceTimer);
      shutdownConfirmed = code === 0;
      if (shutdownConfirmed) finishFailure();
      // Failed tree termination leaves active/unknown evidence for explicit stop.
    });
  } else {
    // The launcher makes this worker the detached group leader. TERM delivery
    // or shell/pipe closure cannot prove that redirected descendants exited.
    // Keep the referenced escalation timer even after child close. Group KILL
    // also ends us; the fixed failure receipt preserves the unknown outcome.
    try { process.kill(-process.pid, "SIGTERM"); }
    catch { try { child.kill("SIGTERM"); } catch {} }
    forceTimer = setTimeout(() => {
      try { process.kill(-process.pid, "SIGKILL"); }
      catch { try { child?.kill("SIGKILL"); } catch {} }
    }, 1_000);
  }
}
function fail(error: unknown, stage: FailureStage): void {
  if (!request || failed) return;
  failed = true;
  const safeCode = failureCode(error);
  const failure = { stage, code: safeCode };
  activeFailure = failure;
  persistFailure(request, failure);
  // Error messages can contain command/source text. Persist only fixed text
  // and an allowlisted code, including for failures before output is opened.
  try {
    const directory = fs.lstatSync(path.dirname(request.outputFile));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe output directory");
    const existing = (() => { try { return fs.lstatSync(request!.outputFile); } catch { return undefined; } })();
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe output file");
    fs.writeFileSync(request.outputFile, `Background ${stage} failed (${safeCode}).\n`, { encoding: "utf8", mode: 0o600, flag: existing ? "a" : "wx" });
  } catch { /* Still record failure when output is unavailable. */ }
  // Do not publish a terminal state while our command/tree or output pipes
  // are still live. Retain active evidence until shutdown is confirmed.
  try { update(request, { failure }); } catch { /* Independent receipt remains. */ }
  process.exitCode = 1;
  stopOwnedTree();
}
function guard(action: () => void, stage: FailureStage): void {
  if (failed) return;
  try { action(); } catch (error) { fail(error, stage); }
}
// Monitoring does not suppress Node's fatal exit or claim the command failed
// safely. It only retains fixed-code evidence for otherwise silent callbacks.
process.once("uncaughtExceptionMonitor", (error) => {
  if (request) persistFailure(request, { stage: "worker", code: failureCode(error) });
});
process.once("exit", () => {
  if (!request) return;
  try {
    const current = JSON.parse(fs.readFileSync(request.recordFile, "utf8")) as RecordValue;
    if (current.state === "starting" || current.state === "running") persistFailure(request, { stage: "worker-exit", code: "MISSING_TERMINAL" });
  } catch { /* Storage unavailable. */ }
});
try {
  request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as Request;
  const activeRequest = request;
  fs.unlinkSync(requestFile);
  const current = JSON.parse(fs.readFileSync(request.recordFile, "utf8")) as RecordValue;
  if (current.state !== "starting") process.exit(0);
  const directory = fs.lstatSync(path.dirname(request.outputFile));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe background output directory");
  fs.closeSync(fs.openSync(request.outputFile, "ax", 0o600));
  const windows = process.platform === "win32";
  const shell = windows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh";
  child = spawn(shell, windows ? ["-NoProfile", "-NonInteractive", "-Command", request.command] : ["-lc", request.command], {
    cwd: request.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XIU_DETACHED_BACKGROUND: "1" },
  });
  const stdout = createRedactedAppender(request.outputFile);
  const stderr = createRedactedAppender(request.outputFile);
  child.stdout?.on("data", (chunk: Buffer) => guard(() => stdout.write(chunk), "output"));
  child.stderr?.on("data", (chunk: Buffer) => guard(() => stderr.write(chunk), "output"));
  const terminate = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    if (failed) {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      return;
    }
    // A directed stop is pending, not terminal proof. Keep group escalation
    // alive even if the immediate shell closes before redirected descendants.
    stopOwnedTree();
  };
  process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
  child.once("error", (error) => {
    guard(() => { stdout.flush(); stderr.flush(); }, "output");
    fail(error, "shell");
  });
  // 'exit' may precede the final pipe data. Publish completion only once both
  // streams close so callers cannot observe completed with truncated output.
  child.once("close", (code, signal) => {
    childClosed = true;
    if (failed) { finishFailure(); return; }
    guard(() => { stdout.flush(); stderr.flush(); }, "output");
    if (stopRequested) return;
    guard(() => update(activeRequest, { state: code === 0 ? "completed" : signal ? "cancelled" : "failed", exitCode: code, ...(signal ? { signal } : {}) }), "state-write");
  });
  // All lifecycle guards must exist before state persistence can throw. A
  // startup write failure still owns a live command and must finish cleanup.
  update(request, { state: "running", childPid: child.pid });
} catch (error) {
  if (requestFile) try { fs.unlinkSync(requestFile); } catch { /* best effort */ }
  try { fail(error, "worker"); } catch { /* Unsafe/unwritable state cannot be repaired here. */ }
  process.exitCode = 1;
}
