import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { trustWorkspace } from "../src/trust.js";

/**
 * End-to-end: the exit code of a one-shot run follows the task outcome in both modes, plain and
 * `--json`: 3 when the model asks a question, 2 when the workspace changed without verification,
 * 1 when the last tool failed. A fake OpenAI-compatible model picks its behaviour from the task text.
 */

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

type Message = { role: string; content?: string | null };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function latestUserText(messages: Message[]): string {
  return messages.filter((message) => message.role === "user" && typeof message.content === "string").at(-1)?.content ?? "";
}

/** `ask` ends in a blocking question; `unverified` writes a file and stops; `fail` reads a missing file and stops. */
function scenario(messages: Message[]): { toolCall?: ToolCall; text: string } {
  const task = latestUserText(messages);
  const answered = messages.some((message) => message.role === "tool");
  if (/\bask\b/i.test(task)) return { text: "USER_INPUT_REQUIRED: Which file should I rename?" };
  if (/\bunverified\b/i.test(task)) {
    return answered
      ? { text: "Wrote notes.txt without running any verification." }
      : { toolCall: { id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "notes.txt", content: "unverified\n" }) } }, text: "" };
  }
  if (/\bfail\b/i.test(task)) {
    return answered
      ? { text: "The file could not be read, so I stopped." }
      : { toolCall: { id: "read-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "does-not-exist.txt" }) } }, text: "" };
  }
  return { text: "Done." };
}

async function startFakeModelServer(t: TestContext): Promise<string> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { stream?: boolean; model?: string; tools?: Array<{ function?: { name?: string } }>; messages?: Message[] };
      const probe = parsed.tools?.find((tool) => tool.function?.name === "xiu_capability_probe");
      const chosen = probe
        ? { toolCall: { id: "probe-1", type: "function" as const, function: { name: "xiu_capability_probe", arguments: JSON.stringify({ value: "OK" }) } }, text: "" }
        : scenario(parsed.messages ?? []);
      const message = chosen.toolCall ? { role: "assistant", content: null, tool_calls: [chosen.toolCall] } : { role: "assistant", content: chosen.text };
      const finish = chosen.toolCall ? "tool_calls" : "stop";
      const completion = { id: "chatcmpl-fake", object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      if (parsed.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = chosen.toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...chosen.toolCall }] } : { role: "assistant", content: chosen.text };
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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-exit-codes-"));
  const home = path.join(base, "home");
  await fs.mkdir(path.join(base, "project"));
  const cwd = await fs.realpath(path.join(base, "project"));
  await fs.mkdir(path.join(home, ".xiu"), { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await trustWorkspace(cwd, path.join(home, ".xiu", "trusted-workspaces.json"));
  await fs.writeFile(path.join(home, ".xiu", "providers.json"), JSON.stringify({ version: 5, active: "fake", profiles: [{
    id: "fake", name: "Fake", kind: "openai", model: "fake-model", baseURL, apiKeyEnv: "FAKE_API_KEY",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }] }), "utf8");
  return { cwd, home };
}

async function runCli(args: string[], cwd: string, home: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "fake", "--yes", ...args], {
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
    const timer = setTimeout(() => { child.kill(); reject(new Error(`one-shot run timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 90_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

function resultLine(stdout: string): { outcome: string; exitCode: number; success: boolean; failureReason?: string; pendingQuestion?: string } {
  const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  const result = lines.at(-1);
  assert.equal(result?.type, "result", stdout);
  assert.equal(lines.filter((line) => line.type === "result").length, 1);
  return result!.payload as ReturnType<typeof resultLine>;
}

const describe = (run: { stdout: string; stderr: string }) => `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

test("a model question ends a one-shot run with exit 3 in both modes, and --json carries the question", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, baseURL);
  const json = await runCli(["--json", "please ask before renaming"], cwd, home);
  assert.equal(json.exitCode, 3, describe(json));
  const result = resultLine(json.stdout);
  assert.equal(result.outcome, "waiting_user");
  assert.equal(result.exitCode, 3);
  assert.equal(result.success, false);
  assert.equal(result.pendingQuestion, "Which file should I rename?");

  const plain = await runCli(["please ask before renaming"], cwd, home);
  assert.equal(plain.exitCode, 3, describe(plain));
  assert.match(plain.stdout, /Which file should I rename\?/);
});

test("a workspace change without verification exits 2 in both modes", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, baseURL);
  const json = await runCli(["--json", "write notes unverified"], cwd, home);
  assert.equal(json.exitCode, 2, describe(json));
  const result = resultLine(json.stdout);
  assert.equal(result.outcome, "unverified");
  assert.equal(result.exitCode, 2);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "unverified\n");

  await fs.rm(path.join(cwd, "notes.txt"));
  const plain = await runCli(["write notes unverified"], cwd, home);
  assert.equal(plain.exitCode, 2, describe(plain));
  assert.match(plain.stdout, /write_file write notes\.txt/);
  assert.equal(await fs.readFile(path.join(cwd, "notes.txt"), "utf8"), "unverified\n");
});

test("a failed last tool operation exits 1 in both modes instead of 0 without --json", { timeout: 120_000 }, async (t) => {
  const baseURL = await startFakeModelServer(t);
  const { cwd, home } = await fixture(t, baseURL);
  const json = await runCli(["--json", "read the file, fail if missing"], cwd, home);
  assert.equal(json.exitCode, 1, describe(json));
  const result = resultLine(json.stdout);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failureReason, "tool_failed");

  const plain = await runCli(["read the file, fail if missing"], cwd, home);
  assert.equal(plain.exitCode, 1, describe(plain));
  assert.match(plain.stdout, /read_file read does-not-exist\.txt/);
});
