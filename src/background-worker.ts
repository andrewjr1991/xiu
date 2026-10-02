import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./secret-redaction.js";

interface Request { version: 1; recordFile: string; outputFile: string; cwd: string; command: string }
interface RecordValue { version: 1; id: string; workspaceId: string; commandPreview: string; state: string; startedAt: string; updatedAt: string; pid?: number; childPid?: number; exitCode?: number | null; signal?: string; outputBytes: number; failure?: { stage: "worker" | "shell"; code: string } }

function atomicWrite(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed */ } }
}

function update(request: Request, fields: Partial<RecordValue>): void {
  const current = JSON.parse(fs.readFileSync(request.recordFile, "utf8")) as RecordValue;
  // A stop or an earlier failure owns its terminal evidence.
  if (current.state !== "starting" && current.state !== "running") return;
  atomicWrite(request.recordFile, { ...current, ...fields, pid: process.pid, updatedAt: new Date().toISOString(), outputBytes: (() => { try { return fs.statSync(request.outputFile).size; } catch { return 0; } })() });
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
function fail(error: unknown, stage: "worker" | "shell"): void {
  if (!request) return;
  const code = (error as NodeJS.ErrnoException)?.code;
  const safeCode = ["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOSPC", "EMFILE", "EAGAIN", "ENOMEM"].includes(code ?? "") ? code! : "UNKNOWN";
  // Error messages can contain command/source text. Persist only fixed text
  // and an allowlisted code, including for failures before output is opened.
  try {
    const directory = fs.lstatSync(path.dirname(request.outputFile));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe output directory");
    const existing = (() => { try { return fs.lstatSync(request!.outputFile); } catch { return undefined; } })();
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe output file");
    fs.writeFileSync(request.outputFile, `Background ${stage} failed (${safeCode}).\n`, { encoding: "utf8", mode: 0o600, flag: existing ? "a" : "wx" });
  } catch { /* Still record failure when output is unavailable. */ }
  update(request, { state: "failed", exitCode: null, failure: { stage, code: safeCode } });
  process.exitCode = 1;
}
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
  update(request, { state: "running", childPid: child.pid });
  const stdout = createRedactedAppender(request.outputFile);
  const stderr = createRedactedAppender(request.outputFile);
  child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
  const terminate = (): void => { if (child && child.exitCode === null) child.kill("SIGTERM"); };
  process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
  child.once("error", (error) => {
    stdout.flush(); stderr.flush();
    fail(error, "shell");
  });
  // 'exit' may precede the final pipe data. Publish completion only once both
  // streams close so callers cannot observe completed with truncated output.
  child.once("close", (code, signal) => {
    stdout.flush(); stderr.flush();
    update(activeRequest, { state: code === 0 ? "completed" : signal ? "cancelled" : "failed", exitCode: code, ...(signal ? { signal } : {}) });
  });
} catch (error) {
  if (requestFile) try { fs.unlinkSync(requestFile); } catch { /* best effort */ }
  if (child && child.exitCode === null) child.kill("SIGTERM");
  try { fail(error, "worker"); } catch { /* Unsafe/unwritable state cannot be repaired here. */ }
  process.exitCode = 1;
}
