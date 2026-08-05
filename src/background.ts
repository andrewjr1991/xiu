import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_LOG = 40_000;

interface ManagedProcess {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  startedAt: number;
  exitCode: number | null;
}

const processes = new Map<string, ManagedProcess>();

function appendOutput(record: ManagedProcess, chunk: Buffer): void {
  record.output += chunk.toString("utf8");
  if (record.output.length > MAX_LOG) record.output = record.output.slice(-MAX_LOG);
}

export function startBackgroundProcess(command: string, cwd: string): { id: string; pid?: number } {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "powershell.exe" : "/bin/sh";
  const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const id = randomUUID().slice(0, 8);
  const record: ManagedProcess = { id, command, child, output: "", startedAt: Date.now(), exitCode: null };
  processes.set(id, record);
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(record, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(record, chunk));
  child.on("exit", (code) => { record.exitCode = code; });
  return { id, pid: child.pid };
}

export function listBackgroundProcesses(): Array<{ id: string; pid?: number; command: string; running: boolean; elapsedMs: number }> {
  return [...processes.values()].map((record) => ({
    id: record.id,
    pid: record.child.pid,
    command: record.command,
    running: record.exitCode === null && !record.child.killed,
    elapsedMs: Date.now() - record.startedAt,
  }));
}

export function backgroundProcessOutput(id: string): string {
  const record = processes.get(id);
  if (!record) throw new Error(`Unknown background process: ${id}`);
  return record.output || "No output yet.";
}

export async function stopBackgroundProcess(id: string): Promise<void> {
  const record = processes.get(id);
  if (!record) throw new Error(`Unknown background process: ${id}`);
  if (record.exitCode !== null || record.child.killed) return;
  if (process.platform === "win32" && record.child.pid) {
    await execFileAsync("taskkill.exe", ["/PID", String(record.child.pid), "/T", "/F"], { windowsHide: true }).catch(() => record.child.kill());
  } else {
    record.child.kill("SIGTERM");
  }
}

export async function stopAllBackgroundProcesses(): Promise<void> {
  await Promise.all([...processes.keys()].map((id) => stopBackgroundProcess(id).catch(() => undefined)));
}
