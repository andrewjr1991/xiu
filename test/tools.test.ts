import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, classifyCommand, executeTool, resolveWorkspacePath } from "../src/tools.js";

test("resolveWorkspacePath blocks traversal", () => {
  const root = path.resolve("workspace");
  assert.equal(resolveWorkspacePath(root, "src/index.ts"), path.join(root, "src/index.ts"));
  assert.throws(() => resolveWorkspacePath(root, "../secret.txt"), /escapes workspace/);
  assert.throws(() => resolveWorkspacePath(root, path.parse(root).root), /escapes workspace/);
});

test("write_file requires approval and writes inside workspace", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-tools-"));
  const tool = builtinTools.find((candidate) => candidate.name === "write_file")!;
  const denied = await executeTool(tool, { path: "hello.txt", content: "no" }, { cwd, approve: async () => false });
  assert.match(denied, /denied/);
  await assert.rejects(fs.access(path.join(cwd, "hello.txt")));

  const result = await executeTool(tool, { path: "src/hello.txt", content: "yes" }, { cwd, approve: async () => true });
  assert.match(result, /Wrote/);
  assert.equal(await fs.readFile(path.join(cwd, "src/hello.txt"), "utf8"), "yes");
});

test("replace_text refuses ambiguous edits", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-replace-"));
  await fs.writeFile(path.join(cwd, "file.txt"), "same\nsame\n", "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "replace_text")!;
  const result = await executeTool(tool, { path: "file.txt", old_text: "same", new_text: "new" }, { cwd, approve: async () => true });
  assert.match(result, /not unique/);
  assert.equal(await fs.readFile(path.join(cwd, "file.txt"), "utf8"), "same\nsame\n");
});

test("apply_patch shows a preview and applies all changes atomically", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-patch-"));
  await fs.writeFile(path.join(cwd, "file.txt"), "alpha\nbeta\n", "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "apply_patch")!;
  let preview = "";
  const result = await executeTool(
    tool,
    { path: "file.txt", patches: [{ old_text: "alpha", new_text: "one" }, { old_text: "beta", new_text: "two" }] },
    { cwd, approve: async (request) => { preview = request.preview ?? ""; return true; } },
  );
  assert.match(preview, /- alpha/);
  assert.match(preview, /\+ two/);
  assert.match(result, /Applied 2 change/);
  assert.equal(await fs.readFile(path.join(cwd, "file.txt"), "utf8"), "one\ntwo\n");
});

test("read tools are auto-approved while dangerous commands carry their risk", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-risk-"));
  let approvals = 0;
  const listTool = builtinTools.find((candidate) => candidate.name === "list_files")!;
  await executeTool(listTool, { pattern: "**/*" }, { cwd, approve: async () => { approvals++; return false; } });
  assert.equal(approvals, 0);
  assert.equal(classifyCommand("git status"), "read");
  assert.equal(classifyCommand("npm test"), "execute");
  assert.equal(classifyCommand("Remove-Item -Recurse important"), "dangerous");

  const commandTool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  let seenRisk = "";
  await executeTool(commandTool, { command: "Remove-Item important.txt" }, {
    cwd,
    approve: async (request) => { seenRisk = request.risk; return false; },
  });
  assert.equal(seenRisk, "dangerous");
});

test("project_info detects npm verification scripts", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-project-info-"));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "sample", scripts: { test: "node --test", build: "tsc" } }), "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "project_info")!;
  const result = await executeTool(tool, {}, { cwd, approve: async () => false });
  const info = JSON.parse(result) as { name: string; suggested_checks: string[] };
  assert.equal(info.name, "sample");
  assert.deepEqual(info.suggested_checks, ["test", "build"]);
});

test("run_command reports timeouts clearly", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific command");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-timeout-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const result = await executeTool(tool, { command: "Start-Sleep -Seconds 2", timeout_ms: 100 }, { cwd, approve: async () => true });
  assert.match(result, /timed out/i);
});

test("run_command rejects Bash syntax before requesting approval on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific behavior");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-shell-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  let approvalRequested = false;
  const result = await executeTool(
    tool,
    { command: "git log && echo ok 2>/dev/null" },
    { cwd, approve: async () => { approvalRequested = true; return true; } },
  );
  assert.match(result, /Windows PowerShell 5\.1/);
  assert.equal(approvalRequested, false);
});

test("run_command preserves UTF-8 PowerShell output", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific behavior");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-encoding-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const result = await executeTool(tool, { command: "Write-Output '编码正常'" }, { cwd, approve: async () => true });
  assert.match(result, /编码正常/);
});

test("run_command preserves UTF-8 output from a Node child process", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific behavior");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-node-encoding-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const result = await executeTool(tool, { command: "node -e \"console.log('节点编码正常')\"" }, { cwd, approve: async () => true });
  assert.match(result, /节点编码正常/);
});

test("run_command allows operators inside a quoted JavaScript program", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific behavior");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-quoted-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const result = await executeTool(tool, { command: "node -e \"console.log(true || false)\"" }, { cwd, approve: async () => true });
  assert.match(result, /true/);
});
