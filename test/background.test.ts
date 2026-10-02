import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import {
  backgroundProcessOutput,
  configureBackgroundWorkspace,
  configureBackgroundRuntime,
  listBackgroundProcesses,
  readBackgroundProcessOutput,
  startBackgroundProcess,
  stopAllBackgroundProcesses,
  stopBackgroundProcess,
} from "../src/background.js";

const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const backgroundModuleUrl = pathToFileURL(path.resolve("src/background.ts")).href;
function quoteCommand(value: string): string {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
}
function nodeCommand(file: string): string {
  return `${process.platform === "win32" ? "& " : ""}${quoteCommand(process.execPath)} ${quoteCommand(file)}`;
}
async function runLauncher(script: string, cwd = process.cwd()): Promise<string> {
  const launcher = spawn(process.execPath, ["--import", loaderUrl, "--input-type=module", "-e", script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  launcher.stdout.on("data", (chunk) => { stdout += String(chunk); });
  launcher.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => { launcher.once("error", reject); launcher.once("close", resolve); });
  assert.equal(exitCode, 0, stderr);
  return stdout.trim();
}
async function waitForTerminal(id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = listBackgroundProcesses().find((item) => item.id === id);
    if (record && !record.running) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Background did not terminate: ${JSON.stringify({ record: listBackgroundProcesses().find((item) => item.id === id), output: backgroundProcessOutput(id) })}`);
}
function removeBackgroundTestRoot(root: string): Promise<void> {
  return fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

test("background commands can be listed, inspected, and stopped", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(async () => { await stopAllBackgroundProcesses(); await removeBackgroundTestRoot(root); });
  const command = process.platform === "win32"
    ? "Write-Output 'ready'; while ($true) { Start-Sleep -Seconds 1 }"
    : "node -e \"console.log('ready'); setInterval(() => {}, 1000)\"";
  const started = startBackgroundProcess(command, process.cwd());
  // Parallel test workers can delay a new PowerShell + Node process well past
  // two seconds on loaded Windows hosts. Poll with a bounded wall-clock budget.
  for (let attempt = 0; attempt < 300 && !backgroundProcessOutput(started.id).includes("ready"); attempt++) {
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
  t.after(async () => { configureBackgroundWorkspace(process.cwd(), root); await stopAllBackgroundProcesses(); await removeBackgroundTestRoot(root); });
  const started = startBackgroundProcess("node -e \"console.log('first'); setTimeout(() => console.log('second'), 500); setTimeout(() => {}, 5000)\"", process.cwd());
  for (let attempt = 0; attempt < 300 && !backgroundProcessOutput(started.id).includes("first"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const first = readBackgroundProcessOutput(started.id, 0);
  assert.match(first.text, /first/);

  // Reconfiguration simulates a fresh Xiu process discovering the same workspace store.
  configureBackgroundWorkspace(process.cwd(), root);
  assert.equal(listBackgroundProcesses().some((item) => item.id === started.id && item.running), true);
  for (let attempt = 0; attempt < 300; attempt++) {
    const next = readBackgroundProcessOutput(started.id, first.nextCursor);
    if (next.text.includes("second")) { assert.equal(next.cursor, first.nextCursor); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("incremental background output did not arrive");
});

test("completed detached commands retain exit evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-complete-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(() => removeBackgroundTestRoot(root));
  const started = startBackgroundProcess("node -e \"console.log('done')\"", process.cwd());
  for (let attempt = 0; attempt < 300; attempt++) {
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

test("rapid detached commands cannot have terminal evidence overwritten by the launcher", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-rapid-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(() => removeBackgroundTestRoot(root));
  const started = Array.from({ length: 8 }, (_, index) => startBackgroundProcess(`node -e "console.log(${index})"`, process.cwd()));
  for (let attempt = 0; attempt < 450; attempt++) {
    const records = listBackgroundProcesses().filter((item) => started.some((entry) => entry.id === item.id));
    if (records.length === started.length && records.every((item) => !item.running)) {
      assert.deepEqual(records.map((item) => item.state), Array.from({ length: started.length }, () => "completed"));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("rapid background commands did not preserve terminal evidence");
});

test("a detached job survives the launcher process exiting and is discoverable by a new process", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-disconnect-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-workspace-"));
  const workload = path.join(workspace, "survive.mjs");
  await fs.writeFile(workload, "console.log('survived');\nsetInterval(() => {}, 1000);\n", "utf8");
  const command = nodeCommand(workload);
  t.after(async () => { configureBackgroundWorkspace(workspace, root); await stopAllBackgroundProcesses(); await removeBackgroundTestRoot(root); });
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const script = [
    `import { writeSync } from "node:fs";`,
    `import { configureBackgroundWorkspace, startBackgroundProcess } from ${JSON.stringify(backgroundModuleUrl)};`,
    `configureBackgroundWorkspace(${JSON.stringify(workspace)}, ${JSON.stringify(root)});`,
    `writeSync(1, startBackgroundProcess(${JSON.stringify(command)}, ${JSON.stringify(workspace)}).id + "\\n");`,
    // No startup acknowledgement, grace delay, or retained pipe to the worker.
    `process.exit(0);`,
  ].join("\n");
  const id = await runLauncher(script);
  assert.match(id, /^[a-f0-9]{12}$/);
  configureBackgroundWorkspace(workspace, root);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !backgroundProcessOutput(id).includes("survived")) {
    if (!listBackgroundProcesses().find((item) => item.id === id)?.running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = listBackgroundProcesses().find((item) => item.id === id);
  const output = backgroundProcessOutput(id);
  const diagnostics = JSON.stringify({ record, output });
  assert.equal(record?.running, true, diagnostics);
  assert.match(output, /survived/, diagnostics);
});

test("persisted background previews and output redact common credential values", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-redaction-"));
  configureBackgroundWorkspace(process.cwd(), root);
  t.after(() => removeBackgroundTestRoot(root));
  const secret = "background-secret-canary";
  const started = startBackgroundProcess(`node -e \"console.log('api_key=${secret}')\"`, process.cwd());
  for (let attempt = 0; attempt < 300 && listBackgroundProcesses().find((item) => item.id === started.id)?.running; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const serialized = JSON.stringify(listBackgroundProcesses()) + backgroundProcessOutput(started.id);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /REDACTED/);
});


