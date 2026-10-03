import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess, { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

test("cancellation before bootstrap claims its PID permanently gates a delayed launch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-unclaimed-"));
  t.after(() => removeBackgroundTestRoot(root));
  configureBackgroundWorkspace(root, root);
  const marker = path.join(root, "must-not-execute.txt");
  const script = path.join(root, "command.cjs");
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`);
  const original = childProcess.spawn;
  let launch: { program: string; args: readonly string[] } | undefined;
  t.mock.method(childProcess, "spawn", (program: string, args: readonly string[]) => {
    launch = { program, args };
    return Object.assign(new EventEmitter(), { unref() {} });
  });
  syncBuiltinESMExports();
  const job = startBackgroundProcess(nodeCommand(script), root);
  await stopBackgroundProcess(job.id);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.ok(launch);
  const delayed = original(launch.program, launch.args, { windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { delayed.once("error", reject); delayed.once("close", () => resolve()); });
  assert.equal(listBackgroundProcesses().find((item) => item.id === job.id)?.state, "cancelled");
  assert.equal(fsSync.existsSync(marker), false);
});
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

test("workspace cleanup tolerates a launch artifact disappearing after enumeration or inspection", async (t) => {
  for (const suffix of ["request.json", "bootstrap.cjs"]) {
    for (const operation of ["lstatSync", "unlinkSync"] as const) {
      await t.test(`${suffix} disappears before ${operation}`, async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-cleanup-race-"));
        t.after(() => removeBackgroundTestRoot(root));
        configureBackgroundWorkspace(root, root);
        const directory = path.join(root, (await fs.readdir(root))[0]!);
        const file = path.join(directory, `.012345abcdef.${suffix}`);
        await fs.writeFile(file, "temporary launch artifact");
        await fs.utimes(file, new Date(0), new Date(0));
        const original = fsSync[operation];
        const unlink = fsSync.unlinkSync;
        let removed = false;
        t.mock.method(fsSync, operation, function (target: fsSync.PathLike, ...args: unknown[]) {
          if (target === file && !removed) {
            // Deterministically model worker/other-manager cleanup after this
            // manager enumerated the file, using the real filesystem ENOENT.
            removed = true;
            unlink(file);
          }
          return Reflect.apply(original, fsSync, [target, ...args]);
        });
        assert.doesNotThrow(() => configureBackgroundWorkspace(root, root));
        assert.equal(removed, true, "the disappearance window must be exercised");
        assert.equal(fsSync.existsSync(file), false);
      });
    }
  }
});

test("workspace cleanup still propagates inspection and removal I/O failures", async (t) => {
  for (const operation of ["lstatSync", "unlinkSync"] as const) {
    for (const code of ["EACCES", "EIO"]) {
      await t.test(`${operation} ${code}`, async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-cleanup-error-"));
        t.after(() => removeBackgroundTestRoot(root));
        configureBackgroundWorkspace(root, root);
        const directory = path.join(root, (await fs.readdir(root))[0]!);
        const file = path.join(directory, ".012345abcdef.bootstrap.cjs");
        await fs.writeFile(file, "temporary launch artifact");
        await fs.utimes(file, new Date(0), new Date(0));
        const original = fsSync[operation];
        const failure = Object.assign(new Error("fixture storage failure"), { code });
        t.mock.method(fsSync, operation, function (target: fsSync.PathLike, ...args: unknown[]) {
          if (target === file) throw failure;
          return Reflect.apply(original, fsSync, [target, ...args]);
        });
        assert.throws(() => configureBackgroundWorkspace(root, root), (error) => error === failure);
        assert.equal(await fs.readFile(file, "utf8"), "temporary launch artifact");
      });
    }
  }
});

test("workspace cleanup retains its artifact name, age, regular-file, and symlink checks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-cleanup-checks-"));
  t.after(() => removeBackgroundTestRoot(root));
  configureBackgroundWorkspace(root, root);
  const directory = path.join(root, (await fs.readdir(root))[0]!);
  const stale = path.join(directory, ".000000000001.request.json");
  const fresh = path.join(directory, ".000000000002.bootstrap.cjs");
  const nonFile = path.join(directory, ".000000000003.request.json");
  const symbolic = path.join(directory, ".000000000004.bootstrap.cjs");
  const unrelated = path.join(directory, "unrelated.json");
  for (const file of [stale, fresh, symbolic, unrelated]) await fs.writeFile(file, "keep unless eligible");
  await fs.mkdir(nonFile);
  for (const file of [stale, nonFile, symbolic, unrelated]) await fs.utimes(file, new Date(0), new Date(0));
  const lstat = fsSync.lstatSync;
  t.mock.method(fsSync, "lstatSync", function (target: fsSync.PathLike, ...args: unknown[]) {
    const stat = Reflect.apply(lstat, fsSync, [target, ...args]);
    // A synthetic link stat keeps this check portable to Windows hosts that
    // cannot create symlinks, and asserts the explicit no-symlink condition.
    if (target === symbolic) stat.isSymbolicLink = () => true;
    return stat;
  });
  configureBackgroundWorkspace(root, root);
  assert.deepEqual((await fs.readdir(directory)).sort(), [fresh, nonFile, symbolic, unrelated].map((file) => path.basename(file)).sort());
});

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
  // The foreground must read the first cursor before the worker emits the
  // second chunk. A fixed delay lets a loaded CI runner consume both at once.
  const signal = path.join(root, "emit-second");
  const worker = `const fs=require('node:fs');console.log('first');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(signal)})){clearInterval(timer);console.log('second');}},50);setTimeout(()=>{clearInterval(timer);},60000);`;
  const encoded = Buffer.from(worker).toString("base64");
  const started = startBackgroundProcess(`node -e "eval(Buffer.from('${encoded}','base64').toString())"`, process.cwd());
  for (let attempt = 0; attempt < 300 && !backgroundProcessOutput(started.id).includes("first"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const first = readBackgroundProcessOutput(started.id, 0);
  assert.match(first.text, /first/);

  // Reconfiguration simulates a fresh Xiu process discovering the same workspace store.
  configureBackgroundWorkspace(process.cwd(), root);
  assert.equal(listBackgroundProcesses().some((item) => item.id === started.id && item.running), true);
  await fs.writeFile(signal, "ready");
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

async function createFaultWorker(root: string, fault: string): Promise<string> {
  const source = path.join(root, "fault-worker.mjs");
  await fs.writeFile(source, [
    `import fs from 'node:fs';`,
    `const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));`,
    fault,
    `await import(${JSON.stringify(loaderUrl)});`,
    `await import(${JSON.stringify(pathToFileURL(path.resolve("src/background-worker.ts")).href)});`,
  ].join("\n"));
  return source;
}

test("transient terminal metadata contention retries only metadata, never the command", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-terminal-retry-"));
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  const marker = path.join(root, "command-count");
  const faultCount = path.join(root, "fault-count");
  const workload = path.join(root, "once.mjs");
  await fs.writeFile(workload, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'x'); console.log('ran-once');`);
  const source = await createFaultWorker(root, `
const rename = fs.renameSync;
let failed = false;
fs.renameSync = function(from, to) {
  if (to === request.recordFile && !failed && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'completed') {
    failed = true;
    fs.writeFileSync(${JSON.stringify(faultCount)}, 'x');
    throw Object.assign(new Error('terminal-private-canary'), { code: 'EPERM' });
  }
  return rename.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const { id } = startBackgroundProcess(nodeCommand(workload));
  configureBackgroundRuntime();
  const record = await waitForTerminal(id);
  assert.equal(record.state, "completed", JSON.stringify(record));
  assert.equal(await fs.readFile(faultCount, "utf8"), "x");
  assert.equal(await fs.readFile(marker, "utf8"), "x");
  assert.match(backgroundProcessOutput(id), /ran-once/);
  assert.doesNotMatch(backgroundProcessOutput(id), /terminal-private-canary/);
});

test("exhausted terminal metadata writes retain bounded failure evidence without replay", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-terminal-denied-"));
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  const marker = path.join(root, "command-count");
  const faultCount = path.join(root, "fault-count");
  const workload = path.join(root, "once.mjs");
  await fs.writeFile(workload, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'x'); console.log('output-is-not-completion');`);
  const source = await createFaultWorker(root, `
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (to === request.recordFile && !['starting', 'running'].includes(JSON.parse(fs.readFileSync(from, 'utf8')).state)) {
    fs.appendFileSync(${JSON.stringify(faultCount)}, 'x');
    throw Object.assign(new Error('terminal-persistent-private-canary'), { code: 'EACCES' });
  }
  return rename.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const { id } = startBackgroundProcess(nodeCommand(workload));
  configureBackgroundRuntime();
  const record = await waitForTerminal(id);
  assert.equal(record.state, "interrupted", JSON.stringify(record));
  assert.deepEqual(record.failure, { stage: "state-write", code: "EACCES" });
  // Six completion attempts are mandatory. A second six-attempt failure
  // publication is permitted only after owned-tree termination is confirmed.
  assert.match(await fs.readFile(faultCount, "utf8"), /^x{6}(?:x{6})?$/);
  assert.equal(await fs.readFile(marker, "utf8"), "x");
  const output = backgroundProcessOutput(id);
  assert.match(output, /output-is-not-completion/);
  assert.match(output, /state-write failed \(EACCES\)/);
  const evidence = JSON.stringify(record) + output;
  assert.doesNotMatch(evidence, /terminal-persistent-private-canary/);
  assert.ok(evidence.length < 2000);
});

test("an asynchronous output persistence error is recorded without exposing exception text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-output-error-"));
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  const workload = path.join(root, "output.mjs");
  await fs.writeFile(workload, "console.log('trigger-output-write');\n");
  const source = await createFaultWorker(root, `
const append = fs.appendFileSync;
fs.appendFileSync = function(file) {
  if (file === request.outputFile) throw Object.assign(new Error('output-private-canary'), { code: 'ENOSPC' });
  return append.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const { id } = startBackgroundProcess(nodeCommand(workload));
  configureBackgroundRuntime();
  const record = await waitForTerminal(id);
  // The shell can finish before taskkill reaches it on Windows. Without
  // confirmed tree termination, recovery must preserve an unknown outcome.
  assert.ok(["failed", "interrupted"].includes(record.state), JSON.stringify(record));
  assert.deepEqual(record.failure, { stage: "output", code: "ENOSPC" });
  const output = backgroundProcessOutput(id);
  assert.match(output, /output failed \(ENOSPC\)/);
  assert.doesNotMatch(JSON.stringify(record) + output, /output-private-canary/);
});

