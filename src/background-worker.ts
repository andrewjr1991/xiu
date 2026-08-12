import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./secret-redaction.js";

interface Request { version: 1; recordFile: string; outputFile: string; cwd: string; command: string }
interface RecordValue { version: 1; id: string; workspaceId: string; commandPreview: string; state: string; startedAt: string; updatedAt: string; pid?: number; childPid?: number; exitCode?: number | null; signal?: string; outputBytes: number }

function atomicWrite(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed */ } }
}

function update(request: Request, fields: Partial<RecordValue>): void {
  const current = JSON.parse(fs.readFileSync(request.recordFile, "utf8")) as RecordValue;
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
try {
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as Request;
  fs.unlinkSync(requestFile);
  const directory = fs.lstatSync(path.dirname(request.outputFile));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe background output directory");
  fs.closeSync(fs.openSync(request.outputFile, "ax", 0o600));
  const windows = process.platform === "win32";
  child = spawn(windows ? "powershell.exe" : "/bin/sh", windows ? ["-NoProfile", "-NonInteractive", "-Command", request.command] : ["-lc", request.command], {
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
    fs.appendFileSync(request.outputFile, `${redactSecrets(error.message)}\n`, { encoding: "utf8", mode: 0o600 });
    update(request, { state: "failed", exitCode: null }); process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    stdout.flush(); stderr.flush();
    update(request, { state: code === 0 ? "completed" : signal ? "cancelled" : "failed", exitCode: code, ...(signal ? { signal } : {}) });
  });
} catch (error) {
  if (requestFile) try { fs.unlinkSync(requestFile); } catch { /* best effort */ }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
