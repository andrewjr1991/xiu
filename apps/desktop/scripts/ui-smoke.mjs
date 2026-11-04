import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { requireUiSmokeResult } = require("./ui-smoke-result.cjs");
const smokeRoot = new URL("../../../.desktop-build-temp/", import.meta.url);
await mkdir(smokeRoot, { recursive: true });
const profile = await mkdtemp(fileURLToPath(new URL("ui-smoke-", smokeRoot)));
try {
  const result = spawnSync(require("electron"), [fileURLToPath(new URL("ui-smoke-harness.cjs", import.meta.url))], {
    encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 4_000_000,
    env: { ...process.env, XIU_UI_SMOKE_PROFILE: profile },
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`UI smoke failed with ${result.signal ?? result.status}.`);
  requireUiSmokeResult(result.stdout);
} finally {
  // Delete only the private profile created by this exact invocation; screenshots remain.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
