import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { TaskRunJournal } from "../src/task-run.js";
import { trustWorkspace } from "../src/trust.js";

/**
 * End-to-end: `xiu recover [status|abandon <id>]` is the non-interactive way out of a crashed run.
 * A crashed run's record is left through the real journal, then the real CLI is driven as a
 * script would drive it: status (exit 2), a wrong id (nothing changes), the right id (abandoned),
 * and finally a `--json` task that runs now that the record is abandoned.
 */

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

/** Minimal OpenAI-compatible server: a tool call for the capability probe, one final message otherwise. */
async function startFakeModelServer(t: TestContext): Promise<{ baseURL: string; requests: number }> {
  const state = { baseURL: "", requests: 0 };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      state.requests += 1;
      const parsed = JSON.parse(body) as { stream?: boolean; model?: string; tools?: Array<{ function?: { name?: string } }> };
      const probe = parsed.tools?.find((tool) => tool.function?.name === "xiu_capability_probe");
      const toolCall = { id: "probe-1", type: "function", function: { name: "xiu_capability_probe", arguments: JSON.stringify({ value: "OK" }) } };
      const message = probe ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "Recovered and done." };
      const finish = probe ? "tool_calls" : "stop";
      const completion = { id: "chatcmpl-fake", object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      if (parsed.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = probe ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: "Recovered and done." };
        response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], usage: null })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
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
  state.baseURL = `http://127.0.0.1:${address.port}/v1`;
  return state;
}

async function fixture(t: TestContext, options: { trusted: boolean; baseURL?: string }) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-recover-cli-"));
  const home = path.join(base, "home");
  await fs.mkdir(path.join(base, "project"));
  // The CLI keys the task-run journal by the path it is started in; os.tmpdir() can be a symlink (macOS).
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
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI run timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

/** A PID that certainly belongs to no live process: a child that has already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  assert.ok(child.pid);
  return child.pid;
}

/** Leaves what a crashed Xiu leaves behind: a `running` record with a pending side effect whose owner process is gone. */
async function leaveInterruptedRun(cwd: string, home: string): Promise<{ runId: string; file: string }> {
  const root = path.join(home, ".xiu", "task-runs");
  const journal = new TaskRunJournal(cwd, root);
  const record = await journal.begin({ sessionId: "crashed-session", task: "refactor the parser", providerId: "fake", model: "fake-model" });
  await journal.beginOperation({ kind: "tool", name: "run_command", risk: "execute", sideEffect: "process" });
  const directory = path.join(root, journal.workspaceId);
  const owner = { ownerPid: await exitedPid(), ownerStartedAt: "2000-01-01T00:00:00.000Z" };
  const file = path.join(directory, `${record.runId}.json`);
  const current = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  await fs.writeFile(file, `${JSON.stringify({ ...current, ...owner })}\n`);
  const lockFile = path.join(directory, ".active.lock");
  await fs.writeFile(lockFile, `${JSON.stringify({ ...JSON.parse(await fs.readFile(lockFile, "utf8")), ...owner })}\n`);
  return { runId: record.runId, file };
}

async function recordStatus(file: string): Promise<string> {
  return (JSON.parse(await fs.readFile(file, "utf8")) as { status: string }).status;
}

test("xiu recover reports a clean workspace with exit 0 and an interrupted run with exit 2", { timeout: 90_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { trusted: true });
  const clean = await runCli(["recover"], cwd, home);
  assert.equal(clean.exitCode, 0, clean.stderr);
  assert.match(clean.stdout, /There is no interrupted task in this workspace\./);

  const interrupted = await leaveInterruptedRun(cwd, home);
  const id = interrupted.runId.slice(0, 8);
  const status = await runCli(["recover", "status"], cwd, home);
  assert.equal(status.exitCode, 2, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`);
  assert.match(status.stdout, new RegExp(`Interrupted task ${id} \\(running when interrupted\\)`));
  assert.match(status.stdout, /Task: refactor the parser/);
  assert.match(status.stdout, /Operations interrupted: 1; side effects awaiting verification: 1\. Xiu will not replay them automatically\./);
  assert.match(status.stdout, /- tool:run_command \(process, forbidden\)/);
  assert.match(status.stdout, new RegExp(`Abandon: xiu recover abandon ${id} `));
  assert.doesNotMatch(status.stdout + status.stderr, /fake-key-not-a-secret/);
  assert.equal(await recordStatus(interrupted.file), "running");
});

test("xiu recover abandon changes nothing on a wrong or short id and abandons on the right one, after which --json tasks run", { timeout: 120_000 }, async (t) => {
  const server = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL: server.baseURL });
  const interrupted = await leaveInterruptedRun(cwd, home);
  const id = interrupted.runId.slice(0, 8);
  const wrongPrefix = id.startsWith("0000") ? "ffff" : "0000";

  const short = await runCli(["recover", "abandon", id.slice(0, 3)], cwd, home);
  assert.equal(short.exitCode, 1);
  assert.match(short.stderr, /Usage: xiu recover \[status\]/);
  const wrong = await runCli(["recover", "abandon", wrongPrefix], cwd, home);
  assert.equal(wrong.exitCode, 1, wrong.stdout);
  assert.match(wrong.stderr, new RegExp(`does not match the interrupted task ${id}; nothing was changed`));
  assert.equal(await recordStatus(interrupted.file), "running");

  // A task is still refused while the record stands.
  const refused = await runCli(["--json", "--provider", "fake", "--yes", "write a summary"], cwd, home);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /"outcome":"not_started"/);
  assert.equal(server.requests, 0);

  const abandoned = await runCli(["recover", "abandon", id], cwd, home);
  assert.equal(abandoned.exitCode, 0, abandoned.stderr);
  assert.match(abandoned.stdout, new RegExp(`Interrupted task ${id} was abandoned; no operation was replayed\\.`));
  assert.equal(await recordStatus(interrupted.file), "abandoned");

  const again = await runCli(["recover", "abandon", id], cwd, home);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /nothing to abandon/);

  const run = await runCli(["--json", "--provider", "fake", "--yes", "write a summary"], cwd, home);
  assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  const lines = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  assert.equal(lines.at(-1)?.type, "result");
  assert.equal(lines.at(-1)?.payload.outcome, "completed");
  assert.ok(server.requests >= 1, "the task reached the model once the record was abandoned");
});

test("xiu recover requires a trusted workspace, rejects --json and unknown actions, and leaves records alone", { timeout: 90_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { trusted: false });
  const interrupted = await leaveInterruptedRun(cwd, home);
  const untrusted = await runCli(["recover", "abandon", interrupted.runId], cwd, home);
  assert.equal(untrusted.exitCode, 1);
  assert.match(untrusted.stderr, /This workspace is not trusted yet/);
  assert.equal(await recordStatus(interrupted.file), "running");

  const trusted = await runCli(["--trust-workspace", "recover", "resume", interrupted.runId], cwd, home);
  assert.equal(trusted.exitCode, 1);
  assert.match(trusted.stderr, /Usage: xiu recover \[status\]/);
  assert.equal(await recordStatus(interrupted.file), "running");

  const json = await runCli(["--json", "--trust-workspace", "recover"], cwd, home);
  assert.equal(json.exitCode, 1);
  assert.equal(json.stdout, "");
  assert.match(json.stderr, /--json requires exactly one one-shot task/);
});
