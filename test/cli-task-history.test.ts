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
import { SkillStateStore } from "../src/skill-state.js";
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

test("piped skill enable/disable never treats the first menu item as confirmation", { timeout: 60_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home, processes } = await fixture(t, baseURL);
  const directory = path.join(cwd, ".xiu", "skills", "review");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: review\ndescription: fixture\n---\nread only instructions");
  const state = new SkillStateStore(path.join(home, ".xiu"), cwd);
  const app = await launch(processes, cwd, home);
  await app.command("/skills disable review");
  assert.deepEqual([...(await state.disabled())], [], "no terminal means no disable confirmation");
  await state.setDisabled("review", true);
  await app.command("/skills enable review");
  assert.deepEqual([...(await state.disabled())], ["review"], "no terminal means no enable confirmation");
  await app.close();
});

test("CLI session pagination returns the selected page and rejects invalid standalone options", { timeout: 60_000 }, async (t) => {
  const { cwd, home } = await fixture(t, "https://unused.example/v1");
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  for (let index = 1; index <= 3; index++) await fs.writeFile(path.join(directory, `page-${index}.jsonl`), `${JSON.stringify({ type: "task", task: `task ${index}`, timestamp: `2026-11-04T00:00:0${index}.000Z` })}\n`);
  const args = ["--import", tsxLoader, cli, "--language", "en", "--list-sessions", "--session-offset", "1", "--session-limit", "1"];
  const result = await execFileAsync(process.execPath, args, { cwd, env: environment(home), timeout: 30_000 });
  assert.match(result.stdout, /^page-2 /m);
  assert.doesNotMatch(result.stdout, /^page-[13] /m);
  assert.match(result.stdout, /Sessions 2–2 \/ 3 \(offset 1, limit 1\)/);
  const refresh = await execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--refresh-session-index"], { cwd, env: environment(home), timeout: 30_000 });
  assert.match(refresh.stdout, /indexed 3, skipped 0, failed 0/);
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith(".summary.json")).length, 3);
  const cachedPage = await execFileAsync(process.execPath, args, { cwd, env: environment(home), timeout: 30_000 });
  assert.equal(cachedPage.stdout, result.stdout);
  for (const invalid of [["--session-limit", "0", "--list-sessions"], ["--session-offset", "-1", "--list-sessions"], ["--session-limit", "1.5", "--list-sessions"], ["--session-limit", "2"]]) {
    await assert.rejects(execFileAsync(process.execPath, ["--import", tsxLoader, cli, ...invalid], { cwd, env: environment(home), timeout: 30_000 }), (error: { code?: number; stderr?: string }) => error.code === 1 && /integer|require --list-sessions/.test(error.stderr ?? ""));
  }
  await fs.unlink(path.join(home, ".xiu", "trusted-workspaces.json"));
  await fs.writeFile(path.join(directory, "not-trusted.jsonl"), '{"type":"task","task":"not-read-canary"}\n');
  await assert.rejects(execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--refresh-session-index"], { cwd, env: environment(home), timeout: 30_000 }), (error: { code?: number; stdout?: string; stderr?: string }) => error.code === 1 && /no interactive terminal/i.test((error.stdout ?? "") + (error.stderr ?? "")));
  await assert.rejects(fs.stat(path.join(directory, "not-trusted.jsonl.summary.json")), { code: "ENOENT" });
});

test("CLI refuses malformed saved mode before model requests or workspace writes", { timeout: 60_000 }, async (t) => {
  let requests = 0;
  const baseURL = await startFakeModelServer(t, () => { requests++; });
  const { cwd, home } = await fixture(t, baseURL);
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "broken-mode.jsonl");
  const source = '{"type":"task","task":"Inspect only"}\n{"type":"plan_mode","enabled":true}\n{"type":"plan_mode","enabled":null}\n';
  await fs.writeFile(file, source);
  await assert.rejects(execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "fake", "--resume", "broken-mode", "--yes", "write notes"], { cwd, env: environment(home), timeout: 30_000 }), (error: { code?: number; stdout?: string; stderr?: string }) => error.code === 1 && /session\/state-invalid/.test((error.stdout ?? "") + (error.stderr ?? "")));
  assert.equal(requests, 0);
  await assert.rejects(fs.stat(path.join(cwd, "notes.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(file, "utf8"), source);
});

async function startFakeModelServer(t: TestContext, onRequest?: () => void): Promise<string> {
  const server = http.createServer((request, response) => {
    onRequest?.();
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

  const task = await app.command("write notes", 90_000);
  assert.match(task, /write_file write notes\.txt/);
  assert.match(task, /Done: notes written by the fake model\./);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "hello\nworld\n");

  const runs = await app.command("/diff runs");
  assert.match(runs, /#\s+run id\s+started\s+status\s+changed\s+task/);
  const row = /^1\s+([0-9a-f]{8})\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+(\S+)\s+1\s+write notes$/m.exec(runs);
  assert.ok(row, `run list row missing:\n${runs}`);
  const runPrefix = row[1]!;
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
  assert.match(reports, new RegExp(`^1\\s+${runPrefix}\\s+\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\s+\\S+\\s+write notes$`, "m"));
  await app.close();

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
