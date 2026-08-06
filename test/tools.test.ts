import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, classifyCommand, executeTool, looksLikeVerification, resolveWorkspacePath } from "../src/tools.js";

test("resolveWorkspacePath blocks traversal", () => {
  const root = path.resolve("workspace");
  assert.equal(resolveWorkspacePath(root, "src/index.ts"), path.join(root, "src/index.ts"));
  assert.throws(() => resolveWorkspacePath(root, "../secret.txt"), /escapes workspace/);
  assert.throws(() => resolveWorkspacePath(root, path.parse(root).root), /escapes workspace/);
});

test("custom verifier scripts count as verification commands", () => {
  assert.equal(looksLikeVerification("python test/verify_prelabel.py"), true);
  assert.equal(looksLikeVerification("node scripts/check-output.js"), true);
  assert.equal(looksLikeVerification("python scripts/output_validate.py"), true);
  assert.equal(looksLikeVerification("python prelabel_v4.py"), false);

  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  assert.equal(tool.isVerification?.({ command: "python test/verify_prelabel.py" }, "Exit code: 0\nVerification passed."), true);
  assert.equal(tool.isVerification?.({ command: "python test/verify_prelabel.py" }, "Exit code: 1\nVerification failed."), false);
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

test("read_file returns a bounded line page with an explicit continuation hint", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-read-page-"));
  await fs.writeFile(path.join(cwd, "large.txt"), Array.from({ length: 260 }, (_, index) => `line-${index + 1}`).join("\n"), "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "read_file")!;
  const first = await executeTool(tool, { path: "large.txt" }, { cwd, approve: async () => false });
  assert.match(first, /^Lines 1-200 of 260/m);
  assert.match(first, /200: line-200/);
  assert.doesNotMatch(first, /201: line-201/);
  assert.match(first, /PARTIAL view.*start_line=201/i);

  const second = await executeTool(tool, { path: "large.txt", start_line: 201 }, { cwd, approve: async () => false });
  assert.match(second, /^Lines 201-260 of 260/m);
  assert.match(second, /260: line-260/);
});

test("read_file cannot bypass the bounded line window with a huge explicit end line", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-read-explicit-page-"));
  await fs.writeFile(path.join(cwd, "huge.txt"), Array.from({ length: 900 }, (_, index) => `line-${index + 1}`).join("\n"), "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "read_file")!;
  const result = await executeTool(tool, { path: "huge.txt", start_line: 100, end_line: 900 }, { cwd, approve: async () => false });
  assert.match(result, /^Lines 100-599 of 900/m);
  assert.match(result, /599: line-599/);
  assert.doesNotMatch(result, /600: line-600/);
  assert.match(result, /start_line=600/);
});

test("read_file can page through a giant single-line file by character offset", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-read-character-"));
  const content = "A".repeat(70_000) + "TAIL-MARKER";
  await fs.writeFile(path.join(cwd, "case.html"), content, "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "read_file")!;
  const first = await executeTool(tool, { path: "case.html", start_character: 0, max_characters: 1_000 }, { cwd, approve: async () => false });
  assert.match(first, /^Characters 0-999 of 70011/m);
  assert.match(first, /PARTIAL view.*start_character=1000/i);
  const tail = await executeTool(tool, { path: "case.html", start_character: 70_000, max_characters: 100 }, { cwd, approve: async () => false });
  assert.match(tail, /TAIL-MARKER/);
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

test("run_command forces UTF-8 output for Python children on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific behavior");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-python-encoding-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const result = await executeTool(tool, { command: "python -c \"print('中文输出正常')\"" }, { cwd, approve: async () => true });
  assert.match(result, /中文输出正常/);
  assert.doesNotMatch(result, /UnicodeEncodeError/);
});

test("run_command allows operators inside a quoted JavaScript program", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific behavior");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-quoted-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const result = await executeTool(tool, { command: "node -e \"console.log(true || false)\"" }, { cwd, approve: async () => true });
  assert.match(result, /true/);
});
