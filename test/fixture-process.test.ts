import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { FixtureProcess, cleanupFixtureProcesses } from "./fixtures/fixture-process.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-fixture-process-"));
  const processes: FixtureProcess[] = [];
  t.after(() => cleanupFixtureProcesses(processes, () => fs.rm(root, { recursive: true, force: true })), { timeout: 10_000 });
  function start(script: string, deadlines?: { stop: number; force: number }) {
    const owned = new FixtureProcess(spawn(process.execPath, ["-e", script], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }), deadlines);
    processes.push(owned);
    return owned;
  }
  return { root, processes, start };
}

test("fixture exit and stop wait for final output closure within their existing bound", { timeout: 5_000 }, async () => {
  for (const action of ["exit", "stop"]) {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const child = Object.assign(events, {
      pid: 12345, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout, stderr: new PassThrough(),
      kill() { events.emit("exit", 0, null); return true; }, unref() {},
    }) as unknown as ChildProcessWithoutNullStreams;
    const owned = new FixtureProcess(child, { stop: 100, force: 1_000 });
    let output = "", settled = false;
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    // Operational errors do not prove that an already spawned child exited.
    child.emit("error", new Error("fixture signal failure"));
    assert.equal(owned.exited, false);
    const operation = (action === "stop" ? owned.stop() : owned.waitForExit(1_100)).then(() => { settled = true; });
    if (action === "exit") child.emit("exit", 0, null);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(owned.exited, true);
      assert.equal(settled, false, `${action} must not complete before close`);
      assert.equal(child.stdout.destroyed, false);
      stdout.write("final diagnostic");
      child.emit("close", 0, null);
      await operation;
      assert.equal(output, "final diagnostic");
    } finally {
      child.emit("close", 0, null);
      await operation;
      await owned.stop();
    }
  }
});

test("fixture processes observe spawn errors and early nonzero exits before cleanup", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const missing = new FixtureProcess(spawn(process.execPath, ["-e", ""], { cwd: path.join(f.root, "missing"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
  f.processes.push(missing);
  await assert.rejects(missing.waitForExit(5_000), { code: "ENOENT" });
  assert.equal(missing.exited, true);
  assert.equal((missing.spawnError as NodeJS.ErrnoException).code, "ENOENT");
  const failed = f.start("process.exit(7)");
  assert.equal(await failed.waitForExit(5_000), 7);
  await cleanupFixtureProcesses(f.processes, async () => {
    assert.ok(f.processes.every((owned) => owned.exited));
  });
});

test("fixture assertion failure stops its live child before removing the Windows working directory", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const workingDirectory = path.join(f.root, "child-workspace");
  await fs.mkdir(workingDirectory);
  const helper = new URL("./fixtures/fixture-process.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import fs from 'node:fs/promises';
    import test from 'node:test';
    import { FixtureProcess, cleanupFixtureProcesses } from ${JSON.stringify(helper)};
    test('intentional fixture assertion failure', { timeout: 5_000 }, async (t) => {
      const processes = [];
      t.after(() => cleanupFixtureProcesses(processes, async () => {
        assert.ok(processes.every((owned) => owned.exited), 'exit must precede directory removal');
        await fs.rm(${JSON.stringify(workingDirectory)}, { recursive: true, force: true });
        console.log('FIXTURE_CLEANUP_CONFIRMED');
      }), { timeout: 8_000 });
      const owned = new FixtureProcess(spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
        cwd: ${JSON.stringify(workingDirectory)}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      }));
      processes.push(owned);
      await once(owned.child.stdout, 'data', { signal: AbortSignal.timeout(3_000) });
      assert.fail('intentional assertion before normal CLI close');
    });
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const runner = new FixtureProcess(spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
    env, cwd: f.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }));
  f.processes.push(runner);
  let output = "";
  runner.child.stdout.on("data", (chunk) => { output += String(chunk); });
  runner.child.stderr.on("data", (chunk) => { output += String(chunk); });
  assert.equal(await runner.waitForExit(12_000), 1, output);
  assert.match(output, /intentional assertion before normal CLI close/);
  assert.match(output, /FIXTURE_CLEANUP_CONFIRMED/);
  await assert.rejects(fs.stat(workingDirectory), { code: "ENOENT" });
});

test("fixture cleanup still stops every child when directory removal fails", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const children = [f.start("setInterval(() => {}, 1000)"), f.start("setInterval(() => {}, 1000)")];
  await assert.rejects(cleanupFixtureProcesses(children, async () => {
    assert.ok(children.every((owned) => owned.exited));
    throw Object.assign(new Error("fixture removal failed"), { code: "EBUSY" });
  }), { code: "EBUSY" });
  assert.ok(children.every((owned) => owned.exited));
});

test("fixture stop escalates an ignored termination signal and confirms forced exit", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const owned = f.start("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)", { stop: 50, force: 2_000 });
  await once(owned.child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
  await owned.stop();
  assert.equal(owned.exited, true);
  assert.equal(owned.child.signalCode, "SIGKILL");
});

test("fixture termination failures are bounded, keep the failure, and release worker handles", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const owned = f.start("console.log('ready'); setInterval(() => {}, 1000)", { stop: 20, force: 20 });
  await once(owned.child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
  const kill = owned.child.kill.bind(owned.child);
  const signals: unknown[] = [];
  t.mock.method(owned.child, "kill", (signal: unknown) => { signals.push(signal); return true; });
  let removed = false;
  try {
    await assert.rejects(cleanupFixtureProcesses([owned], async () => { removed = true; }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /termination was not confirmed after SIGKILL/);
      return true;
    });
    assert.equal(removed, false, "do not delete a working directory with an unconfirmed live child");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(owned.exited, false);
    assert.equal(owned.child.stdin.destroyed, true);
    assert.equal(owned.child.stdout.destroyed, true);
    assert.equal(owned.child.stderr.destroyed, true);
  } finally {
    kill("SIGKILL");
    await owned.waitForExit(5_000);
    // The deliberate stop failure stays rejected; this test drained it itself.
    f.processes.splice(f.processes.indexOf(owned), 1);
  }
});
