import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  backgroundProcessOutput,
  configureBackgroundWorkspace,
  listBackgroundProcesses,
  readBackgroundProcessOutput,
  startBackgroundProcess,
  stopAllBackgroundProcesses,
  stopBackgroundProcess,
} from "../src/background.js";

test("background commands can be listed, inspected, and stopped", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(async () => { await stopAllBackgroundProcesses(); });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = "node -e \"console.log('ready'); setInterval(() => {}, 1000)\"";
  const started = startBackgroundProcess(command, process.cwd());
  // Parallel test workers can delay a new PowerShell + Node process well past
  // two seconds on loaded Windows hosts. Poll with a bounded wall-clock budget.
  for (let attempt = 0; attempt < 100 && !backgroundProcessOutput(started.id).includes("ready"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = listBackgroundProcesses().find((item) => item.id === started.id);
  assert.ok(record);
  assert.equal(record.running, true);
  assert.match(backgroundProcessOutput(started.id), /ready/);
  await stopBackgroundProcess(started.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listBackgroundProcesses().find((item) => item.id === started.id)?.running, false);
});

test("background state and output cursors survive a new foreground manager", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-resume-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(async () => { configureBackgroundWorkspace(process.cwd(), root); await stopAllBackgroundProcesses(); });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = startBackgroundProcess("node -e \"console.log('first'); setTimeout(() => console.log('second'), 500); setTimeout(() => {}, 5000)\"", process.cwd());
  for (let attempt = 0; attempt < 100 && !backgroundProcessOutput(started.id).includes("first"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const first = readBackgroundProcessOutput(started.id, 0);
  assert.match(first.text, /first/);

  // Reconfiguration simulates a fresh Xiu process discovering the same workspace store.
  configureBackgroundWorkspace(process.cwd(), root);
  assert.equal(listBackgroundProcesses().some((item) => item.id === started.id && item.running), true);
  for (let attempt = 0; attempt < 100; attempt++) {
    const next = readBackgroundProcessOutput(started.id, first.nextCursor);
    if (next.text.includes("second")) { assert.equal(next.cursor, first.nextCursor); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("incremental background output did not arrive");
});

test("completed detached commands retain exit evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-complete-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = startBackgroundProcess("node -e \"console.log('done')\"", process.cwd());
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = listBackgroundProcesses().find((item) => item.id === started.id);
    if (record && !record.running) {
      assert.equal(record.state, "completed");
      assert.match(backgroundProcessOutput(started.id), /done/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("background command did not complete");
});

test("a detached job survives the launcher process exiting and is discoverable by a new process", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-disconnect-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-workspace-"));
  t.after(async () => { configureBackgroundWorkspace(workspace, root); await stopAllBackgroundProcesses(); });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve("src/background.ts")).href;
  const script = [
    `import { configureBackgroundWorkspace, startBackgroundProcess } from ${JSON.stringify(moduleUrl)};`,
    `configureBackgroundWorkspace(${JSON.stringify(workspace)}, ${JSON.stringify(root)});`,
    `console.log(startBackgroundProcess(${JSON.stringify("node -e \"console.log('survived'); setTimeout(() => {}, 10000)\"")}, ${JSON.stringify(workspace)}).id);`,
  ].join("\n");
  const launcher = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  launcher.stdout.on("data", (chunk) => { stdout += String(chunk); });
  launcher.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => { launcher.once("error", reject); launcher.once("exit", resolve); });
  assert.equal(exitCode, 0, stderr);
  const id = stdout.trim();
  assert.match(id, /^[a-f0-9]{12}$/);
  configureBackgroundWorkspace(workspace, root);
  for (let attempt = 0; attempt < 100 && !backgroundProcessOutput(id).includes("survived"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listBackgroundProcesses().find((item) => item.id === id)?.running, true);
  assert.match(backgroundProcessOutput(id), /survived/);
});

test("persisted background previews and output redact common credential values", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-redaction-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = "background-secret-canary";
  const started = startBackgroundProcess(`node -e \"console.log('api_key=${secret}')\"`, process.cwd());
  for (let attempt = 0; attempt < 100 && listBackgroundProcesses().find((item) => item.id === started.id)?.running; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const serialized = JSON.stringify(listBackgroundProcesses()) + backgroundProcessOutput(started.id);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /REDACTED/);
});
