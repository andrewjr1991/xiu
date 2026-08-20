import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

test("one-shot tasks cannot bypass workspace trust even with --yes", async () => {
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
  child.stdin.end("2\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI trust prompt timed out:\n${output}`)); }, 30_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, output);
  assert.match(output, /Do you trust the files in this workspace\?/);
  assert.match(output, /Workspace was not trusted/);
  assert.doesNotMatch(output, /UNTRUSTED-ONE-SHOT-CANARY/);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

test("interactive startup stays open when the selected provider has no API key", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-setup-workspace-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-setup-home-"));
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--language", "en", "--provider", "openai", "--yes"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENAI_API_KEY: "",
      XIU_PROVIDER: "",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.stdin.end("1\n/exit\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI provider setup timed out:\n${output}`)); }, 30_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, output);
  assert.match(output, /staying open in setup mode/);
  assert.match(output, /Interactive mode/);
  assert.doesNotMatch(output, /Error: OPENAI_API_KEY is not set/);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});
