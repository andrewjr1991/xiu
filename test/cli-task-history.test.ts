import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { loadTaskChangeHistory } from "../src/task-change-history.js";
import { trustWorkspace } from "../src/trust.js";
import { FixtureProcess, cleanupFixtureProcesses } from "./fixtures/fixture-process.js";

/**
 * End-to-end: a fake OpenAI-compatible model writes a file through the real interactive CLI, and the
 * saved change record is replayed with /diff runs, /diff run:<selector> [file] and read by xiu report.
 * The model is driven over stdin without a TTY, the way the other CLI acceptance tests run.
 */

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const execFileAsync = promisify(execFile);
const FINAL_ANSWER = "Done: notes written by the fake model.";

/**
 * CI-only diagnostics: when an assertion fails on a GitHub runner, publish the CLI transcript as a
 * workflow annotation, because the job log's TAP block is not retrievable afterwards.
 */
function annotateOnFailure(title: string, transcript: () => string, error: unknown): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const text = `${error instanceof Error ? error.message : String(error)}\n--- transcript ---\n${transcript()}`.slice(0, 3_500);
  const escaped = text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::error title=${title}::${escaped}\n`);
}

async function startFakeModelServer(t: TestContext): Promise<string> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { stream?: boolean; model?: string; tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string }> };
      const probe = parsed.tools?.find((tool) => tool.function?.name === "xiu_capability_probe");
      const wrote = parsed.messages?.some((message) => message.role === "tool") ?? false;
      const toolCall = probe
        ? { id: "probe-1", type: "function", function: { name: "xiu_capability_probe", arguments: JSON.stringify({ value: "OK" }) } }
        : wrote ? undefined : { id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "notes.txt", content: "hello\nworld\n" }) } };
      const message = toolCall ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: FINAL_ANSWER };
      const finish = toolCall ? "tool_calls" : "stop";
      const completion = { id: "chatcmpl-fake", object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      if (parsed.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: FINAL_ANSWER };
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
  return `http://127.0.0.1:${address.port}/v1`;
}

async function fixture(t: TestContext, baseURL: string) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-task-history-"));
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  const processes: FixtureProcess[] = [];
  t.after(() => cleanupFixtureProcesses(processes, () => fs.rm(base, { recursive: true, force: true })), { timeout: 10_000 });
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(home, ".xiu"), { recursive: true });
  await fs.writeFile(path.join(cwd, "README.md"), "# demo\n");
  const git = (...args: string[]) => execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd });
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  await trustWorkspace(cwd, path.join(home, ".xiu", "trusted-workspaces.json"));
  await fs.writeFile(path.join(home, ".xiu", "providers.json"), JSON.stringify({ version: 5, active: "fake", profiles: [{
    id: "fake", name: "Fake", kind: "openai", model: "fake-model", baseURL, apiKeyEnv: "FAKE_API_KEY",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }] }), "utf8");
  return { cwd, home, processes };
}

function environment(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, FAKE_API_KEY: "fake-key-not-a-secret", OPENAI_API_KEY: "", AGNES_API_KEY: "", ANTHROPIC_API_KEY: "", XIU_PROVIDER: "", FORCE_COLOR: "0", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
}

async function launch(processes: FixtureProcess[], cwd: string, home: string) {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "fake", "--yes"], { cwd, env: environment(home), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const owned = new FixtureProcess(child);
  processes.push(owned);
  let output = "";
  let cursor = 0;
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const readUntil = async (marker: string, timeout = 60_000): Promise<string> => {
    const start = cursor;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = output.indexOf(marker, cursor);
      if (index >= 0) { cursor = index + marker.length; return output.slice(start, cursor); }
      if (owned.spawnError) throw owned.spawnError;
      if (owned.exited) throw new Error(`CLI exited before ${marker}:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`CLI did not reach ${marker}:\n${output}`);
  };
  await readUntil("xiu> ");
  return {
    async command(input: string, timeout?: number) { child.stdin.write(`${input}\n`); return readUntil("xiu> ", timeout); },
    async close() { child.stdin.write("/exit\n"); assert.equal(await owned.waitForExit(30_000), 0, output); },
    get output() { return output; },
  };
}

test("a finished CLI task leaves a change record that /diff run: and xiu report replay", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home, processes } = await fixture(t, baseURL);
  const app = await launch(processes, cwd, home);
  let runPrefix = "";
  try {
  const task = await app.command("write notes", 90_000);
  assert.match(task, /write_file write notes\.txt/);
  assert.match(task, /Done: notes written by the fake model\./);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "hello\nworld\n");

  const runs = await app.command("/diff runs");
  assert.match(runs, /#\s+run id\s+started\s+status\s+changed\s+task/);
  const row = /^1\s+([0-9a-f]{8})\s+\S+\s+(\S+)\s+1\s+write notes$/m.exec(runs);
  assert.ok(row, `run list row missing:\n${runs}`);
  runPrefix = row[1]!;
  assert.notEqual(row[2], "running");

  const replay = await app.command("/diff run:1");
  assert.match(replay, new RegExp(`Run ${runPrefix} · .* · write notes`));
  assert.match(replay, /saved when the task finished, not the current workspace state/);
  assert.match(replay, /created "notes\.txt"/);
  assert.doesNotMatch(replay, /fake-key-not-a-secret/);

  const file = await app.command(`/diff run:${runPrefix} notes.txt`);
  assert.match(file, /created "notes\.txt"/);
  assert.match(file, /Stats: \+2 \/ -0/);
  assert.match(file, /\+hello\n\+world/);

  const missing = await app.command("/diff run:1 missing.txt");
  assert.match(missing, /has no "missing\.txt"; it covers 1 file\(s\)/);

  const reports = await app.command("/report runs");
  assert.match(reports, new RegExp(`^1\\s+${runPrefix}\\s+\\S+\\s+\\S+\\s+write notes$`, "m"));
  await app.close();
  } catch (error) {
    annotateOnFailure("cli-task-history transcript", () => app.output, error);
    throw error;
  }

  // The record is the same file the desktop reads, under the run id the journal assigned.
  const history = await fs.readdir(path.join(cwd, ".xiu", "task-change-history"));
  assert.equal(history.length, 1, history.join(","));
  assert.ok(history[0]!.startsWith(runPrefix), history[0]);
  const record = await loadTaskChangeHistory(cwd, path.basename(history[0]!, ".json"));
  assert.equal(record?.view, "task");
  assert.deepEqual(record?.changes.map((change) => [change.path, change.kind]), [["notes.txt", "created"]]);

  // One-shot report of that run from a fresh process, without the interactive loop.
  const report = await execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "report", `run:${runPrefix}`], { cwd, env: environment(home), windowsHide: true, timeout: 60_000 });
  assert.match(report.stdout, /write notes/);
  assert.doesNotMatch(report.stdout, /fake-key-not-a-secret/);
});
