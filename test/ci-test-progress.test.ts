import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../scripts/run-ci-tests.mjs", import.meta.url));

async function fixture(t: { after: (fn: () => Promise<void>) => void }, script: string) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-ci-test-progress-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, "scripts"));
  await fs.writeFile(path.join(cwd, "scripts", "run-tests.mjs"), script);
  return cwd;
}

test("CI progress notices preserve a failed test's status and full failure annotation", async (t) => {
  const cwd = await fixture(t, 'console.log("TAP version 13\\nnot ok 1 - timed out fixture\\n  ---\\n  failureType: testTimeoutFailure\\n  error: test timed out after 600000ms\\n  ..."); process.exitCode = 1;');
  const result = spawnSync(process.execPath, [wrapper], { cwd, env: { ...process.env, GITHUB_ACTIONS: "true" }, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::notice title=Test process started::Node/);
  assert.match(result.stdout, /::notice title=Test process exited::exit code 1/);
  assert.match(result.stderr, /::error title=timed out fixture::.*testTimeoutFailure.*test timed out after 600000ms/);
});

test("local successful CI-wrapper use keeps its output free of progress workflow commands", async (t) => {
  const cwd = await fixture(t, 'console.log("TAP version 13\\nok 1 - passing fixture");');
  const result = spawnSync(process.execPath, [wrapper], { cwd, env: { ...process.env, GITHUB_ACTIONS: "false" }, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ok 1 - passing fixture/);
  assert.doesNotMatch(result.stdout + result.stderr, /::notice|::error/);
});