test("a zero worker exit without terminal publication is not command success", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-missing-terminal-"));
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  const workload = path.join(root, "output.mjs");
  await fs.writeFile(workload, "console.log('output-is-not-completion');\n");
  const source = await createFaultWorker(root, `
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (to === request.recordFile && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'completed') process.exit(0);
  return rename.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const { id } = startBackgroundProcess(nodeCommand(workload));
  configureBackgroundRuntime();
  const record = await waitForTerminal(id);
  assert.equal(record.state, "interrupted", JSON.stringify(record));
  assert.deepEqual(record.failure, { stage: "worker-exit", code: "MISSING_TERMINAL" });
  assert.match(backgroundProcessOutput(id), /output-is-not-completion/);
});

test("invalid failure receipts cannot disclose arbitrary restored fields", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-receipt-validation-"));
  t.after(() => removeBackgroundTestRoot(root));
  configureBackgroundWorkspace(root, root);
  const directory = path.join(root, (await fs.readdir(root))[0]!);
  const id = "abcdef123456";
  const file = path.join(directory, `${id}.json`);
  const receipt = path.join(directory, `${id}.failure.json`);
  const record = { version: 1, id, workspaceId: "fixture", commandPreview: "fixture", state: "running", startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), outputBytes: 0 };
  for (const failure of [{ stage: "secret-receipt-canary", code: "EACCES" }, { stage: "state-write", code: "EACCES", secret: "receipt-canary" }, { stage: "state-write", code: "receipt-canary".repeat(1000) }]) {
    await fs.writeFile(file, JSON.stringify(record));
    await fs.writeFile(receipt, JSON.stringify(failure));
    const listed = listBackgroundProcesses();
    assert.equal(listed[0]?.state, "interrupted");
    assert.equal(listed[0]?.failure, undefined);
    assert.doesNotMatch(JSON.stringify(listed), /canary/);
  }
});

test("a cancellation observed during metadata retry cannot be overwritten by completion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-retry-cancel-"));
  t.after(() => { configureBackgroundRuntime(); return removeBackgroundTestRoot(root); });
  const workload = path.join(root, "output.mjs");
  await fs.writeFile(workload, "console.log('finished-before-record-write');\n");
  const source = await createFaultWorker(root, `
const rename = fs.renameSync;
let failed = false;
fs.renameSync = function(from, to) {
  if (to === request.recordFile && !failed && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'completed') {
    failed = true;
    const current = JSON.parse(fs.readFileSync(to, 'utf8'));
    fs.writeFileSync(to, JSON.stringify({ ...current, state: 'cancelled' }));
    throw Object.assign(new Error('simulated-sharing-contention'), { code: 'EPERM' });
  }
  return rename.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const { id } = startBackgroundProcess(nodeCommand(workload));
  configureBackgroundRuntime();
  const record = await waitForTerminal(id);
  assert.equal(record.state, "cancelled", JSON.stringify(record));
  // Let the bounded retry finish before checking that its stale completion
  // snapshot did not replace the terminal cancellation.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listBackgroundProcesses().find((item) => item.id === id)?.state, "cancelled");
});

test("output failure cannot finish a TERM-ignoring command before its owned process stops", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-live-output-error-"));
  const pidFile = path.join(root, "workload.pid");
  let workloadPid: number | undefined;
  const alive = async (): Promise<boolean> => {
    if (!workloadPid) return false;
    try { process.kill(workloadPid, 0); } catch { return false; }
    if (process.platform === "linux") {
      try { if (/^\d+ \(.*\) Z /.test(await fs.readFile(`/proc/${workloadPid}/stat`, "utf8"))) return false; } catch { return false; }
    }
    return true;
  };
  t.after(async () => {
    configureBackgroundRuntime();
    configureBackgroundWorkspace(root, root);
    await stopAllBackgroundProcesses();
    if (await alive()) try { process.kill(workloadPid!, "SIGKILL"); } catch {}
    await removeBackgroundTestRoot(root);
  });
  const workload = path.join(root, "long-output.mjs");
  await fs.writeFile(workload, `import fs from 'node:fs';
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => console.log('trigger-output-write'), 200);
setInterval(() => {}, 1000);
`);
  const source = await createFaultWorker(root, `
const append = fs.appendFileSync;
fs.appendFileSync = function(file) {
  if (file === request.outputFile) throw Object.assign(new Error('live-output-private-canary'), { code: 'ENOSPC' });
  return append.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const { id } = startBackgroundProcess(nodeCommand(workload));
  configureBackgroundRuntime();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !workloadPid) {
    try { workloadPid = Number(await fs.readFile(pidFile, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(workloadPid);
  assert.equal(await alive(), true, "the fixture must be alive before output failure");
  let observedActiveAfterFailure = false;
  while (Date.now() < deadline && await alive()) {
    const record = listBackgroundProcesses().find((item) => item.id === id);
    // Recheck liveness after the snapshot to avoid treating a just-completed
    // Windows taskkill as premature state publication.
    if (await alive()) {
      assert.equal(record?.running, true, JSON.stringify(record));
      if (record.failure) observedActiveAfterFailure = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await alive(), false, "owned workload must not leak after output failure");
  if (process.platform !== "win32") assert.equal(observedActiveAfterFailure, true);
  const record = await waitForTerminal(id);
  assert.ok(["failed", "interrupted"].includes(record.state), JSON.stringify(record));
  assert.deepEqual(record.failure, { stage: "output", code: "ENOSPC" });
  assert.doesNotMatch(JSON.stringify(record) + backgroundProcessOutput(id), /live-output-private-canary/);
});

test("Windows background cleanup resolves taskkill under SystemRoot instead of PATH", async () => {
  for (const [file, expectedCalls] of [["src/background.ts", 1], ["src/background-worker.ts", 1]] as const) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(source, /spawn\(["']taskkill(?:\.exe)?["']/);
    const absoluteCalls = source.match(/spawn\(path\.join\(process\.env\.SystemRoot \?\? "C:\\\\Windows", "System32", "taskkill\.exe"\),/g) ?? [];
    assert.equal(absoluteCalls.length, expectedCalls, `${file} must use the system taskkill path for every cleanup call`);
  }
});

async function withMockedForegroundStop(
  platform: "win32" | "linux",
  setup: (state: { alive: Set<number>; helperKills: string[]; spawnCalls: unknown[][]; signals: Array<[number, string | number | undefined]> }) => {
    spawn?: (...args: unknown[]) => EventEmitter;
    signal?: (pid: number, signal: string | number | undefined) => void;
  },
  run: (fixture: { id: string; file: string; state: { alive: Set<number>; helperKills: string[]; spawnCalls: unknown[][]; signals: Array<[number, string | number | undefined]> } }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-stop-mock-"));
  configureBackgroundWorkspace(root, root);
  const directory = path.join(root, (await fs.readdir(root))[0]!);
  const id = "aabbccddeeff";
  const file = path.join(directory, `${id}.json`);
  await fs.writeFile(file, JSON.stringify({ version: 1, id, workspaceId: "fixture", commandPreview: "fixture", state: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pid: 100001, childPid: 100002, outputBytes: 0 }));
  const state = { alive: new Set([100001, 100002]), helperKills: [] as string[], spawnCalls: [] as unknown[][], signals: [] as Array<[number, string | number | undefined]> };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalKill = process.kill;
  const originalSpawn = childProcess.spawn;
  const hooks = setup(state);
  try {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (state.alive.has(pid) || (pid === -100001 && state.alive.size > 0)) return true;
        throw Object.assign(new Error("fixture process absent"), { code: "ESRCH" });
      }
      state.signals.push([pid, signal]);
      hooks.signal?.(pid, signal);
      return true;
    }) as typeof process.kill;
    childProcess.spawn = ((...args: unknown[]) => {
      state.spawnCalls.push(args);
      if (!hooks.spawn) throw new Error("Unexpected mocked spawn");
      return hooks.spawn(...args);
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    await run({ id, file, state });
  } finally {
    process.kill = originalKill;
    childProcess.spawn = originalSpawn;
    Object.defineProperty(process, "platform", originalPlatform);
    syncBuiltinESMExports();
    await removeBackgroundTestRoot(root);
  }
}

function mockedCleanupHelper(state: { helperKills: string[] }, outcome?: number | "error"): EventEmitter {
  const child = new EventEmitter();
  Object.assign(child, { kill: (signal: string) => { state.helperKills.push(signal); return true; }, unref: () => child });
  if (outcome !== undefined) setImmediate(() => {
    if (outcome === "error") child.emit("error", Object.assign(new Error("private-helper-error-canary"), { code: "ENOENT" }));
    else child.emit("exit", outcome);
  });
  return child;
}

test("foreground stop keeps live PIDs active after a Windows cleanup error", async () => {
  await withMockedForegroundStop("win32", (state) => ({ spawn: () => mockedCleanupHelper(state, "error") }), async ({ id, state }) => {
    await assert.rejects(stopBackgroundProcess(id), /XIU_BACKGROUND_STOP_UNCONFIRMED/);
    const record = listBackgroundProcesses().find((item) => item.id === id);
    assert.equal(record?.running, true);
    assert.deepEqual(record?.failure, { stage: "stop", code: "STOP_UNCONFIRMED" });
    assert.deepEqual([...state.alive], [100001, 100002]);
    assert.equal(state.spawnCalls.length, 2);
    assert.doesNotMatch(JSON.stringify(record), /private-helper-error-canary/);
  });
});

test("foreground stop bounds a stalled Windows helper and does not claim cancellation", async () => {
  await withMockedForegroundStop("win32", (state) => {
    state.alive.delete(100002);
    return { spawn: () => mockedCleanupHelper(state) };
  }, async ({ id, state }) => {
    const started = Date.now();
    await assert.rejects(stopBackgroundProcess(id), /cleanup timed out/);
    assert.ok(Date.now() - started < 5_000, "helper timeout and liveness confirmation must be bounded");
    assert.deepEqual(state.helperKills, ["SIGKILL"]);
    assert.equal(listBackgroundProcesses().find((item) => item.id === id)?.running, true);
    assert.deepEqual(listBackgroundProcesses()[0]?.failure, { stage: "stop", code: "STOP_TIMEOUT" });
  });
});

test("successful taskkill output alone cannot cancel a still-live child", async () => {
  await withMockedForegroundStop("win32", (state) => ({ spawn: () => {
    state.alive.delete(100001);
    return mockedCleanupHelper(state, 0);
  } }), async ({ id, state }) => {
    await assert.rejects(stopBackgroundProcess(id), /termination could not be confirmed/);
    assert.equal(listBackgroundProcesses()[0]?.running, true);
    assert.deepEqual([...state.alive], [100002]);
  });
});

test("confirmed Windows stop cancels only after both saved PIDs disappear", async () => {
  await withMockedForegroundStop("win32", (state) => ({ spawn: () => {
    state.alive.clear();
    return mockedCleanupHelper(state, 0);
  } }), async ({ id, state }) => {
    await stopBackgroundProcess(id);
    assert.equal(listBackgroundProcesses()[0]?.state, "cancelled");
    assert.equal(state.spawnCalls.length, 1);
    assert.match(String(state.spawnCalls[0]?.[0]), /System32[\\/]taskkill\.exe$/);
  });
});

test("POSIX foreground stop checks a live child after its worker exits", async () => {
  await withMockedForegroundStop("linux", (state) => ({ signal: (pid) => { if (pid === -100001) state.alive.delete(100001); } }), async ({ id, state }) => {
    await assert.rejects(stopBackgroundProcess(id), /XIU_BACKGROUND_STOP_UNCONFIRMED/);
    assert.deepEqual(state.signals, [[-100001, "SIGTERM"], [-100001, "SIGKILL"]]);
    assert.equal(listBackgroundProcesses()[0]?.running, true);
    assert.deepEqual([...state.alive], [100002]);
  });
});

test("a missing-PID starting request can still be cancelled without process commands", async () => {
  await withMockedForegroundStop("win32", () => ({}), async ({ id, file, state }) => {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    delete record.pid; delete record.childPid; record.state = "starting";
    await fs.writeFile(file, JSON.stringify(record));
    await stopBackgroundProcess(id);
    assert.equal(listBackgroundProcesses()[0]?.state, "cancelled");
    assert.equal(state.spawnCalls.length, 0);
    assert.equal(state.signals.length, 0);
  });
});

test("foreground stop preserves a terminal result published while cleanup was pending", async () => {
  let publish: (() => Promise<void>) | undefined;
  await withMockedForegroundStop("win32", (state) => ({ spawn: () => {
    const child = mockedCleanupHelper(state);
    setImmediate(() => { void publish!().then(() => { state.alive.clear(); child.emit("exit", 0); }); });
    return child;
  } }), async ({ id, file }) => {
    publish = async () => {
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(file, JSON.stringify({ ...record, state: "completed", exitCode: 0 }));
    };
    await stopBackgroundProcess(id);
    assert.equal(listBackgroundProcesses()[0]?.state, "completed");
  });
});

test("foreground stop does not cancel a newly published live startup PID", async () => {
  let publish: (() => Promise<void>) | undefined;
  await withMockedForegroundStop("win32", (state) => ({ spawn: () => {
    const child = mockedCleanupHelper(state);
    setImmediate(() => { void publish!().then(() => { state.alive.clear(); state.alive.add(100003); child.emit("exit", 0); }); });
    return child;
  } }), async ({ id, file }) => {
    publish = async () => {
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(file, JSON.stringify({ ...record, childPid: 100003 }));
    };
    await assert.rejects(stopBackgroundProcess(id), /XIU_BACKGROUND_STOP_UNCONFIRMED/);
    assert.equal(listBackgroundProcesses()[0]?.running, true);
  });
});

async function fixtureProcessAlive(pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") {
    try { if (/^\d+ \(.*\) Z /.test(await fs.readFile(`/proc/${pid}/stat`, "utf8"))) return false; } catch { return false; }
  }
  return true;
}

async function assertFixtureStopsWithoutFalseCompletion(id: string, pidFile: string): Promise<number> {
  const deadline = Date.now() + 15_000;
  let pid: number | undefined;
  while (Date.now() < deadline && !pid) {
    try { pid = Number(await fs.readFile(pidFile, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid, "fixture must publish readiness after installing its TERM handler");
  let observedLive = false;
  while (Date.now() < deadline && await fixtureProcessAlive(pid)) {
    observedLive = true;
    const record = listBackgroundProcesses().find((item) => item.id === id);
    if (await fixtureProcessAlive(pid)) assert.equal(record?.running, true, JSON.stringify(record));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(observedLive, true);
  assert.equal(await fixtureProcessAlive(pid), false, "owned fixture must be stopped despite ignoring TERM");
  return pid;
}

test("startup metadata failure installs cleanup guards before a TERM-ignoring child can leak", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-startup-cleanup-"));
  const pidFile = path.join(root, "ready.pid");
  let workerPid: number | undefined;
  t.after(async () => {
    configureBackgroundRuntime();
    if (workerPid) try { process.kill(-workerPid, "SIGKILL"); } catch {}
    await removeBackgroundTestRoot(root);
  });
  const workload = path.join(root, "ignore-term.mjs");
  await fs.writeFile(workload, `import fs from 'node:fs';
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const source = await createFaultWorker(root, `
const rename = fs.renameSync;
const pause = new Int32Array(new SharedArrayBuffer(4));
fs.renameSync = function(from, to) {
  if (to === request.recordFile && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'running') {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
    if (!fs.existsSync(${JSON.stringify(pidFile)})) throw new Error('fixture readiness failed');
    throw Object.assign(new Error('startup-metadata-private-canary'), { code: 'EPERM' });
  }
  return rename.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const started = startBackgroundProcess(nodeCommand(workload));
  workerPid = started.pid;
  configureBackgroundRuntime();
  await assertFixtureStopsWithoutFalseCompletion(started.id, pidFile);
  const directory = (await fs.readdir(root, { withFileTypes: true })).find((entry) => entry.isDirectory())!;
  const record = JSON.parse(await fs.readFile(path.join(root, directory.name, `${started.id}.json`), "utf8"));
  assert.equal(record.childPid, undefined, "regression must cover failure before child PID persistence");
  assert.notEqual(record.state, "completed");
  const receipt = await fs.readFile(path.join(root, directory.name, `${started.id}.failure.json`), "utf8");
  assert.deepEqual(JSON.parse(receipt), { stage: "worker", code: "EPERM" });
  assert.doesNotMatch(receipt, /startup-metadata-private-canary/);
});

test("output failure still escalates after the shell closes a redirected descendant's pipes", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-redirected-child-"));
  const pidFile = path.join(root, "ready.pid");
  let workerPid: number | undefined;
  t.after(async () => {
    configureBackgroundRuntime();
    if (workerPid) try { process.kill(-workerPid, "SIGKILL"); } catch {}
    await removeBackgroundTestRoot(root);
  });
  const descendant = path.join(root, "descendant.mjs");
  await fs.writeFile(descendant, `import fs from 'node:fs';
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const workload = path.join(root, "parent.mjs");
  await fs.writeFile(workload, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });
child.unref();
const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(ready); console.log('trigger-output-error'); } }, 10);
setInterval(() => {}, 1000);
`);
  const source = await createFaultWorker(root, `