test("source background worker resolves its loader outside the repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-external-"));
  t.after(() => removeBackgroundTestRoot(root));
  const workload = path.join(root, "external.mjs");
  await fs.writeFile(workload, "console.log('external-cwd-ready');\n");
  const script = [
    `import { configureBackgroundWorkspace, startBackgroundProcess } from ${JSON.stringify(backgroundModuleUrl)};`,
    `configureBackgroundWorkspace(${JSON.stringify(root)}, ${JSON.stringify(root)});`,
    `console.log(startBackgroundProcess(${JSON.stringify(nodeCommand(workload))}).id);`,
  ].join("\n");
  const id = await runLauncher(script, root);
  configureBackgroundWorkspace(root, root);
  const record = await waitForTerminal(id);
  assert.equal(record.state, "completed", JSON.stringify(record));
  assert.match(backgroundProcessOutput(id), /external-cwd-ready/);
});

test("worker import failure after immediate launcher exit leaves bounded non-secret evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-bootstrap-"));
  t.after(() => removeBackgroundTestRoot(root));
  const canary = "bootstrap-private-canary-67f319";
  const source = path.join(root, "broken-worker.mjs");
  await fs.writeFile(source, `throw Object.assign(new Error(${JSON.stringify(canary.repeat(10_000))}), { code: 'ERR_MODULE_NOT_FOUND' });`);
  const script = [
    `import { writeSync } from "node:fs";`,
    `import { configureBackgroundWorkspace, configureBackgroundRuntime, startBackgroundProcess } from ${JSON.stringify(backgroundModuleUrl)};`,
    `configureBackgroundWorkspace(${JSON.stringify(root)}, ${JSON.stringify(root)});`,
    `configureBackgroundRuntime(${JSON.stringify(process.execPath)}, ${JSON.stringify(source)});`,
    `writeSync(1, startBackgroundProcess("echo command-must-not-run").id + "\\n");`,
    `process.exit(0);`,
  ].join("\n");
  const id = await runLauncher(script);
  configureBackgroundWorkspace(root, root);
  const record = await waitForTerminal(id);
  assert.equal(record.state, "failed");
  assert.deepEqual(record.failure, { stage: "bootstrap", code: "ERR_MODULE_NOT_FOUND" });
  assert.match(backgroundProcessOutput(id), /bootstrap failed \(ERR_MODULE_NOT_FOUND\)/);
  const directory = (await fs.readdir(root, { withFileTypes: true })).find((entry) => entry.isDirectory());
  assert.ok(directory);
  const stored = await fs.readdir(path.join(root, directory.name));
  assert.deepEqual(stored.sort(), [`${id}.json`, `${id}.log`]);
  const evidence = (await Promise.all(stored.map((name) => fs.readFile(path.join(root, directory.name, name), "utf8")))).join("");
  assert.ok(evidence.length < 2000);
  assert.doesNotMatch(evidence, new RegExp(canary));
  assert.doesNotMatch(backgroundProcessOutput(id), /command-must-not-run/);
});

