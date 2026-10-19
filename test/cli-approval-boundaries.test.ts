import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { trustWorkspace } from "../src/trust.js";
import { FixtureProcess, cleanupFixtureProcesses } from "./fixtures/fixture-process.js";

/**
 * End-to-end approval boundaries through the real CLI, driven over stdin without a TTY the way scripts
 * and CI run it. A fake OpenAI-compatible model asks for one tool call chosen by the task text and then
 * repeats the tool result it received, so each test can check both the workspace and what the model saw.
 *
 *   "redirect …" -> run_command `echo hi > out.txt`  (composite shell: execute risk)
 *   "delete …"   -> run_command `rm -rf keep-me`      (dangerous: never auto-approved)
 *   "write …"    -> write_file notes.txt              (write risk)
 */

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const execFileAsync = promisify(execFile);
const DENIED_BY_USER = "Tool execution denied by user.";
const PLAN_DENIED = "Tool execution denied: plan mode is read-only.";

type ChatMessage = { role: string; content?: string | null };

function toolCallFor(task: string): { name: string; arguments: Record<string, unknown> } {
  if (/\bdelete\b/i.test(task)) return { name: "run_command", arguments: { command: "rm -rf keep-me" } };
  if (/\bredirect\b/i.test(task)) return { name: "run_command", arguments: { command: "echo hi > out.txt" } };
  return { name: "write_file", arguments: { path: "notes.txt", content: "hello\n" } };
}

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
      const parsed = JSON.parse(body) as { stream?: boolean; model?: string; tools?: Array<{ function?: { name?: string } }>; messages?: ChatMessage[] };
      const probe = parsed.tools?.find((tool) => tool.function?.name === "xiu_capability_probe");
      const messages = parsed.messages ?? [];
      // The task is the latest user message that names a scenario; later user messages are the runtime's
      // own follow-ups (for example the verification reminder) and must not start another tool call.
      const task = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "user" && /\b(?:delete|redirect|write)\b/i.test(String(message.content ?? ""))).at(-1);
      const turn = task ? messages.slice(task.index + 1) : [];
      const toolReply = turn.filter((message) => message.role === "tool").at(-1);
      const answered = turn.some((message) => message.role === "assistant" && typeof message.content === "string" && message.content.length > 0);
      const requested = toolCallFor(String(task?.message.content ?? ""));
      const toolCall = probe
        ? { id: "probe-1", type: "function", function: { name: "xiu_capability_probe", arguments: JSON.stringify({ value: "OK" }) } }
        : toolReply || answered ? undefined : { id: "call-1", type: "function", function: { name: requested.name, arguments: JSON.stringify(requested.arguments) } };
      const answer = `Model saw: ${String(toolReply?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`;
      const message = toolCall ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: answer };
      const finish = toolCall ? "tool_calls" : "stop";
      const completion = { id: "chatcmpl-fake", object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      if (parsed.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: answer };
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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-approval-"));
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  const processes: FixtureProcess[] = [];
  t.after(() => cleanupFixtureProcesses(processes, () => fs.rm(base, { recursive: true, force: true })), { timeout: 10_000 });
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(cwd, "keep-me"));
  await fs.writeFile(path.join(cwd, "keep-me", "data.txt"), "precious\n");
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

async function launch(processes: FixtureProcess[], cwd: string, home: string, extraArgs: string[]) {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "fake", ...extraArgs], { cwd, env: environment(home), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
    async command(input: string, timeout = 90_000) { child.stdin.write(`${input}\n`); return readUntil("xiu> ", timeout); },
    async close() { child.stdin.write("/exit\n"); assert.equal(await owned.waitForExit(30_000), 0, output); },
    get output() { return output; },
  };
}

