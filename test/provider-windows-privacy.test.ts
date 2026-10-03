import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { ProviderConfigurationError, providerWindowsPrivacyFailureStage, providerWindowsPrivacyFailureKind, providerWindowsPrivacyFailureCategory, providerWindowsPowerShellPath, providerWindowsPowerShellEnvironment, verifyProviderWindowsPrivacy, PROVIDER_WINDOWS_PRIVACY_SCRIPT } from "../src/provider-config-migration.js";
import { ProviderRegistry } from "../src/provider-registry.js";

const runFile = promisify(execFile);
const canary = "fixture_privacy_Q7nP8_no_real_key";

async function fullLanguageAvailable(): Promise<boolean> {
  const result = await runFile(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoProfile", "-NonInteractive", "-Command", "$ExecutionContext.SessionState.LanguageMode"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment(process.env) });
  return result.stdout.trim() === "FullLanguage";
}

test("Windows Provider privacy child environment drops only case-insensitive PSModulePath keys", () => {
  const parent = Object.freeze({ SystemRoot: "C:\\Windows", PATH: "fixture-path", PSModulePath: "fixture-ps7-modules", PSMODULEPATH: "fixture-uppercase", pSmOdUlEpAtH: "", XIU_PROVIDER_PRIVATE_TARGET: "fixture-target", XIU_PROVIDER_DIRECTORY: "1", XIU_PROVIDER_INITIALIZE: "0", fixtureUnset: undefined });
  const before = { ...parent };
  const child = providerWindowsPowerShellEnvironment(parent);
  assert.deepEqual(child, { SystemRoot: "C:\\Windows", PATH: "fixture-path", XIU_PROVIDER_PRIVATE_TARGET: "fixture-target", XIU_PROVIDER_DIRECTORY: "1", XIU_PROVIDER_INITIALIZE: "0", fixtureUnset: undefined });
  assert.deepEqual(parent, before);
  assert.notEqual(child, parent);
  assert.deepEqual(providerWindowsPowerShellEnvironment({}), {});
  assert.deepEqual(providerWindowsPowerShellEnvironment({ PSModulePath: "" }), {});
});

test("Windows Provider privacy helper resolves only a validated absolute SystemRoot path", () => {
  for (const root of ["C:\\Windows", "D:\\Win NT", "C:\\Windows\\", "D:/Windows", "C:\\系统目录"]) {
    const executable = providerWindowsPowerShellPath(root);
    assert.ok(path.win32.isAbsolute(executable));
    assert.equal(executable, path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  for (const root of [undefined, "", "Windows", "C:Windows", "\\Windows", "C:\\", "C:\\Windows\\..", "C:\\Windows\\.\\Other", "C:\\Windows. ", "C:\\Windows\\\\Other", "C:\\Windows:stream", "\\\\server\\Windows", "\\\\?\\C:\\Windows", "\\\\.\\C:\\Windows", `C:\\Windows\u0000${canary}`, `C:\\${canary}\\..`]) {
    assert.throws(() => providerWindowsPowerShellPath(root), (error: unknown) => {
      assert.ok(error instanceof ProviderConfigurationError);
      assert.equal(error.code, "unsafe");
      assert.equal(error.privacyStage, "process-start");
      assert.ok(!String(error).includes(canary));
      assert.equal(error.message, "Provider configuration storage is not a protected regular file/directory. Close other clients and inspect storage before retrying. Windows ACL helper location is unavailable or invalid.");
      return true;
    });
  }
});

test("Windows Provider privacy production invocation never searches PATH or the workspace", async () => {
  const source = await fs.readFile(new URL("../src/provider-config-migration.ts", import.meta.url), "utf8");
  assert.match(source, /const executable = providerWindowsPowerShellPath\(process\.env\.SystemRoot\)/);
  assert.match(source, /await runFile\(executable, \["-NoLogo", "-NoProfile", "-NonInteractive"/);
  assert.match(source, /const env = providerWindowsPowerShellEnvironment\(\{ \.\.\.process\.env, XIU_PROVIDER_PRIVATE_TARGET:/);
  assert.match(source, /timeout: 15_000, maxBuffer: 1024, env \}/);
  assert.doesNotMatch(source, /runFile\(["']powershell(?:\.exe)?["']/);
  assert.match(source, /timeout: 15_000, maxBuffer: 1024/);
});

const freshDescriptor = `if ($isDirectory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [System.Security.AccessControl.FileSecurity]::new() }`;
const ownerAndAccessWrite = `if ($isDirectory) { [System.IO.Directory]::SetAccessControl($p, $acl) }
    else { [System.IO.File]::SetAccessControl($p, $acl) }`;

// A failed historical comparison is evidence, never permission to skip a failed
// candidate. Each variant gets its own empty fixture; no write is retried.
test("Windows privacy preflight compares fresh and existing descriptors and requires section-scoped persistence", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  if (!await fullLanguageAvailable()) { t.skip("Historical .NET descriptor comparison requires FullLanguage; constrained production backend is covered separately"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu descriptor 中文 ' "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.ok(PROVIDER_WINDOWS_PRIVACY_SCRIPT.includes(freshDescriptor));
  assert.ok(PROVIDER_WINDOWS_PRIVACY_SCRIPT.includes(ownerAndAccessWrite));
  // Keep identities inside PowerShell. Only a boolean metadata invariant and
  // the same bounded success/failure protocol leave the fixture process.
  const instrumented = PROVIDER_WINDOWS_PRIVACY_SCRIPT
    .replace("$p = $env:XIU_PROVIDER_PRIVATE_TARGET", "$p = $env:XIU_PROVIDER_PRIVATE_TARGET; $beforeGroup = (Get-Acl -LiteralPath $p).GetGroup([System.Security.Principal.SecurityIdentifier])")
    .replace("$stage = 'verify-protection'", "if ($beforeGroup -ne $acl.GetGroup([System.Security.Principal.SecurityIdentifier])) { throw [System.InvalidOperationException]::new('Fixture group changed') }; $stage = 'verify-protection'");
  const populated = instrumented.replace(freshDescriptor, `$acl = Get-Acl -LiteralPath $p
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($existing) }
    if ($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]).Count -ne 0) { throw 'Fixture DACL not empty' }`);
  const variants = [
    { name: "historical-fresh-set-acl", script: instrumented.replace(ownerAndAccessWrite, "Set-Acl -LiteralPath $p -AclObject $acl"), required: false },
    { name: "historical-existing-set-acl", script: populated.replace(ownerAndAccessWrite, "Set-Acl -LiteralPath $p -AclObject $acl"), required: false },
    { name: "candidate-fresh-owner-access", script: instrumented, required: true },
    { name: "candidate-existing-owner-access", script: populated, required: true },
  ];
  for (const variant of variants) for (const directory of [true, false]) {
    const target = path.join(root, `${variant.name}-${directory ? "directory" : "file"}`);
    if (directory) await fs.mkdir(target); else await fs.writeFile(target, "");
    let outcome = "ok";
    try {
      const result = await runFile(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", variant.script], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment({ ...process.env, PSModulePath: "C:\\xiu-fixture-missing-ps7-modules", XIU_PROVIDER_PRIVATE_TARGET: target, XIU_PROVIDER_DIRECTORY: directory ? "1" : "0", XIU_PROVIDER_INITIALIZE: "1" }) });
      if (!/^XIU_ACL_V1:ok\r?\n?$/.test(result.stdout)) outcome = "protocol";
    } catch (error) {
      outcome = `${providerWindowsPrivacyFailureKind(error)}/${providerWindowsPrivacyFailureStage(error)}/${providerWindowsPrivacyFailureCategory(error)}`;
    }
    t.diagnostic(`${variant.name}/${directory ? "directory" : "file"}: ${outcome}`);
    if (variant.required) assert.equal(outcome, "ok", "section-scoped persistence must preserve group metadata and pass every owner-only invariant");
  }
});

// This is an explicit Windows preflight. CI must run it as a required Windows
// gate before broader suites; a skipped run on another OS is not validation.
test("Windows Provider privacy preflight creates verifies and rejects changed owner-only ACLs", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  // Simulate pwsh -> Node -> powershell.exe with an unusable inherited module
  // path. The production helper must reset only its child; restore this fixture
  // process before cleanup, even when any assertion fails.
  const modulePath = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\xiu-fixture-missing-ps7-modules";
  t.after(() => { if (modulePath === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = modulePath; });
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
  assert.equal(process.env.PSModulePath, "C:\\xiu-fixture-missing-ps7-modules", "the helper must not mutate its parent's environment");
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
    try { await runFile(path.win32.join(process.env.SystemRoot!, "System32", "icacls.exe"), [target, "/grant", "*S-1-1-0:R", "/q"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 }); }
    catch { throw new Error("Windows privacy fixture modification failed"); }
  };
  const rejectedPrivately = (error: unknown) => {
    assert.ok(error instanceof ProviderConfigurationError);
    assert.equal(error.code, "unsafe");
    assert.ok(["verify-rule-count", "verify-rule-rights"].includes(error.privacyStage!));
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
  for (const category of ["access-denied", "privilege-not-held", "invalid-owner", "invalid-group", "invalid-descriptor", "invalid-acl", "invalid-parameter", "invalid-operation", "command-not-found", "argument", "io", "unknown"]) {
    const error = { code: 1, stdout: `XIU_ACL_V1:initialize-write:${category}\r\n`, stderr: canary, message: canary };
    assert.equal(providerWindowsPrivacyFailureCategory(error), category);
    assert.equal(providerWindowsPrivacyFailureStage(error), "initialize-write");
  }
  for (const stdout of [`XIU_ACL_V1:initialize-write:${canary}`, `XIU_ACL_V1:initialize-write:argument\n${canary}`, `XIU_ACL_V1:initialize-write:${"x".repeat(101)}`, `XIU_ACL_V1:${canary}:access-denied`]) {
    assert.equal(providerWindowsPrivacyFailureCategory({ code: 1, stdout }), "unavailable");
    assert.equal(providerWindowsPrivacyFailureStage({ code: 1, stdout }), "process");
  }
  for (const code of ["ENOENT", "EACCES", "EPERM", "EINVAL", "ENOEXEC", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) assert.equal(providerWindowsPrivacyFailureCategory({ code, stdout: "XIU_ACL_V1:initialize-write:access-denied" }), "unavailable");
  assert.equal(providerWindowsPrivacyFailureCategory({ killed: true, stdout: "XIU_ACL_V1:initialize-write:access-denied" }), "unavailable");
});

test("Windows privacy preflight classifies wrapped exceptions without their private messages", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
  if (!await fullLanguageAvailable()) { t.skip("Constructing .NET exception fixtures requires FullLanguage"); return; }
  const prefix = "$ErrorActionPreference = 'Stop'\n" + PROVIDER_WINDOWS_PRIVACY_SCRIPT.slice(PROVIDER_WINDOWS_PRIVACY_SCRIPT.indexOf("function Get-XiuPrivacyFailureCategory"), PROVIDER_WINDOWS_PRIVACY_SCRIPT.lastIndexOf("$stage = 'identity'"));
  const script = `${prefix}
try {
  $cases = @(
    @(5, 'access-denied'), @(87, 'invalid-parameter'), @(1307, 'invalid-owner'),
    @(1308, 'invalid-group'), @(1314, 'privilege-not-held'), @(1336, 'invalid-acl'), @(1338, 'invalid-descriptor')
  )
  foreach ($case in $cases) {
    $inner = [System.ComponentModel.Win32Exception]::new($case[0], $env:XIU_TEST_EXCEPTION_CANARY)
    $wrapped = [System.Exception]::new($env:XIU_TEST_EXCEPTION_CANARY, $inner)
    if ((Get-XiuPrivacyFailureCategory $wrapped) -ne $case[1]) { throw 'Fixture category mismatch' }
  }
  $argument = [System.ArgumentException]::new($env:XIU_TEST_EXCEPTION_CANARY, [System.ComponentModel.Win32Exception]::new(5, $env:XIU_TEST_EXCEPTION_CANARY))
  if ((Get-XiuPrivacyFailureCategory $argument) -ne 'invalid-parameter') { throw 'Fixture argument HRESULT mismatch' }
  $missing = [System.Management.Automation.CommandNotFoundException]::new($env:XIU_TEST_EXCEPTION_CANARY)
  if ((Get-XiuPrivacyFailureCategory $missing) -ne 'command-not-found') { throw 'Fixture command category mismatch' }
  $hresult = [System.Runtime.InteropServices.COMException]::new($env:XIU_TEST_EXCEPTION_CANARY, -2147023582)
  if ((Get-XiuPrivacyFailureCategory $hresult) -ne 'privilege-not-held') { throw 'Fixture HRESULT mismatch' }
  $unknown = [System.Exception]::new($env:XIU_TEST_EXCEPTION_CANARY)
  if ((Get-XiuPrivacyFailureCategory $unknown) -ne 'unknown') { throw 'Fixture fallback mismatch' }
  [Console]::Out.WriteLine('XIU_ACL_V1:ok')
  exit 0
} catch { [Console]::Out.WriteLine('XIU_ACL_V1:initialize-write:unknown'); exit 1 }
`;
  try {
    const result = await runFile(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", script], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment({ ...process.env, XIU_TEST_EXCEPTION_CANARY: canary }) });
    assert.match(result.stdout, /^XIU_ACL_V1:ok\r?\n?$/);
    assert.equal(result.stderr, "");
  } catch (error) {
    // Do not attach the original process error or assertion payload.
    throw new Error(`Windows exception fixture failed: ${providerWindowsPrivacyFailureKind(error)}/${providerWindowsPrivacyFailureStage(error)}/${providerWindowsPrivacyFailureCategory(error)}`);
  }
});

test("Windows privacy script keeps typed owner-only checks and fixed-output exception boundary", () => {
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.ok(PROVIDER_WINDOWS_PRIVACY_SCRIPT.indexOf("$ProgressPreference") < PROVIDER_WINDOWS_PRIVACY_SCRIPT.indexOf("Get-Acl"));
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /DirectorySecurity\]::new\(\)/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /FileSecurity\]::new\(\)/);
  assert.ok(PROVIDER_WINDOWS_PRIVACY_SCRIPT.includes(ownerAndAccessWrite));
  assert.doesNotMatch(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /^\s*Set-Acl\b/m);
  assert.doesNotMatch(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\.SetGroup\(|\.SetAuditRule|\.SetSecurityDescriptor/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$rules\.Count -ne 1/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$rules\[0\]\.IdentityReference\.Value -ne \$sid\.Value/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$rules\[0\]\.FileSystemRights -ne \$full/);
  assert.match(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /\$depth -lt 8/);
  assert.doesNotMatch(PROVIDER_WINDOWS_PRIVACY_SCRIPT, /Write-(?:Host|Error)|\$Error\[|\.Message|\.ToString\(|\.StackTrace|\.TargetObject/);
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
