import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { trustWorkspace } from "../src/trust.js";
import { loadTaskChangeHistory } from "../src/task-change-history.js";
import { TaskRunJournal } from "../src/task-run.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

const FINAL_ANSWER = "Hello from the fake model.";

/** Minimal OpenAI-compatible server: answers the capability probe with a tool call and every other request with one final message. */
async function startFakeModelServer(t: TestContext): Promise<{ baseURL: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      const tools = Array.isArray(parsed.tools) ? parsed.tools as Array<{ function?: { name?: string } }> : [];
      const probe = tools.find((tool) => tool.function?.name === "xiu_capability_probe");
      const message = probe
        ? { role: "assistant", content: null, tool_calls: [{ id: "probe-1", type: "function", function: { name: "xiu_capability_probe", arguments: JSON.stringify({ value: "OK" }) } }] }
        : { role: "assistant", content: FINAL_ANSWER };
      const completion = {
        id: "chatcmpl-fake", object: "chat.completion", created: 1, model: parsed.model,
        choices: [{ index: 0, message, finish_reason: probe ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      };
      if (parsed.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = probe
          ? { role: "assistant", tool_calls: [{ index: 0, id: "probe-1", type: "function", function: { name: "xiu_capability_probe", arguments: JSON.stringify({ value: "OK" }) } }] }
          : { role: "assistant", content: FINAL_ANSWER };
        response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], usage: null })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: probe ? "tool_calls" : "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completion));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function fixture(t: TestContext, options: { trusted: boolean; baseURL?: string }) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-json-cli-"));
  const home = path.join(base, "home");
  await fs.mkdir(path.join(base, "project"));
  // The CLI keys per-workspace state (the task-run journal) by the path it is started in, so start it in the
  // real path: os.tmpdir() is a symlink on macOS (/var → /private/var) and may be a short 8.3 name on Windows.
  const cwd = await fs.realpath(path.join(base, "project"));
  await fs.mkdir(path.join(home, ".xiu"), { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (options.trusted) await trustWorkspace(cwd, path.join(home, ".xiu", "trusted-workspaces.json"));
  await fs.writeFile(path.join(home, ".xiu", "providers.json"), JSON.stringify({ version: 5, active: "fake", profiles: [{
    id: "fake", name: "Fake", kind: "openai", model: "fake-model", baseURL: options.baseURL ?? "http://127.0.0.1:9/v1", apiKeyEnv: "FAKE_API_KEY",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }] }), "utf8");
  return { cwd, home };
}

async function runCli(args: string[], cwd: string, home: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_API_KEY: "fake-key-not-a-secret", OPENAI_API_KEY: "", AGNES_API_KEY: "", ANTHROPIC_API_KEY: "", XIU_PROVIDER: "", FORCE_COLOR: "0", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI --json run timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

function parseLines(stdout: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => {
    try { return JSON.parse(line) as { type: string; payload: Record<string, unknown> }; }
    catch { throw new Error(`stdout contained a non-JSON line: ${JSON.stringify(line)}\nfull stdout:\n${stdout}`); }
  });
}

test("--json streams every runtime event of a one-shot task as JSON Lines and ends with a result", { timeout: 90_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL: server.baseURL });
  const run = await runCli(["--json", "--provider", "fake", "--yes", "Say hello"], cwd, home);
  const lines = parseLines(run.stdout);
  assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  assert.equal(lines[0]?.type, "session.started");
  assert.equal(lines[0]?.payload.provider, "fake");
  assert.equal(lines[0]?.payload.model, "fake-model");
  const types = lines.map((line) => line.type);
  assert.ok(types.includes("task.started"), types.join(","));
  assert.ok(types.includes("model.started"), types.join(","));
  assert.ok(types.includes("task.finished"), types.join(","));
  const answer = lines.find((line) => line.type === "assistant.message");
  assert.equal(answer?.payload.text, FINAL_ANSWER);
  const finished = lines.find((line) => line.type === "task.finished");
  assert.equal(finished?.payload.state, "completed");
  const result = lines.at(-1);
  assert.equal(result?.type, "result");
  assert.equal(result?.payload.outcome, "completed");
  assert.equal(result?.payload.success, true);
  assert.equal(result?.payload.exitCode, 0);
  assert.equal((result?.payload.stats as { modelCalls: number }).modelCalls >= 1, true);
  assert.equal(lines.filter((line) => line.type === "result").length, 1);
  // Human-readable startup text moved to stderr instead of polluting the stream.
  assert.match(run.stderr, /Xiu - fake\/fake-model/);
  assert.doesNotMatch(run.stdout, /fake-key-not-a-secret/);
  assert.ok(server.requests.length >= 1, "the fake model received the task");
  // The finished run's bounded change record is saved next to the sessions so /diff run:<selector> can replay it.
  const runFiles = (await fs.readdir(path.join(home, ".xiu", "task-runs"), { recursive: true })).filter((name) => name.endsWith(".json")).map((name) => path.basename(name));
  assert.equal(runFiles.length, 1, runFiles.join(","));
  const historyFiles = await fs.readdir(path.join(cwd, ".xiu", "task-change-history"));
  assert.deepEqual(historyFiles, runFiles);
  const history = await loadTaskChangeHistory(cwd, path.basename(runFiles[0]!, ".json"));
  assert.equal(history?.view, "task");
  assert.deepEqual(history?.changes, []);
});

