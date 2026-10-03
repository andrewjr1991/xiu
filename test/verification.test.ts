import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureVerificationStamp, isVerificationCommand, VerificationLedger, verificationCheckKey, verifyOutputSupersedes } from "../src/verification.js";

test("verification command classification rejects information-only variants and =value flags", () => {
  for (const command of [
    "tsc --all", "tsc --listFilesOnly", "tsc --showConfig", "tsc --init", "tsc -v", "tsc -help", "tsc -version", "tsc -all",
    "vitest list", "npx --yes vitest list", "eslint --print-config src/index.js", "eslint --env-info",
    "pytest --fixtures", "pytest --fixtures-per-test", "pytest --collect-only=true", "pytest --markers",
    "python -m pytest --fixtures", "python3 -m unittest --help", "python -c 'print(42)'",
    "npm test -- --listTests=true", "npm test -- --help=true", "npm test -- --showConfig=true", "jest --listTests=true",
    "node --test --eval=42", "node --test --print=42", "echo test",
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test("verification command classification preserves verbose/configured actual test invocations", () => {
  for (const command of [
    "pytest -v", "pytest -c pytest.ini", "python -m pytest -c pytest.ini", "python3.12 -m pytest -v",
    "python -m unittest -v", "go test -v ./...", "cargo test -v", "vitest run", "vitest related src/index.ts --run",
    "node --test test/example.test.mjs", "tsc --noEmit", "npm run test", "npm run typecheck", "npx --yes vitest run",
  ]) assert.equal(isVerificationCommand(command), true, command);
});

test("verification check identity ignores execution controls but preserves actual targets and arguments", () => {
  const first = verificationCheckKey("run_process", { program: "node", args: ["--test", "one.mjs"], timeout_ms: 1000, output_encoding: "utf8" });
  assert.equal(first, verificationCheckKey("run_process", { output_encoding: "utf16le", args: ["--test", "one.mjs"], program: "node", timeout_ms: 3000 }));
  assert.notEqual(first, verificationCheckKey("run_process", { program: "node", args: ["--test", "two.mjs"] }));
  assert.notEqual(verificationCheckKey("verify_output", { path: "one.txt", min_bytes: 3 }), verificationCheckKey("verify_output", { path: "one.txt", min_bytes: 4 }));
  assert.notEqual(verificationCheckKey("validate_project", { check: "test" }), verificationCheckKey("validate_project", { check: "build" }));
});

test("stronger verify_output expectations safely supersede stale checks for the same artifact", () => {
  const weaker = { path: "report.html", required_substrings: ["Alice"], forbidden_substrings: ["TBD"], min_bytes: 100 };
  const stronger = { path: ".\\report.html", required_substrings: ["Alice", "Bob"], forbidden_substrings: ["TBD", "undefined"], min_bytes: 200, max_bytes: 30_000 };
  assert.equal(verifyOutputSupersedes(stronger, weaker), true);
  assert.equal(verifyOutputSupersedes(weaker, stronger), false);
  assert.equal(verifyOutputSupersedes({ ...stronger, path: "other.html" }, weaker), false);

  const ledger = new VerificationLedger();
  ledger.recordTool("verify_output", weaker, true);
  ledger.invalidate();
  ledger.recordTool("verify_output", stronger, true);
  assert.equal(ledger.passed, true);
  assert.equal(ledger.failed, false);
  assert.equal(ledger.snapshot().checks.length, 1);
});

test("weaker or unrelated output checks cannot erase stale required verification", () => {
  const ledger = new VerificationLedger();
  ledger.recordTool("verify_output", { path: "report.html", required_substrings: ["Alice", "Bob"] }, true);
  ledger.invalidate();
  ledger.recordTool("verify_output", { path: "report.html", required_substrings: ["Alice"] }, true);
  ledger.recordTool("verify_output", { path: "other.html", required_substrings: ["Bob"] }, true);
  assert.equal(ledger.passed, false);
  assert.equal(ledger.failed, true);
});

test("longer required strings and shorter forbidden strings imply prior expectations", () => {
  const previous = {
    path: "report.html",
    required_substrings: ["共完成19位", "优势"],
    forbidden_substrings: ["TBD: pending"],
  };
  const current = {
    path: "report.html",
    required_substrings: ["主管好，9月18日—24日共完成19位候选人", "<h4>优势</h4>"],
    forbidden_substrings: ["TBD"],
  };
  assert.equal(verifyOutputSupersedes(current, previous), true);
  assert.equal(verifyOutputSupersedes(previous, current), false);
});

test("explicit verification stamps cover ignored binary artifacts using raw bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-verify-stamp-"));
  await fs.writeFile(path.join(root, ".gitignore"), "artifact.bin\n");
  await fs.writeFile(path.join(root, "artifact.bin"), Buffer.from([0, 1, 2, 3]));
  const genericBefore = await captureVerificationStamp(root);
  const explicitBefore = await captureVerificationStamp(root, ["artifact.bin"]);
  assert.equal(explicitBefore, await captureVerificationStamp(root, ["artifact.bin"]));
  await fs.writeFile(path.join(root, "artifact.bin"), Buffer.from([0, 1, 2, 4]));
  assert.equal(genericBefore, await captureVerificationStamp(root), "generic inventory deliberately excludes ignored files");
  assert.notEqual(explicitBefore, await captureVerificationStamp(root, ["artifact.bin"]));
});

test("explicit stamps reject out-of-workspace and linked paths instead of following them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-verify-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-verify-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside secret");
  await fs.symlink(outside, path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(captureVerificationStamp(root, ["outside/secret.txt"]), /outside workspace|links/);
  await assert.rejects(captureVerificationStamp(root, [path.join(outside, "secret.txt")]), /escapes workspace/);
  await fs.mkdir(path.join(root, "real"));
  await fs.writeFile(path.join(root, "real", "file.txt"), "inside");
  await fs.symlink(path.join(root, "real"), path.join(root, "inside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(captureVerificationStamp(root, ["inside/file.txt"]), /links/);
});

test("large explicit stamps retain bounded prefix and metadata evidence, and limit path count", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-verify-large-"));
  await fs.writeFile(path.join(root, ".gitignore"), "large.bin\n");
  await fs.writeFile(path.join(root, "large.bin"), Buffer.alloc(300_000, 1));
  const before = await captureVerificationStamp(root, ["large.bin"]);
  const handle = await fs.open(path.join(root, "large.bin"), "r+");
  try { await handle.write(Buffer.from([2]), 0, 1, 299_999); } finally { await handle.close(); }
  const advanced = new Date(Date.now() + 1000);
  await fs.utimes(path.join(root, "large.bin"), advanced, advanced);
  assert.notEqual(before, await captureVerificationStamp(root, ["large.bin"]));
  await assert.rejects(captureVerificationStamp(root, Array.from({ length: 65 }, (_, index) => `file-${index}.txt`)), /limit exceeded/);
});


test("absence and content checks cannot supersede each other", () => {
  const absent = { path: "removed.txt", exists: false };
  const present = { path: "removed.txt", required_substrings: ["present"] };
  assert.equal(verifyOutputSupersedes(absent, present), false);
  assert.equal(verifyOutputSupersedes(present, absent), false);
  assert.equal(verifyOutputSupersedes(absent, { ...absent }), true);
  const ledger = new VerificationLedger();
  ledger.recordTool("verify_output", absent, false);
  ledger.recordTool("verify_output", present, true);
  assert.equal(ledger.passed, false);
  assert.deepEqual(ledger.evidenceChecks(), []);
});

test("verification receipts expose bounded check identity without contents", () => {
  const ledger = new VerificationLedger();
  ledger.recordTool("verify_output", { path: "artifact.txt", required_substrings: ["private fixture content"] }, true);
  assert.deepEqual(ledger.evidenceChecks(), [{ toolName: "verify_output", path: "artifact.txt" }]);
  for (let index = 0; index < 65; index++) ledger.recordTool("verify_output", { path: `artifact-${index}.txt`, min_bytes: 1 }, true);
  assert.deepEqual(ledger.evidenceChecks(), []);
});
