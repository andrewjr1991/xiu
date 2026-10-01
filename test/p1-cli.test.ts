import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { trustWorkspace } from "../src/trust.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const execFileAsync = promisify(execFile);

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-p1-cli-"));
  const cwd = path.join(base, "project");
  const userDirectory = path.join(base, "user");
  await fs.mkdir(cwd);
  await fs.mkdir(userDirectory);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await trustWorkspace(cwd, path.join(userDirectory, ".xiu", "trusted-workspaces.json"));
  return { cwd, userDirectory };
}

async function launch(t: TestContext, cwd: string, userDirectory: string) {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "openai", "--yes"], {
    cwd,
    env: { ...process.env, HOME: userDirectory, USERPROFILE: userDirectory, OPENAI_API_KEY: "", AGNES_API_KEY: "", ANTHROPIC_API_KEY: "", XIU_PROVIDER: "", FORCE_COLOR: "0" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let cursor = 0;
  let exited = false;
  let spawnError: Error | undefined;
  const exit = new Promise<number | null>((resolve) => {
    child.once("error", (error) => { spawnError = error; resolve(null); });
    child.once("exit", (code) => { exited = true; resolve(code); });
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    child.stdin.end();
    if (!exited) child.kill();
    await exit;
  });
  const readUntil = async (marker: string): Promise<string> => {
    const start = cursor;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const index = output.indexOf(marker, cursor);
      if (index >= 0) {
        cursor = index + marker.length;
        return output.slice(start, cursor);
      }
      if (spawnError) throw spawnError;
      if (exited) throw new Error(`CLI exited before ${marker}:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`CLI did not reach ${marker}:\n${output}`);
  };
  await readUntil("xiu> ");
  return {
    readUntil,
    write: (input: string) => { child.stdin.write(`${input}\n`); },
    async command(input: string) {
      child.stdin.write(`${input}\n`);
      return readUntil("xiu> ");
    },
    async close() {
      child.stdin.write("/exit\n");
      assert.equal(await exit, 0, output);
    },
  };
}

test("CLI fresh setup adds the Agnes template without reserved-ID collisions and removes the last channel", { timeout: 45_000 }, async (t) => {
  const { cwd, userDirectory } = await fixture(t);
  const app = await launch(t, cwd, userDirectory);
  app.write("/provider add");
  await app.readUntil("Provider ID: ");
  app.write("agnes");
  await app.readUntil("Display name: ");
  app.write("My Agnes");
  await app.readUntil("API base URL [https://apihub.agnes-ai.com/v1]: ");
  app.write("");
  await app.readUntil("Default model ID [agnes-2.5-flash]: ");
  app.write("");
  await app.readUntil("API-key environment variable (blank for unauthenticated local servers): ");
  app.write("");
  await app.readUntil("Locally saved API key (optional; input is hidden): ");
  app.write("");
  await app.readUntil("Context-window tokens (blank for 128K): ");
  app.write("");
  await app.readUntil("Does this endpoint and model definitely support vision? [y/N]: ");
  app.write("n");
  await app.readUntil("xiu> ");
  const filename = path.join(userDirectory, ".xiu", "providers.json");
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  assert.equal(saved.active, "agnes");
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profiles[0].kind, "agnes");
  assert.equal(saved.profiles[0].apiKeyEnv, undefined);
  assert.equal(saved.profiles[0].capabilityModels.image, "agnes-image-2.1-flash");
  // No key is supplied, so connection testing fails before any remote request.
  app.write("/provider remove");
  await app.readUntil("Remove agnes and its local credential? [y/N]: ");
  app.write("n");
  await app.readUntil("xiu> ");
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).profiles.length, 1);
  app.write("/provider remove");
  await app.readUntil("Remove agnes and its local credential? [y/N]: ");
  app.write("y");
  await app.readUntil("xiu> ");
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")).profiles, []);
  await app.close();
  const restarted = await launch(t, cwd, userDirectory);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")).profiles, []);
  await restarted.close();
});

test("CLI check commands discover and run real npm scripts, respect Plan mode and report historical results", { timeout: 45_000 }, async (t) => {
  const { cwd, userDirectory } = await fixture(t);
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { typecheck: "node good.js", test: "node bad.js" } }), "utf8");
  await fs.writeFile(path.join(cwd, "good.js"), "require('node:fs').writeFileSync('checked.txt','done');", "utf8");
  await fs.writeFile(path.join(cwd, "bad.js"), "process.exit(1);", "utf8");
  const app = await launch(t, cwd, userDirectory);
  const discovered = await app.command("/check");
  assert.match(discovered, /node good\.js/);
  assert.match(discovered, /node bad\.js/);
  await assert.rejects(fs.access(path.join(cwd, "checked.txt")));
  await app.command("/plan on");
  const plan = await app.command("/check typecheck");
  assert.match(plan, /Plan mode is read-only/);
  assert.match(plan, /0 passed/);
  await assert.rejects(fs.access(path.join(cwd, "checked.txt")));
  await app.command("/plan off");
  const checks = await app.command("/check all");
  assert.match(checks, /typecheck: script passed \(exit 0\)/);
  assert.match(checks, /test: failed/);
  assert.match(checks, /1 passed \/ 1 failed/);
  assert.equal(await fs.readFile(path.join(cwd, "checked.txt"), "utf8"), "done");
  const historical = await app.command("/check");
  assert.match(historical, /Previous check record \(not rerun\)/);
  assert.match(historical, /not a guarantee of functional correctness/);
  assert.match(await app.command("/check publish"), /Usage: \/check/);
  await app.close();
});

test("CLI diff defaults to task scope and exposes explicit workspace and staged views", { timeout: 45_000 }, async (t) => {
  const { cwd, userDirectory } = await fixture(t);
  await execFileAsync("git", ["init", "--quiet"], { cwd, windowsHide: true });
  await fs.writeFile(path.join(cwd, "staged.txt"), "staged content\n", "utf8");
  await execFileAsync("git", ["add", "staged.txt"], { cwd, windowsHide: true });
  await fs.writeFile(path.join(cwd, "untracked.txt"), "workspace content\n", "utf8");
  const app = await launch(t, cwd, userDirectory);
  assert.match(await app.command("/diff"), /No task baseline is available/);
  const workspace = await app.command("/diff workspace");
  assert.match(workspace, /staged\.txt/);
  assert.match(workspace, /untracked\.txt/);
  const staged = await app.command("/diff staged");
  assert.match(staged, /staged\.txt/);
  assert.doesNotMatch(staged, /untracked\.txt/);
  assert.match(await app.command("/diff invalid"), /Usage: \/diff/);
  await app.close();
});

test("CLI does not steer check commands into a running task and clear removes task baselines", { timeout: 45_000 }, async (t) => {
  const { cwd, userDirectory } = await fixture(t);
  await fs.mkdir(path.join(userDirectory, ".xiu"), { recursive: true });
  await fs.writeFile(path.join(userDirectory, ".xiu", "providers.json"), JSON.stringify({ version: 5, active: "openai", profiles: [{
    id: "openai", name: "OpenAI", kind: "openai", model: "gpt-5", apiKeyEnv: "OPENAI_API_KEY",
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }] }), "utf8");
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }), "utf8");
  await fs.writeFile(path.join(cwd, "check.js"), "require('node:fs').writeFileSync('unexpected.txt','bad');", "utf8");
  const app = await launch(t, cwd, userDirectory);
  // Missing credentials guarantee this task cannot make a real model request.
  app.write("Inspect this project");
  await app.readUntil("steer> ");
  app.write("/check test");
  await app.readUntil("command was not sent as model steering.");
  // Non-TTY readline needs input to release its current pending question.
  app.write("/cancel");
  await app.readUntil("xiu> ");
  await assert.rejects(fs.access(path.join(cwd, "unexpected.txt")));
  await fs.writeFile(path.join(cwd, "user-added.txt"), "external edit after the task\n", "utf8");
  const taskDiff = await app.command("/diff");
  assert.match(taskDiff, /Task baseline/);
  assert.match(taskDiff, /user-added\.txt/);
  assert.match(taskDiff, /Source unknown/);
  await app.command("/clear");
  assert.match(await app.command("/diff"), /No task baseline is available/);
  await app.close();
});