test("--json refuses to prompt for workspace trust and reports a not_started result", { timeout: 60_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { trusted: false });
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "UNTRUSTED-JSON-CANARY", "utf8");
  const run = await runCli(["--json", "--provider", "fake", "--yes", "inspect this workspace"], cwd, home);
  assert.equal(run.exitCode, 1, run.stderr);
  const lines = parseLines(run.stdout);
  assert.equal(lines.length, 1, run.stdout);
  assert.equal(lines[0]?.type, "result");
  assert.equal(lines[0]?.payload.outcome, "not_started");
  assert.equal(lines[0]?.payload.exitCode, 1);
  assert.match(String(lines[0]?.payload.error), /not trusted/);
  assert.doesNotMatch(run.stdout + run.stderr, /Do you trust the files in this workspace\?/);
  assert.doesNotMatch(run.stdout + run.stderr, /UNTRUSTED-JSON-CANARY/);
});

test("--json without a task is a usage error that writes nothing to stdout", { timeout: 60_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { trusted: true });
  const run = await runCli(["--json", "--provider", "fake"], cwd, home);
  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /--json requires exactly one one-shot task/);
});

test("--trust-workspace grants trust for this process only and never writes the trust list", { timeout: 90_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: false, baseURL: server.baseURL });
  const run = await runCli(["--trust-workspace", "--json", "--provider", "fake", "Say hello"], cwd, home);
  const lines = parseLines(run.stdout);
  assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  assert.equal(lines[0]?.type, "session.started");
  assert.equal(lines.at(-1)?.payload.outcome, "completed");
  const trustFile = path.join(home, ".xiu", "trusted-workspaces.json");
  const stored = await fs.readFile(trustFile, "utf8").catch(() => "");
  assert.ok(!stored.includes(path.basename(cwd)), `the workspace must not be added to the trust list: ${stored}`);
  // The grant does not survive the process: the next run without the flag is still untrusted.
  const again = await runCli(["--json", "--provider", "fake", "Say hello"], cwd, home);
  assert.equal(again.exitCode, 1);
  assert.equal(parseLines(again.stdout)[0]?.payload.outcome, "not_started");
});

/** A PID that certainly belongs to no live process: a child that has already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  assert.ok(child.pid);
  return child.pid;
}

/**
 * Leaves the journal in the state a crashed Xiu leaves behind: a `running` record whose owner process is gone.
 * The record is written through the real journal so its shape is whatever the CLI expects.
 */
