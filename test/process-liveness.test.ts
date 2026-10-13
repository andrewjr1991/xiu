import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { processAlive } from "../src/process-liveness.js";

test("a live process and process group are alive; a missing pid is not", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(undefined), false);
  assert.equal(processAlive(2 ** 22 + 12_345), false);
});

test("a zombie that no init will reap counts as exited", { skip: process.platform !== "linux" }, async (t) => {
  // The python parent forks a child that exits at once and is never waited
  // on, leaving a zombie while the parent sleeps.
  const parent = spawn("python3", ["-c", "import os,sys,time\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  t.after(() => { try { process.kill(-parent.pid!, "SIGKILL"); } catch { /* already gone */ } });
  const zombie = Number(await new Promise<string>((resolve, reject) => {
    parent.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
    parent.once("error", reject);
  }));
  for (let attempt = 0; attempt < 50 && processAlive(zombie); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotThrow(() => process.kill(zombie, 0), "the zombie still answers signal 0");
  assert.equal(processAlive(zombie), false);
  // The group still has a running member (the sleeping parent).
  assert.equal(processAlive(-parent.pid!), true);
});
