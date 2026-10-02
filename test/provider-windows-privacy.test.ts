import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { ProviderConfigurationError, providerWindowsPrivacyFailureStage, providerWindowsPrivacyFailureKind, verifyProviderWindowsPrivacy, PROVIDER_WINDOWS_PRIVACY_SCRIPT } from "../src/provider-config-migration.js";
import { ProviderRegistry } from "../src/provider-registry.js";

const runFile = promisify(execFile);
const canary = "fixture_privacy_Q7nP8_no_real_key";

// This is an explicit Windows preflight. CI must run it as a required Windows
// gate before broader suites; a skipped run on another OS is not validation.
test("Windows Provider privacy preflight creates verifies and rejects changed owner-only ACLs", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu privacy 中文 ' "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "providers.json");
  const bytes = Buffer.from(JSON.stringify({ version: 4, profiles: [{
    id: "local", name: "Fixture", kind: "ollama", model: "fixture", baseURL: "http://127.0.0.1:11434/v1", apiKey: canary,
    features: { text: true, tools: true, vision: false, image: false, video: false },
  }] }));
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  const registry = new ProviderRegistry(filename);
  await registry.load();
  const diagnostics = await registry.configurationDiagnostics();
  assert.equal(diagnostics.state, "current");
  assert.equal(diagnostics.backups.length, 1);
  const directory = `${filename}.recovery`;
  const backupId = diagnostics.backups[0]!.id;
  const backup = path.join(directory, `${backupId}.json`);
  for (const [target, isDirectory] of [[directory, true], [filename, false], [backup, false]] as const) await verifyProviderWindowsPrivacy(target, isDirectory, false);
  const envelope = JSON.parse(await fs.readFile(backup, "utf8"));
  assert.ok(Buffer.from(envelope.payload, "base64").equals(bytes), "verified backup must preserve exact fixture bytes");
  const current = await fs.readFile(filename);

  const broaden = async (target: string) => {
    const script = `$ErrorActionPreference='Stop'; try { $p=$env:XIU_TEST_PRIVATE_TARGET; $acl=Get-Acl -LiteralPath $p; $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; exit 0 } catch { exit 1 }`;
    try { await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: { ...process.env, XIU_TEST_PRIVATE_TARGET: target } }); }
    catch { throw new Error("Windows privacy fixture modification failed"); }
  };
  const rejectedPrivately = (error: unknown) => {
    assert.ok(error instanceof ProviderConfigurationError);
    assert.equal(error.code, "unsafe");
    assert.equal(error.privacyStage, "verify-rule-count");
    assert.ok(!String(error).includes(canary) && !String(error).includes(root), "privacy errors must expose fixed stage codes only");
    return true;
  };
  await broaden(backup);
  await assert.rejects(registry.previewConfigurationRecovery(backupId), rejectedPrivately);
  await broaden(directory);
  await assert.rejects(registry.setRoutingEnabled(true), rejectedPrivately);
  assert.ok((await fs.readFile(filename)).equals(current), "unsafe ACL must block before replacing current settings");
});

test("Windows ACL subprocess failures expose only bounded allowlisted stage codes", () => {
  for (const stage of ["identity", "initialize-descriptor", "initialize-rule", "initialize-owner", "initialize-protection", "initialize-add-rule", "initialize-write", "verify-read", "verify-protection", "verify-owner", "verify-rule-count", "verify-rule-identity", "verify-rule-type", "verify-rule-rights", "verify-rule-propagation", "verify-directory-inheritance"]) {
    assert.equal(providerWindowsPrivacyFailureStage({ stdout: `XIU_ACL_V1:${stage}\r\n`, stderr: canary, message: canary }), stage);
  }
  for (const error of [canary, null, { stdout: `XIU_ACL_V1:verify-owner\n${canary}` }, { stdout: `XIU_ACL_V1:${canary}` }, { stdout: "x".repeat(101) }, { stderr: canary }, { code: canary }]) assert.equal(providerWindowsPrivacyFailureStage(error), "process");
  assert.equal(providerWindowsPrivacyFailureStage({ code: "ENOENT", message: canary }), "process-start");
  assert.equal(providerWindowsPrivacyFailureStage({ killed: true, stderr: canary }), "timeout");
  assert.equal(providerWindowsPrivacyFailureStage({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: canary }), "output-limit");
  assert.equal(providerWindowsPrivacyFailureKind({ code: "ENOENT", stderr: canary }), "spawn");
  assert.equal(providerWindowsPrivacyFailureKind({ killed: true, stderr: canary }), "timeout");
  assert.equal(providerWindowsPrivacyFailureKind({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, stderr: canary }), "stdio-limit");
  assert.equal(providerWindowsPrivacyFailureKind({ code: 1, stdout: "XIU_ACL_V1:verify-owner" }), "nonzero-exit");
  assert.equal(providerWindowsPrivacyFailureKind({ code: canary, stderr: canary }), "process");
});

test("Windows privacy script keeps typed owner-only checks and fixed-output exception boundary", () => {
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.ok(PROVIDER_WINDOWS_PRIVACY_SCRIPT.indexOf("$ProgressPreference") < PROVIDER_WINDOWS_PRIVACY_SCRIPT.indexOf("Get-Acl"));
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /DirectorySecurity\]::new\(\)/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /FileSecurity\]::new\(\)/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$rules\.Count -ne 1/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$rules\[0\]\.IdentityReference\.Value -ne \$sid\.Value/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$rules\[0\]\.FileSystemRights -ne \$full/);
  assert.doesNotMatch(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /Write-(?:Host|Error)|\$Error\[|\.Exception|\$_/);
});

test("real bounded child failures classify without exposing subprocess diagnostics", { timeout: 10_000 }, async () => {
  const capture = async (program: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}) => runFile(program, args, { windowsHide: true, timeout: 2_000, maxBuffer: 1024, ...options }).then(
    () => { throw new Error("Expected the isolated diagnostic fixture to fail"); },
    (error: unknown) => error,
  );
  const nonzero = await capture(process.execPath, ["-e", `process.stdout.write('XIU_ACL_V1:verify-owner\\n'); process.stderr.write(${JSON.stringify(canary)}); process.exit(7)`]);
  assert.equal(providerWindowsPrivacyFailureKind(nonzero), "nonzero-exit");
  assert.equal(providerWindowsPrivacyFailureStage(nonzero), "verify-owner");
  const overflow = await capture(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(canary)}.repeat(1000))`]);
  assert.equal(providerWindowsPrivacyFailureKind(overflow), "stdio-limit");
  assert.equal(providerWindowsPrivacyFailureStage(overflow), "output-limit");
  const timeout = await capture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 });
  assert.equal(providerWindowsPrivacyFailureKind(timeout), "timeout");
  const missing = await capture(path.join(os.tmpdir(), "xiu-nonexistent-acl-fixture-6e77054b"), []);
  assert.equal(providerWindowsPrivacyFailureKind(missing), "spawn");
});
