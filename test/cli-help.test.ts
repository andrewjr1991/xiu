import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ONE_SHOT_EXIT_CODES } from "../src/json-event-stream.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "cli.ts");
const tsxLoader = import.meta.resolve("tsx");
const execFileAsync = promisify(execFile);

// `xiu --help` is where a script author looks first, so it has to name the commands that do not open an interactive
// session and the exit codes a one-shot task returns; the options list alone named neither.
test("xiu --help lists the script commands, the one-shot exit codes and where slash commands run", { timeout: 60_000 }, async () => {
  const { stdout } = await execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--help"], { cwd: root, env: { ...process.env, FORCE_COLOR: "0" } });
  assert.match(stdout, /^Usage: xiu \[options\] \[task\.\.\.\]/);
  assert.match(stdout, /Commands that run without an interactive session/);
  for (const command of ["xiu doctor [json]", "xiu report [markdown|json|html] [summary|details] [run:<number|id prefix>] [path]", "xiu report runs", "xiu recover [status]", "xiu recover abandon <run id or prefix of 4+ characters>", "xiu audit [approvals|credentials] [json] [limit]"]) {
    assert.ok(stdout.includes(command), `--help does not name ${command}`);
  }
  assert.match(stdout, new RegExp(`${ONE_SHOT_EXIT_CODES.completed} completed · ${ONE_SHOT_EXIT_CODES.unverified} changed but unverified · ${ONE_SHOT_EXIT_CODES.waiting_user} the model asked a question · ${ONE_SHOT_EXIT_CODES.failed} failed, cancelled, paused or not started`));
  assert.match(stdout, /Slash commands \(\/help, \/doctor, \/report, \.\.\.\) run only at the interactive prompt/);
  assert.match(stdout, /--trust-workspace/, "the options list still precedes the added text");
  assert.doesNotMatch(stdout, /\$\{/, "every placeholder was interpolated");
});

test("every script command xiu --help names is in the launch-parameter table of the commands guide", async () => {
  const guide = await fs.readFile(path.join(root, "docs", "guide", "commands.zh-CN.md"), "utf8");
  const table = guide.slice(guide.indexOf("## 启动参数速查"));
  for (const command of ["xiu doctor", "xiu report", "xiu recover", "xiu audit", "--json", "--trust-workspace", "--list-sessions", "--check-update"]) {
    assert.ok(table.includes(command), `the launch-parameter table does not mention ${command}`);
  }
});
