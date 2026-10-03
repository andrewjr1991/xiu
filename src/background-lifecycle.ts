import fs from "node:fs";

/** Shared with the pre-loader bootstrap. No module state or external helpers. */
export function lifecycleGate<T>(io: typeof fs, file: string, action: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const reaper = `${lock}.reap`;
  let descriptor: number;
  for (;;) {
    try {
      if (io.existsSync(reaper)) throw Object.assign(new Error("Background lifecycle recovery is busy."), { code: "EEXIST" });
      descriptor = io.openSync(lock, "wx", 0o600);
      try { io.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); }
      catch (error) { io.closeSync(descriptor); io.unlinkSync(lock); throw error; }
      break;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize dead-owner recovery separately. Without this second gate two
      // reclaimers could unlink the next owner's newly acquired lock.
      let recovery: number | undefined;
      try {
        recovery = io.openSync(reaper, "wx", 0o600);
        const stat = io.lstatSync(lock);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64) {
          const owner = JSON.parse(io.readFileSync(lock, "utf8")) as { pid?: number };
          if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
            let dead = false;
            try { process.kill(owner.pid!, 0); }
            catch (failure) { dead = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
            if (dead) io.unlinkSync(lock);
          }
        }
      } catch { /* Missing, corrupt, live or unknown ownership fails closed. */ }
      finally { if (recovery !== undefined) { io.closeSync(recovery); io.unlinkSync(reaper); } }
      if (Date.now() >= deadline) throw Object.assign(new Error("Background lifecycle is busy or interrupted."), { code: "EBUSY" });
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try { return action(); }
  finally { io.closeSync(descriptor); io.unlinkSync(lock); }
}

export function withBackgroundLifecycle<T>(file: string, action: () => T): T {
  return lifecycleGate(fs, file, action);
}
