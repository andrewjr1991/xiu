import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { trustWorkspace } from "../src/trust.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

/** A model endpoint that rejects every request at once (401 is never retried), so a run that reaches the model ends quickly. */
async function startRejectingModelServer(t: TestContext): Promise<string> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided" } })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/v1`;
}

async function fixture(t: TestContext, options: { trusted?: boolean; baseURL?: string } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-startup-errors-"));
  const home = path.join(base, "home");
  await fs.mkdir(path.join(base, "project"));
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
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_API_KEY: "fake-key-not-a-secret", OPENAI_API_KEY: "", AGNES_API_KEY: "", ANTHROPIC_API_KEY: "", XIU_PROVIDER: "", XIU_LANGUAGE: "", FORCE_COLOR: "0", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
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

test("a damaged trust list stops startup with the cause, the next step and xiu doctor, in both modes", { timeout: 120_000 }, async (t) => {
  const { cwd, home } = await fixture(t);
  await fs.writeFile(path.join(home, ".xiu", "trusted-workspaces.json"), "{ broken");

  const piped = await runCli(["--language", "en", "Say hello"], cwd, home);
  assert.equal(piped.exitCode, 1, `stdout:\n${piped.stdout}\nstderr:\n${piped.stderr}`);
  assert.match(piped.stderr, /^Xiu could not start: The trust list \(~\/\.xiu\/trusted-workspaces\.json\) cannot be read, so Xiu cannot tell whether any workspace is trusted and did not continue\.$/m);
  assert.match(piped.stderr, /^Next step: Fix its JSON or move the file away; afterwards each workspace asks for trust once more\.$/m);
  assert.match(piped.stderr, /^Diagnose: xiu doctor$/m);
  assert.match(piped.stderr, /^Detail: config\/trust-store · Unable to read Xiu trust store at .*trusted-workspaces\.json: /m, "the owner's message, path included, stays available as the detail");
  assert.doesNotMatch(piped.stderr, /^Error: /m, "the raw line is replaced, not duplicated");
  assert.doesNotMatch(piped.stdout + piped.stderr, /Do you trust the files/, "no trust prompt was read from the pipe");

  const json = await runCli(["--json", "--language", "en", "Say hello"], cwd, home);
  assert.equal(json.exitCode, 1);
  const lines = json.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  assert.equal(lines.length, 1, `stdout carries only the result line:\n${json.stdout}`);
  assert.equal(lines[0]!.type, "result");
  assert.equal(lines[0]!.payload.outcome, "not_started");
  assert.equal(lines[0]!.payload.exitCode, 1);
  assert.match(String(lines[0]!.payload.error), /^Unable to read Xiu trust store at /, "the result keeps the raw message scripts match on");
  assert.match(json.stderr, /^Xiu could not start: The trust list .* did not continue\.\nNext step: .*\nDiagnose: xiu doctor\nDetail: config\/trust-store · /m, "the explanation goes to stderr, for the person reading the log");
});

test("a --cwd that is a file or does not exist stops every command with the cause and the next step", { timeout: 120_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { trusted: true });
  const file = path.join(cwd, "notes.txt");
  await fs.writeFile(file, "not a workspace");
  const missing = path.join(cwd, "gone");

  const task = await runCli(["--language", "en", "--cwd", file, "Say hello"], cwd, home);
  assert.equal(task.exitCode, 1, `stdout:\n${task.stdout}\nstderr:\n${task.stderr}`);
  assert.match(task.stderr, /^Xiu could not start: The workspace path is a file, not a directory: .*notes\.txt\. A workspace must be a directory\.$/m);
  assert.match(task.stderr, /^Next step: Point --cwd at the project directory that contains the file instead\.$/m);
  assert.match(task.stderr, /^Detail: workspace\/not-directory · Workspace is not a directory: /m);
  assert.doesNotMatch(task.stderr, /^Error: /m, "the raw line is replaced, not duplicated");

  const json = await runCli(["--json", "--language", "en", "--cwd", missing, "Say hello"], cwd, home);
  assert.equal(json.exitCode, 1);
  const lines = json.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  assert.equal(lines.length, 1, `stdout carries only the result line:\n${json.stdout}`);
  assert.equal(lines[0]!.payload.outcome, "not_started");
  assert.equal(lines[0]!.payload.error, `Workspace does not exist: ${missing}`, "the result keeps the raw message scripts match on");
  assert.match(json.stderr, /^Xiu could not start: The workspace directory does not exist: .*gone\.\nNext step: Point --cwd at an existing project directory, or run xiu from inside the project\./m);

  // The read-only script commands used to report on the non-existent workspace ("no task run to report yet").
  const report = await runCli(["--language", "en", "--trust-workspace", "--cwd", missing, "report", "runs"], cwd, home);
  assert.equal(report.exitCode, 1, `stdout:\n${report.stdout}\nstderr:\n${report.stderr}`);
  assert.match(report.stderr, /^Xiu could not start: The workspace directory does not exist: /m);
  assert.doesNotMatch(report.stdout + report.stderr, /no task run to report|not trusted/);

  const zh = await runCli(["--language", "zh", "--cwd", file, "recover", "status"], cwd, home);
  assert.equal(zh.exitCode, 1);
  assert.match(zh.stderr, /^Xiu 无法启动：工作区路径是文件而不是目录：.*notes\.txt。工作区必须是目录。$/m);
  assert.match(zh.stderr, /^下一步：把 --cwd 改成这个文件所在的项目目录。$/m);
});

