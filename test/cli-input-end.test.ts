import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";
import { trustWorkspace } from "../src/trust.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const mcpFixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

/** A trusted workspace with the fake provider configured; with `mcp`, the fixture MCP server is configured and its permissions approved. */
async function fixture(t: TestContext, options: { mcp?: boolean } = {}): Promise<{ cwd: string; home: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-input-end-"));
  const home = path.join(base, "home");
  await fs.mkdir(path.join(base, "project"));
  const cwd = await fs.realpath(path.join(base, "project"));
  await fs.mkdir(path.join(home, ".xiu"), { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await trustWorkspace(cwd, path.join(home, ".xiu", "trusted-workspaces.json"));
  await fs.writeFile(path.join(home, ".xiu", "providers.json"), JSON.stringify({ version: 5, active: "fake", profiles: [{
    id: "fake", name: "Fake", kind: "openai", model: "fake-model", baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "FAKE_API_KEY",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }] }), "utf8");
  if (options.mcp) {
    await fs.mkdir(path.join(cwd, ".xiu"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".xiu", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpFixture] } } }));
    await new McpManager(cwd, path.join(home, ".xiu", "mcp.json")).approvePermissions("fixture");
  }
  return { cwd, home };
}

/**
 * Starts an interactive (piped) session, writes `stdin` and closes the pipe, and waits for the process to end on its own.
 * With `terminateWhen`, the pipe stays open and the process gets SIGTERM once its output matches, like a stopped container.
 */
async function runPipedSession(cwd: string, home: string, stdin: string, terminateWhen?: RegExp): Promise<{ exitCode: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "fake"], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_API_KEY: "fake-key-not-a-secret", XIU_PROVIDER: "", FORCE_COLOR: "0", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let terminated = false;
  const onOutput = (chunk: unknown): void => {
    output += String(chunk);
    if (terminateWhen && !terminated && terminateWhen.test(output)) { terminated = true; child.kill("SIGTERM"); }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  if (terminateWhen) child.stdin.write(stdin);
  else child.stdin.end(stdin);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the session did not end after its input did:\n${output}`)); }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, output };
}

test("a piped session whose input ends at the prompt leaves like /exit, even with an MCP server running", { timeout: 90_000 }, async (t) => {
  const { cwd, home } = await fixture(t, { mcp: true });
  // Before, the connected server's process kept the event loop alive and the session waited forever at `xiu> `.
  const run = await runPipedSession(cwd, home, "/mcp\n");
  assert.equal(run.exitCode, 0, run.output);
  assert.match(run.output, /fixture: connected \(3 tools\)/);
  assert.match(run.output, /xiu> \nInput ended; leaving Xiu\./);
});

test("a piped session with no input at all ends at once with the same line", { timeout: 90_000 }, async (t) => {
  const { cwd, home } = await fixture(t);
  const run = await runPipedSession(cwd, home, "");
  assert.equal(run.exitCode, 0, run.output);
  assert.match(run.output, /Input ended; leaving Xiu\./);
  assert.equal(run.output.trimEnd().endsWith("Input ended; leaving Xiu."), true, run.output);
});

test("input that ends while a task runs lets the task finish, then leaves at the prompt", { timeout: 90_000 }, async (t) => {
  const { cwd, home } = await fixture(t);
  // The provider's port refuses connections, so the task fails quickly; the point is that the end of the input does not
  // interrupt it, and that the session still ends afterwards instead of waiting at the next prompt.
  const run = await runPipedSession(cwd, home, "Say hello\n");
  assert.equal(run.exitCode, 0, run.output);
  assert.match(run.output, /Task stopped:/);
  assert.ok(run.output.indexOf("Task stopped:") < run.output.indexOf("Input ended; leaving Xiu."), run.output);
});

test("SIGTERM at an idle piped prompt leaves like /exit, with the MCP server shut down", { timeout: 90_000, skip: process.platform === "win32" ? "POSIX signal" : false }, async (t) => {
  const { cwd, home } = await fixture(t, { mcp: true });
  // The input stays open (a container or CI job that is stopped), so only the signal can end the session.
  const run = await runPipedSession(cwd, home, "/mcp\n", /fixture: connected \(3 tools\)[\s\S]*xiu> /);
  assert.equal(run.exitCode, 0, run.output);
  assert.match(run.output, /Received SIGTERM; leaving Xiu\./);
});