const append = fs.appendFileSync;
fs.appendFileSync = function(file) {
  if (file === request.outputFile) throw Object.assign(new Error('redirected-private-canary'), { code: 'ENOSPC' });
  return append.apply(this, arguments);
};`);
  configureBackgroundWorkspace(root, root);
  configureBackgroundRuntime(process.execPath, source);
  const started = startBackgroundProcess(nodeCommand(workload));
  workerPid = started.pid;
  configureBackgroundRuntime();
  await assertFixtureStopsWithoutFalseCompletion(started.id, pidFile);
  const record = listBackgroundProcesses().find((item) => item.id === started.id);
  assert.notEqual(record?.state, "completed");
  assert.deepEqual(record?.failure, { stage: "output", code: "ENOSPC" });
});

test("foreground stop escalates for an owned group after saved PIDs exit", async () => {
  await withMockedForegroundStop("linux", (state) => ({ signal: (pid, signal) => {
    if (pid !== -100001) return;
    if (signal === "SIGTERM") { state.alive.clear(); state.alive.add(100003); }
    else if (signal === "SIGKILL") state.alive.clear();
  } }), async ({ id, state }) => {
    await stopBackgroundProcess(id);
    assert.deepEqual(state.signals, [[-100001, "SIGTERM"], [-100001, "SIGKILL"]]);
    assert.equal(listBackgroundProcesses()[0]?.state, "cancelled");
  });
});

test("unconfirmed group escalation retains active evidence with no saved PID alive", async () => {
  await withMockedForegroundStop("linux", (state) => ({ signal: (pid, signal) => {
    if (pid !== -100001) return;
    if (signal === "SIGTERM") { state.alive.clear(); state.alive.add(100003); }
    else if (signal === "SIGKILL") throw Object.assign(new Error("fixture signal denied"), { code: "EPERM" });
  } }), async ({ id, file, state }) => {
    await assert.rejects(stopBackgroundProcess(id), /XIU_BACKGROUND_STOP_UNCONFIRMED/);
    assert.deepEqual([...state.alive], [100003]);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...record, updatedAt: new Date(0).toISOString() }));
    assert.equal(listBackgroundProcesses()[0]?.running, true, "group liveness must prevent false interruption after the grace period");
  });
});

test("a premature concurrent cancellation cannot hide an unconfirmed live group", async () => {
  let cancel: (() => Promise<void>) | undefined;
  await withMockedForegroundStop("win32", (state) => ({ spawn: () => {
    const child = mockedCleanupHelper(state);
    setImmediate(() => { void cancel!().then(() => child.emit("exit", 0)); });
    return child;
  } }), async ({ id, file }) => {
    cancel = async () => {
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(file, JSON.stringify({ ...record, state: "cancelled" }));
    };
    await assert.rejects(stopBackgroundProcess(id), /XIU_BACKGROUND_STOP_UNCONFIRMED/);
    assert.equal(listBackgroundProcesses()[0]?.running, true);
    assert.deepEqual(listBackgroundProcesses()[0]?.failure, { stage: "stop", code: "STOP_UNCONFIRMED" });
  });
});

test("directed worker stop cannot publish cancellation before redirected descendants stop", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-directed-stop-"));
  const pidFile = path.join(root, "ready.pid");
  let workerPid: number | undefined;
  t.after(async () => {
    if (workerPid) try { process.kill(-workerPid, "SIGKILL"); } catch {}
    await removeBackgroundTestRoot(root);
  });
  const descendant = path.join(root, "descendant.mjs");
  await fs.writeFile(descendant, `import fs from 'node:fs';
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const workload = path.join(root, "parent.mjs");
  await fs.writeFile(workload, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref();
setInterval(() => {}, 1000);
`);
  configureBackgroundWorkspace(root, root);
  const started = startBackgroundProcess(nodeCommand(workload));
  workerPid = started.pid;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await fs.readFile(pidFile, "utf8")) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(workerPid);
  assert.ok(await fs.readFile(pidFile, "utf8"));
  process.kill(workerPid, "SIGTERM");
  await assertFixtureStopsWithoutFalseCompletion(started.id, pidFile);
  const record = listBackgroundProcesses().find((item) => item.id === started.id);
  assert.notEqual(record?.state, "cancelled", "only the foreground can confirm the directed stop's full group disappearance");
});

test("directed stop retains a final unterminated output line after pipe closure", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-background-stop-partial-"));
  const ready = path.join(root, "ready");
  let workerPid: number | undefined;
  t.after(async () => {
    if (workerPid) try { process.kill(-workerPid, "SIGKILL"); } catch {}
    await removeBackgroundTestRoot(root);
  });
  const workload = path.join(root, "partial.mjs");
  await fs.writeFile(workload, `import fs from 'node:fs';
process.stdout.write('partial-stop-output', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));
setInterval(() => {}, 1000);
`);
  configureBackgroundWorkspace(root, root);
  const started = startBackgroundProcess(nodeCommand(workload));
  workerPid = started.pid;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await fs.readFile(ready, "utf8")) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(workerPid);
  assert.equal(await fs.readFile(ready, "utf8"), "ready");
  process.kill(workerPid, "SIGTERM");
  while (Date.now() < deadline && !backgroundProcessOutput(started.id).includes("partial-stop-output")) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(backgroundProcessOutput(started.id), /partial-stop-output/);
  assert.notEqual(listBackgroundProcesses().find((item) => item.id === started.id)?.state, "cancelled");
});
