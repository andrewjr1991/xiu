import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { trustWorkspace } from "../src/trust.js";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { listSessions } from "../src/session.js";
import type { ModelProvider } from "../src/types.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

test("one-shot tasks cannot bypass workspace trust even with --yes, and a pipe cannot answer the trust question", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-untrusted-workspace-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-untrusted-home-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "UNTRUSTED-ONE-SHOT-CANARY", "utf8");
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "agnes", "--yes", "inspect", "this", "workspace"], {
    cwd: workspace,
    env: { ...process.env, HOME: home, USERPROFILE: home, AGNES_API_KEY: "" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  // "1" on the pipe would have been the default "Trust this workspace"; over a pipe the question is not asked at all.
  child.stdin.end("1\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI trust prompt timed out:\n${output}`)); }, 30_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 1, output);
  assert.match(output, /There is no interactive terminal to confirm trust in this workspace, so it counts as not trusted/);
  assert.doesNotMatch(output, /Do you trust the files in this workspace\?|Trust this workspace|Workspace trusted/);
  assert.doesNotMatch(output, /UNTRUSTED-ONE-SHOT-CANARY/);
  assert.equal(await fs.stat(path.join(home, ".xiu", "trusted-workspaces.json")).then(() => true, () => false), false, "nothing was written to the trust list");
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

test("fresh interactive startup stays open with no channels even when environment keys exist", async () => {
  // The trust question is not answered over a pipe, so the workspace is trusted up front; the test is about provider setup.
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-setup-workspace-")));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-setup-home-"));
  await fs.mkdir(path.join(home, ".xiu"), { recursive: true });
  await trustWorkspace(workspace, path.join(home, ".xiu", "trusted-workspaces.json"));
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "openai", "--yes"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENAI_API_KEY: "new-install-environment-canary",
      XIU_PROVIDER: "",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.stdin.end("/exit\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI provider setup timed out:\n${output}`)); }, 30_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, output);
  assert.match(output, /No Providers added/);
  assert.match(output, /\/provider add/);
  assert.doesNotMatch(output, /new-install-environment-canary/);
  assert.equal(await fs.stat(path.join(home, ".xiu", "providers.json")).then(() => true, () => false), false);
  assert.match(output, /Interactive mode/);
  assert.doesNotMatch(output, /Error: OPENAI_API_KEY is not set/);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

test("--list-sessions and --resume <id> read the workspace's session logs only once it is trusted", { timeout: 120_000 }, async (t) => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-untrusted-sessions-")));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-untrusted-sessions-home-"));
  t.after(() => Promise.all([fs.rm(workspace, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));
  // One finished session in the (not yet trusted) workspace, written the way a real run writes it.
  const config: AgentConfig = { provider: "openai", providerId: "openai", model: "test-model", cwd: workspace, maxTurns: 5, autoApprove: true, contextLimit: 60_000 };
  const provider: ModelProvider = { async complete() { return { text: "SESSION-ANSWER-CANARY", toolCalls: [], raw: { role: "assistant", content: "SESSION-ANSWER-CANARY" }, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }; } };
  await new Agent({ config, provider, tools: [], approve: async () => true }).run("SESSION-TASK-CANARY");
  const [session] = await listSessions(workspace);
  assert.ok(session, "the session log exists");

  const run = async (args: string[]) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "agnes", ...args], {
      cwd: workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home, AGNES_API_KEY: "", XIU_LANGUAGE: "", XIU_PROVIDER: "" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.end("1\n");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI run timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 60_000);
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    return { exitCode, stdout, stderr, output: stdout + stderr };
  };

  const listing = await run(["--list-sessions"]);
  assert.equal(listing.exitCode, 1, listing.output);
  assert.match(listing.output, /There is no interactive terminal to confirm trust in this workspace, so it counts as not trusted/);
  assert.doesNotMatch(listing.output, new RegExp(`${session.id}|SESSION-TASK-CANARY`), "before: the untrusted workspace's sessions were listed with exit 0");

  const resume = await run(["--resume", session.id]);
  assert.equal(resume.exitCode, 1, resume.output);
  assert.match(resume.output, /so it counts as not trusted/);
  assert.doesNotMatch(resume.output, /Resumed session|SESSION-TASK-CANARY|SESSION-ANSWER-CANARY/, "nothing from the log was read or shown");
  assert.equal(await fs.stat(path.join(home, ".xiu", "trusted-workspaces.json")).then(() => true, () => false), false, "nothing was written to the trust list");

  const trusted = await run(["--trust-workspace", "--list-sessions"]);
  assert.equal(trusted.exitCode, 0, trusted.output);
  assert.match(trusted.stdout, new RegExp(`^${session.id}  .*SESSION-TASK-CANARY`, "m"), "with trust granted for this process the listing is unchanged");
});
