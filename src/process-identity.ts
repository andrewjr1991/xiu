import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

/**
 * Process start times, used to tell a recorded PID from an unrelated process
 * that inherited the number after the original exited (assessment item S5).
 *
 * A background record stores the wall-clock start of its worker and shell when
 * they were published. Before a stop signals a PID, the current owner's start
 * time is read from the OS and compared with a tolerance of a few seconds; a
 * mismatch means the number was reused and the signal is withheld. Where the
 * OS cannot answer (no /proc, no ps, PowerShell unavailable or slow) the result
 * is unknown and the caller keeps its previous PID-only behaviour.
 */
export const START_TIME_TOLERANCE_MS = 5_000;
/** The kernel reports /proc start times in USER_HZ, which is fixed at 100 regardless of the scheduler tick. */
const LINUX_USER_HZ = 100;
const WINDOWS_PROBE_TIMEOUT_MS = 3_000;

export type StartTimeVerdict = "match" | "mismatch" | "unknown";

export interface ProcessStartTimeProbe {
  /** Cheap synchronous probe, used from liveness checks; undefined where none exists (Windows). */
  sync?: (pid: number) => number | undefined;
  /** Asynchronous probe, used before a stop signals a process. */
  async?: (pid: number) => Promise<number | undefined>;
}

let override: ProcessStartTimeProbe | undefined;
/** Tests replace the OS probes; production never calls this. */
export function configureProcessStartTimeProbe(probe?: ProcessStartTimeProbe): void { override = probe; }

let linuxBootTime: number | undefined;
function linuxBootTimeMs(): number | undefined {
  if (linuxBootTime !== undefined) return linuxBootTime;
  try {
    const match = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    if (match) linuxBootTime = Number(match[1]) * 1000;
  } catch { /* unknown */ }
  return linuxBootTime;
}

function linuxStartTime(pid: number): number | undefined {
  const boot = linuxBootTimeMs();
  if (boot === undefined) return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised command name; starttime is field 22 overall, index 19 here.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? boot + ticks * (1000 / LINUX_USER_HZ) : undefined;
  } catch { return undefined; }
}

/** `ps -o etime=` prints [[dd-]hh:]mm:ss, locale independent. */
export function parseElapsed(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

function darwinStartTime(pid: number): number | undefined {
  try {
    const result = spawnSync("/bin/ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, windowsHide: true });
    if (result.status !== 0) return undefined;
    const elapsed = parseElapsed(result.stdout);
    return elapsed === undefined ? undefined : Date.now() - elapsed;
  } catch { return undefined; }
}

function windowsStartTime(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | undefined): void => { if (!settled) { settled = true; resolve(value); } };
    try {
      const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      const timer = setTimeout(() => { finish(undefined); try { child.kill(); } catch { /* already gone */ } }, WINDOWS_PROBE_TIMEOUT_MS);
      child.once("error", () => { clearTimeout(timer); finish(undefined); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        const parsed = Date.parse(output.trim());
        finish(code === 0 && Number.isFinite(parsed) ? parsed : undefined);
      });
    } catch { finish(undefined); }
  });
}

/** Start time in epoch milliseconds from a cheap probe, or undefined when no cheap probe exists or it fails. */
export function processStartTimeSync(pid: number): number | undefined {
  if (override) return override.sync?.(pid);
  if (process.platform === "linux") return linuxStartTime(pid);
  if (process.platform === "darwin") return darwinStartTime(pid);
  return undefined;
}

export async function processStartTime(pid: number): Promise<number | undefined> {
  if (override) return override.async ? override.async(pid) : override.sync?.(pid);
  if (process.platform === "win32") return windowsStartTime(pid);
  return processStartTimeSync(pid);
}

export function compareStartTimes(recorded: string | undefined, observed: number | undefined): StartTimeVerdict {
  if (recorded === undefined || observed === undefined) return "unknown";
  const expected = Date.parse(recorded);
  if (!Number.isFinite(expected)) return "unknown";
  return Math.abs(observed - expected) <= START_TIME_TOLERANCE_MS ? "match" : "mismatch";
}
