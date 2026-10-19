import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
// `--import` takes a module specifier: on Windows an absolute path (`D:\...`) is not one, a file: URL is.
const traceRegister = new URL("./fixtures/import-trace-register.mjs", import.meta.url).href;

/**
 * The packages that dominate Xiu's startup time (about a second together) and are needed only
 * once a task, a web page, an MCP server or a model request is actually in play. Loading any of
 * them for `--version` means an eager import crept back in.
 */
const DEFERRED_PACKAGES = ["typescript", "cheerio", "@modelcontextprotocol/client", "openai", "@anthropic-ai/sdk"];

async function run(args: string[], cwd: string, home: string): Promise<{ exitCode: number | null; output: string; resolved: string[] }> {
  const trace = path.join(home, `imports-${process.pid}-${Math.random().toString(16).slice(2)}.log`);
  const child = spawn(process.execPath, ["--import", tsxLoader, "--import", traceRegister, cli, "--language", "en", ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, XIU_TEST_IMPORT_TRACE: trace, XIU_LANGUAGE: "", XIU_PROVIDER: "" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI run timed out\n${output}`)); }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  const resolved = [...new Set((await fs.readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean))];
  return { exitCode, output, resolved };
}

test("--version, --help and a script command start without loading the TypeScript parser, HTML parser, MCP client or model SDKs", { timeout: 120_000 }, async (t) => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-startup-imports-")));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-startup-imports-home-"));
  t.after(() => Promise.all([fs.rm(workspace, { recursive: true, force: true }), fs.rm(home, { recursive: true, force: true })]));

  for (const args of [["--version"], ["--help"], ["--trust-workspace", "recover", "status"]]) {
    const result = await run(args, workspace, home);
    assert.equal(result.exitCode, 0, `${args.join(" ")}:\n${result.output}`);
    assert.ok(result.resolved.includes("commander"), `${args.join(" ")}: the trace saw the CLI's own imports\n${result.resolved.join("\n")}`);
    const eager = DEFERRED_PACKAGES.filter((name) => result.resolved.some((specifier) => specifier === name || specifier.startsWith(`${name}/`)));
    assert.deepEqual(eager, [], `${args.join(" ")} loaded packages that are only needed once a task runs`);
  }
});