async function leaveInterruptedRun(cwd: string, home: string): Promise<{ runId: string; file: string }> {
  const root = path.join(home, ".xiu", "task-runs");
  const journal = new TaskRunJournal(cwd, root);
  const record = await journal.begin({ sessionId: "crashed-session", task: "refactor the parser", providerId: "fake", model: "fake-model" });
  const directory = path.join(root, journal.workspaceId);
  const owner = { ownerPid: await exitedPid(), ownerStartedAt: "2000-01-01T00:00:00.000Z" };
  const file = path.join(directory, `${record.runId}.json`);
  await fs.writeFile(file, `${JSON.stringify({ ...record, ...owner })}\n`);
  const lockFile = path.join(directory, ".active.lock");
  await fs.writeFile(lockFile, `${JSON.stringify({ ...JSON.parse(await fs.readFile(lockFile, "utf8")), ...owner })}\n`);
  return { runId: record.runId, file };
}

async function recordStatus(file: string): Promise<string> {
  return (JSON.parse(await fs.readFile(file, "utf8")) as { status: string }).status;
}

test("--json with an interrupted task in the workspace reports not_started instead of exiting 0 without a result", { timeout: 60_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL: server.baseURL });
  const interrupted = await leaveInterruptedRun(cwd, home);
  const run = await runCli(["--json", "--provider", "fake", "--yes", "write a summary"], cwd, home);
  assert.equal(run.exitCode, 1, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  const lines = parseLines(run.stdout);
  assert.equal(lines.length, 1, run.stdout);
  assert.equal(lines[0]?.type, "result");
  assert.equal(lines[0]?.payload.outcome, "not_started");
  assert.equal(lines[0]?.payload.success, false);
  assert.equal(lines[0]?.payload.exitCode, 1);
  assert.match(String(lines[0]?.payload.error), new RegExp(`Interrupted task ${interrupted.runId.slice(0, 8)} was detected`));
  assert.match(String(lines[0]?.payload.error), new RegExp(`run xiu recover abandon ${interrupted.runId.slice(0, 8)} to abandon it explicitly`));
  // The explanation is human output and therefore on stderr; the model was never contacted; the record is untouched.
  assert.match(run.stderr, /Interrupted task .* was detected/);
  assert.equal(server.requests.length, 0, "the task must not reach the model");
  assert.equal(await recordStatus(interrupted.file), "running");
});

test("a one-shot task with an interrupted run exits 1 and leaves the record for an interactive decision", { timeout: 60_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL: server.baseURL });
  const interrupted = await leaveInterruptedRun(cwd, home);
  const run = await runCli(["--provider", "fake", "--yes", "write a summary"], cwd, home);
  assert.equal(run.exitCode, 1, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  assert.match(run.stdout, /Interrupted task .* was detected\. Start xiu without a task in an interactive terminal/);
  assert.equal(server.requests.length, 0);
  assert.equal(await recordStatus(interrupted.file), "running");
});

test("a piped interactive start never resumes or abandons an interrupted run on its own", { timeout: 60_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL: server.baseURL });
  const interrupted = await leaveInterruptedRun(cwd, home);
  // No task argument: the CLI would show the resume/abandon/exit menu, but stdin is a pipe that ends at once.
  const run = await runCli(["--provider", "fake", "--yes"], cwd, home);
  assert.equal(run.exitCode, 1, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  assert.match(run.stdout, /Interrupted task detected: refactor the parser/);
  assert.match(run.stderr, /How should the interrupted task be handled\? There is no interactive terminal to choose from, so this counts as cancelled/);
  assert.doesNotMatch(run.stdout + run.stderr, /was abandoned|xiu> /);
  assert.equal(server.requests.length, 0);
  assert.equal(await recordStatus(interrupted.file), "running");
});

test("--json with an unreadable task-run journal reports not_started rather than starting over the corrupt record", { timeout: 60_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL: server.baseURL });
  const journal = new TaskRunJournal(cwd, path.join(home, ".xiu", "task-runs"));
  const directory = path.join(home, ".xiu", "task-runs", journal.workspaceId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "corrupt.json"), "{ not json", "utf8");
  const run = await runCli(["--json", "--provider", "fake", "--yes", "write a summary"], cwd, home);
  assert.equal(run.exitCode, 1, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  const lines = parseLines(run.stdout);
  assert.equal(lines.length, 1, run.stdout);
  assert.equal(lines[0]?.type, "result");
  assert.equal(lines[0]?.payload.outcome, "not_started");
  assert.match(String(lines[0]?.payload.error), /task recovery journal could not be read/);
  assert.equal(server.requests.length, 0);
});