test("a damaged settings file is explained in the language the command line asks for", { timeout: 60_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { trusted: true });
  await fs.writeFile(path.join(home, ".xiu", "settings.json"), "{ broken");
  const run = await runCli(["--language", "zh", "你好"], cwd, home);
  assert.equal(run.exitCode, 1, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /^Xiu 无法启动：Xiu 的设置文件（~\/\.xiu\/settings\.json）无法读取或不是有效的 JSON，Xiu 不会悄悄改用默认值。$/m);
  assert.match(run.stderr, /^下一步：修好它的 JSON，或把这个文件移走后重新启动；它只保存语言与联网搜索设置。$/m);
  assert.match(run.stderr, /^诊断：xiu doctor$/m);
  assert.match(run.stderr, /^详情：config\/settings · Could not read Xiu settings file .*settings\.json: /m);
  assert.doesNotMatch(run.stderr, /^Error: /m);
});

test("an invalid workspace MCP config is explained before the task runs and does not stop the run", { timeout: 60_000 }, async (t) => {
  const baseURL = await startRejectingModelServer(t);
  const { cwd, home } = await fixture(t, { trusted: true, baseURL });
  await fs.mkdir(path.join(cwd, ".xiu"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".xiu", "mcp.json"), JSON.stringify({ mcpServers: { docs: {} } }));
  const run = await runCli(["--language", "en", "--yes", "Say hello"], cwd, home);
  const output = `${run.stdout}\n${run.stderr}`;
  assert.match(output, /^MCP configuration was not loaded: An MCP configuration file cannot be read or one of its server entries is invalid, so no MCP server was connected this time; everything else works as usual\.$/m, output);
  assert.match(output, /^Next step: Fix ~\/\.xiu\/mcp\.json or the workspace's \.xiu\/mcp\.json as the detail says, then run \/mcp reload or start Xiu again\.$/m);
  assert.match(output, /^Diagnose: xiu doctor$/m);
  assert.match(output, /^Detail: config\/mcp · MCP server docs requires exactly one of command or url$/m, "the detail names the server entry to fix");
  assert.match(output, /Incorrect API key|401|rejected/i, "the run went on to the model after the MCP explanation");
  assert.equal(run.exitCode, 1, "the model rejection, not the MCP config, decides the exit code");
});
