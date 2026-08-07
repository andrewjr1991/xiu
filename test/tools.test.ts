import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, classifyCommand, classifyProcess, executeTool, formatProcessInvocation, looksLikeVerification, resolveWorkspacePath, verificationCommandPassed } from "../src/tools.js";

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
  assert.equal(looksLikeVerification("python -c \"print('验证结果: PASS')\""), true);
  assert.equal(looksLikeVerification("python prelabel_v4.py"), false);

  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  assert.equal(tool.isVerification?.({ command: "python test/verify_prelabel.py" }, "Exit code: 0\nVerification passed."), true);
  assert.equal(tool.isVerification?.({ command: "python test/verify_prelabel.py" }, "Exit code: 1\nVerification failed."), false);
  assert.equal(verificationCommandPassed("Exit code: 0\nHTML验证失败: invalid XML"), false);
  assert.equal(verificationCommandPassed("Exit code: 0\nVerification: false"), false);
});

test("verify_output proves generated artifacts with deterministic expectations", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-verify-output-"));
  const content = "<!DOCTYPE html><html><body><table><tr><td>001</td><td>002</td></tr></table><script>function copyAllData(){}</script></body></html>";
  await fs.writeFile(path.join(cwd, "result.html"), content, "utf8");
  const tool = builtinTools.find((candidate) => candidate.name === "verify_output")!;
  const input = {
    path: "result.html",
    required_substrings: ["<!DOCTYPE html>", "<table>", "001", "002", "copyAllData"],
    forbidden_substrings: ["验证失败"],
    min_bytes: 100,
  };
  const passed = await executeTool(tool, input, { cwd, approve: async () => false });
  assert.match(passed, /^Verification passed:/);
  assert.equal(tool.isVerification?.(input, passed), true);

  const failedInput = { path: "result.html", required_substrings: ["missing-sample-003"] };
  const failed = await executeTool(tool, failedInput, { cwd, approve: async () => false });
  assert.match(failed, /^Verification failed:/);
  assert.equal(tool.isVerification?.(failedInput, failed), false);

  const invalid = await executeTool(tool, { path: "result.html" }, { cwd, approve: async () => false });
  assert.match(invalid, /^Tool error:.*at least one substring or byte-size expectation/);
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

test("direct process formatting and risk classification keep arguments separate", () => {
  assert.equal(formatProcessInvocation("node", ["script with spaces.js", "single'quote", "$HOME|value"]), "node 'script with spaces.js' 'single''quote' '$HOME|value'");
  assert.equal(classifyProcess("git", ["status", "--short"]), "read");
  assert.equal(classifyProcess("git", ["reset", "--hard"]), "dangerous");
  assert.equal(classifyProcess("node", ["script.js"]), "execute");
});

test("run_process preserves complex arguments without PowerShell interpretation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-direct-args-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_process")!;
  const values = ["space value", "single'quote", 'double"quote', "$HOME", "a;b&c|d", JSON.stringify({ nested: "值" }), "中文"];
  let preview = "";
  const result = await executeTool(tool, {
    program: "node",
    args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...values],
  }, {
    cwd,
    approve: async (request) => { preview = request.preview ?? ""; return true; },
  });
  assert.match(preview, /Direct process \(no shell parsing\)/);
  assert.deepEqual(JSON.parse(result.slice(result.indexOf("\n") + 1)), values);
});

test("run_process rejects shell wrappers and escaped workspace programs before approval", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-direct-boundary-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_process")!;
  let approvals = 0;
  const shell = await executeTool(tool, { program: "powershell.exe", args: ["-Command", "Write-Output unsafe"] }, { cwd, approve: async () => { approvals++; return true; } });
  assert.match(shell, /does not accept a shell wrapper/);
  const escaped = await executeTool(tool, { program: "../outside", args: [] }, { cwd, approve: async () => { approvals++; return true; } });
  assert.match(escaped, /escapes workspace/);
  assert.equal(approvals, 0);
});

test("run_process reports missing programs and PowerShell failures recommend direct arguments", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-direct-errors-"));
  const direct = builtinTools.find((candidate) => candidate.name === "run_process")!;
  const missing = await executeTool(direct, { program: "xiu-program-that-does-not-exist", args: [] }, { cwd, approve: async () => true });
  assert.match(missing, /was not found/);
  if (process.platform !== "win32") return t.skip("PowerShell-specific migration hint");
  const shell = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const failed = await executeTool(shell, { command: "node -e \"throw new Error('expected failure')\"" }, { cwd, approve: async () => true });
  assert.match(failed, /Retry with run_process/);
});

test("run_process supports verification, timeout, and cancellation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-direct-lifecycle-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_process")!;
  const verificationInput = { program: "node", args: ["scripts/verify-output.js"] };
  assert.equal(tool.isVerification?.(verificationInput, "Exit code: 0\nVerification passed."), true);

  const timedOut = await executeTool(tool, { program: "node", args: ["-e", "setTimeout(() => {}, 5000)"], timeout_ms: 1_000 }, { cwd, approve: async () => true });
  assert.match(timedOut, /timed out/i);

  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = executeTool(tool, { program: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 15_000 }, { cwd, approve: async () => true, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.match(await pending, /cancelled by user/i);
  assert.ok(Date.now() - startedAt < 5_000, "cancelled direct process should stop promptly");
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

test("run_command abort signal cancels active PowerShell work", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific command cancellation");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-command-cancel-"));
  const tool = builtinTools.find((candidate) => candidate.name === "run_command")!;
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = executeTool(tool, { command: "Start-Sleep -Seconds 10", timeout_ms: 15_000 }, { cwd, approve: async () => true, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  assert.match(await pending, /cancelled by user/i);
  assert.ok(Date.now() - startedAt < 5_000, "cancelled command should not wait for its original timeout");
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
