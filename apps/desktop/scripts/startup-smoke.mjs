import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fixture = await mkdtemp(path.join(os.tmpdir(), "xiu-startup-smoke-"));
try {
  const result = spawnSync(require("electron"), [fileURLToPath(new URL("startup-smoke-harness.cjs", import.meta.url)), fixture], {
    cwd: fixture, windowsHide: true, encoding: "utf8", timeout: 45_000, maxBuffer: 2_000_000,
    env: { ...process.env, XIU_DESKTOP_SMOKE: "1", XIU_DESKTOP_SMOKE_HOLD: "1", XIU_DESKTOP_SMOKE_LOG: path.join(fixture, "startup.log") },
  });
  if (result.error || result.status !== 0) throw new Error(`Desktop startup smoke failed: ${result.error?.message ?? result.signal ?? result.status}\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000)}`);
  const actual = JSON.parse(await readFile(path.join(fixture, "result.json"), "utf8"));
  assert.deepEqual(actual, { origin: "xiu-app://bundle", node: "undefined", process: "undefined", trust: "none", bridgeVersion: 1, providerGate: true, foreignSenderGate: true });
  assert.match(await readFile(path.join(fixture, "startup.log"), "utf8"), /load-finished/);
  console.log("Desktop startup smoke passed: real main/preload/IPC, isolated empty profile, original origin/CSP, workspace trust and foreign sender rejection.");
} finally {
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