async function runOneShot(args: string[], cwd: string, home: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "fake", ...args], { cwd, env: environment(home), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`one-shot run timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 90_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);
// PowerShell's `>` redirection writes UTF-16LE with a BOM; POSIX shells write UTF-8.
const readShellOutput = async (file: string): Promise<string> => {
  const bytes = await fs.readFile(file);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
  return text.trim();
};
// Everything these English-language sessions print must be English: a Chinese character means a
// shared module ignored the CLI language.
const assertEnglishOnly = (output: string): void => { assert.doesNotMatch(output, /[\u4e00-\u9fff]/, `Chinese text in an English session:\n${output}`); };

test("--yes in a piped session auto-approves execute-risk commands but never dangerous ones", { timeout: 180_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home, processes } = await fixture(t, baseURL);
  const app = await launch(processes, cwd, home, ["--yes"]);
  try {

  const redirect = await app.command("redirect please");
  assert.match(redirect, /run_command run: echo hi > out\.txt/);
  assert.match(redirect, /Model saw: Exit code: 0/);
  assert.match(redirect, /Stopped unverified/);
  assert.equal(await readShellOutput(path.join(cwd, "out.txt")), "hi");

  const destroy = await app.command("delete please");
  assert.match(destroy, /run_command run: rm -rf keep-me/);
  assert.match(destroy, new RegExp(`Model saw: ${DENIED_BY_USER.replace(".", "\\.")}`));
  assert.equal(await fs.readFile(path.join(cwd, "keep-me", "data.txt"), "utf8"), "precious\n");

  const report = await app.command("/report");
  assert.match(report, /Security events: [1-9]\d* · denied: [1-9]\d*/);
  assertEnglishOnly(app.output);
  await app.close();
  } catch (error) {
    annotateOnFailure("cli-approval-boundaries transcript", () => app.output, error);
    throw error;
  }
});

test("a piped session without --yes denies write approvals instead of prompting or guessing", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home, processes } = await fixture(t, baseURL);
  const app = await launch(processes, cwd, home, []);
  try {

  const write = await app.command("write please");
  assert.match(write, /> write_file write notes\.txt/);
  assert.match(write, /write_file: Tool execution denied by user\./);
  assert.match(write, new RegExp(`Model saw: ${DENIED_BY_USER.replace(".", "\\.")}`));
  assert.match(write, /Every operation in the last tool batch failed or was denied/);
  assert.equal(await exists(path.join(cwd, "notes.txt")), false);
  assertEnglishOnly(app.output);
  await app.close();
  } catch (error) {
    annotateOnFailure("cli-approval-boundaries transcript", () => app.output, error);
    throw error;
  }
});

test("Plan mode stays read-only even with --yes, and writes resume once it is turned off", { timeout: 180_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home, processes } = await fixture(t, baseURL);
  const app = await launch(processes, cwd, home, ["--yes"]);
  try {

  assert.match(await app.command("/plan on"), /Plan mode enabled \(read-only\)/);
  const planned = await app.command("write please");
  assert.match(planned, new RegExp(`Model saw: ${PLAN_DENIED.replace(/[.:]/g, "\\$&")}`));
  assert.equal(await exists(path.join(cwd, "notes.txt")), false);

  assert.match(await app.command("/plan off"), /Plan mode disabled/);
  const written = await app.command("write please");
  assert.match(written, /Model saw: /);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "hello\n");
  assertEnglishOnly(app.output);
  await app.close();
  } catch (error) {
    annotateOnFailure("cli-approval-boundaries transcript", () => app.output, error);
    throw error;
  }
});

test("a piped session cannot approve a plugin manifest by menu position", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home, processes } = await fixture(t, baseURL);
  const pluginRoot = path.join(cwd, ".xiu", "plugins", "demo");
  await fs.mkdir(path.join(pluginRoot, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: fixture\n---\nReview.\n");
  await fs.writeFile(path.join(pluginRoot, "xiu.plugin.json"), `${JSON.stringify({
    apiVersion: 1, id: "demo", name: "Demo", version: "1.0.0",
    engines: { xiu: { min: "0.14.0", maxExclusive: "9.0.0" } },
    permissions: ["workspace:read", "instructions:load"],
    contributes: { skills: [{ id: "review", path: "skills/review" }] },
  }, null, 2)}\n`);
  const app = await launch(processes, cwd, home, ["--yes"]);
  try {

  const approve = await app.command("/plugin approve demo");
  assert.match(approve, /Authorize plugin Demo\? There is no interactive terminal to choose from, so this counts as cancelled/);
  assert.match(approve, /Plugin approval cancelled\./);
  assert.doesNotMatch(approve, /approved|authorized/i);
  assert.equal(await exists(path.join(home, ".xiu", "extension-permissions.json")), false);
  assertEnglishOnly(app.output);
  await app.close();
  } catch (error) {
    annotateOnFailure("cli-approval-boundaries transcript", () => app.output, error);
    throw error;
  }
});

test("--json --yes one-shot run denies a dangerous command, records the decision and exits 1", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, baseURL);
  const run = await runOneShot(["--json", "--yes", "delete please"], cwd, home);
  assert.equal(run.exitCode, 1, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
  const lines = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  const started = lines.find((line) => line.type === "tool.started");
  assert.equal(started?.payload.name, "run_command");
  assert.equal(started?.payload.risk, "dangerous");
  const requested = lines.find((line) => line.type === "approval.requested");
  assert.equal((requested?.payload.approval as { risk: string }).risk, "dangerous");
  // The runtime's own text follows the CLI language instead of the desktop's Chinese default.
  assert.deepEqual((requested?.payload.approval as { effects: string[] }).effects, ["The operation may be irreversible", "May affect data outside the workspace or external systems"]);
  assert.match(String(lines.find((line) => line.type === "task.finished")?.payload.error), /^The last tool operation did not succeed/);
  const decided = lines.find((line) => line.type === "approval.decided");
  assert.equal(decided?.payload.allowed, false);
  const finished = lines.find((line) => line.type === "tool.finished");
  assert.equal((finished?.payload.result as { status: string; sideEffectState: string }).status, "denied");
  assert.equal((finished?.payload.result as { status: string; sideEffectState: string }).sideEffectState, "none");
  assert.equal(lines.find((line) => line.type === "task.finished")?.payload.state, "failed");
  assert.equal(lines.at(-1)?.type, "result");
  assert.equal(lines.at(-1)?.payload.outcome, "failed");
  assert.equal(lines.at(-1)?.payload.failureReason, "tool_failed");
  assert.equal(lines.at(-1)?.payload.exitCode, 1);
  assert.equal(await fs.readFile(path.join(cwd, "keep-me", "data.txt"), "utf8"), "precious\n");
  assert.doesNotMatch(run.stdout, /fake-key-not-a-secret/);
  assertEnglishOnly(run.stdout);
  assertEnglishOnly(run.stderr);
});
