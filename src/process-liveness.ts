import fs from "node:fs";
import process from "node:process";

/**
 * Whether a process (pid > 0) or process group (pid < 0) still exists.
 *
 * `kill(pid, 0)` also succeeds for zombies. Without an init that reaps
 * orphans (for example a container without --init), a stopped background
 * worker stays a zombie forever, so on Linux a target whose only remaining
 * entries are zombies counts as exited. When /proc cannot be read the
 * process is conservatively treated as alive.
 */
export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  if (process.platform !== "linux") return true;
  return pid > 0 ? !linuxZombie(pid) : !linuxGroupOnlyZombies(-pid);
}

/** State and process group from /proc/<pid>/stat; the command name may contain spaces or parentheses. */
function linuxStat(pid: number): { state: string; group: number } | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", group: Number(fields[2]) };
  } catch { return undefined; }
}

function linuxZombie(pid: number): boolean {
  return linuxStat(pid)?.state === "Z";
}

function linuxGroupOnlyZombies(group: number): boolean {
  let entries: string[];
  try { entries = fs.readdirSync("/proc"); } catch { return false; }
  // Only positive evidence counts: at least one member, and every member a zombie.
  let zombies = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = linuxStat(Number(entry));
    if (!stat || stat.group !== group) continue;
    if (stat.state !== "Z") return false;
    zombies++;
  }
  return zombies > 0;
}