test("missing worker runtime records asynchronous spawn failure in its original workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-spawn-error-"));
  const other = path.join(root, "other");
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(path.join(root, "missing-node-executable"));
  const started = startBackgroundProcess("echo command-must-not-run");
  configureBackgroundRuntime();
  configureBackgroundWorkspace(other, root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listBackgroundProcesses(), []);
  configureBackgroundWorkspace(root, root);
  const record = await waitForTerminal(started.id);
  assert.equal(record.state, "failed");
  assert.deepEqual(record.failure, { stage: "bootstrap", code: "ENOENT" });
  assert.equal(backgroundProcessOutput(started.id), "No output yet.");
});

test("missing command directory fails without leaving a starting job or replaying the command", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-shell-error-"));
  t.after(() => removeBackgroundTestRoot(root));
  configureBackgroundWorkspace(root, root);
  const started = startBackgroundProcess("echo command-must-not-run", path.join(root, "missing-workspace"));
  const record = await waitForTerminal(started.id);
  assert.equal(record.state, "failed");
  assert.deepEqual(record.failure, { stage: "shell", code: "ENOENT" });
  assert.match(backgroundProcessOutput(started.id), /shell failed \(ENOENT\)/);
  assert.doesNotMatch(backgroundProcessOutput(started.id), /command-must-not-run/);
});

test("terminal background evidence includes data arriving after the shell exits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-drain-"));
  t.after(() => removeBackgroundTestRoot(root));
  const workload = path.join(root, "late-output.mjs");
  const late = "setTimeout(() => { process.stdout.write('late-stdout\\n'); process.stderr.write('late-stderr\\n'); }, 300);";
  await fs.writeFile(workload, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(late)}], { detached: true, windowsHide: true, stdio: ['ignore', process.stdout, process.stderr] });
child.unref();
`);
  configureBackgroundWorkspace(root, root);
  const started = startBackgroundProcess(nodeCommand(workload));
  const record = await waitForTerminal(started.id);
  assert.equal(record.state, "completed", JSON.stringify(record));
  const output = backgroundProcessOutput(started.id);
  assert.match(output, /late-stdout/);
  assert.match(output, /late-stderr/);
  assert.equal(record.outputBytes, Buffer.byteLength(output));
});

test("persisted background failure metadata must use bounded allowlisted values", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-failure-metadata-"));
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(path.join(root, "missing-runtime"));
  const { id } = startBackgroundProcess("echo noop");
  configureBackgroundRuntime();
  await waitForTerminal(id);
  const directories = await fs.readdir(root, { withFileTypes: true });
  const file = path.join(root, directories.find((entry) => entry.isDirectory())!.name, `${id}.json`);
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const failure of [null, "invalid", { stage: "bootstrap", code: "ENOENT", secret: "metadata-canary" }, { stage: "secret-stage", code: "ENOENT" }, { stage: "bootstrap", code: "credential-canary".repeat(1000) }]) {
    await fs.writeFile(file, JSON.stringify({ ...original, failure }));
    assert.deepEqual(listBackgroundProcesses(), []);
    assert.throws(() => backgroundProcessOutput(id), /Unknown background process/);
  }
  await fs.writeFile(file, JSON.stringify(original));
  assert.deepEqual(listBackgroundProcesses()[0]?.failure, { stage: "bootstrap", code: "ENOENT" });
});
