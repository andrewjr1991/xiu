import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PROVIDER_WINDOWS_PRIVACY_SCRIPT, providerWindowsPowerShellPath, providerWindowsPowerShellEnvironment, verifyProviderWindowsPrivacy, providerWindowsPrivacyFailureStage, providerWindowsPrivacyFailureCategory } from "../src/provider-config-migration.js";

const run = promisify(execFile);
const script = PROVIDER_WINDOWS_PRIVACY_SCRIPT.replace("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage')", "if ($true)");

test("constrained backend preserves strict ACL checks without forbidden method calls or PATH helpers", () => {
  const backend = script.slice(script.indexOf("if ($true)"), script.indexOf("function Get-XiuPrivacyFailureCategory"));
  assert.doesNotMatch(backend, /::|\.SetOwner|\.GetOwner|\.GetAccessRules|\/setowner/i);
  assert.match(backend, /SystemRoot\\System32\\icacls\.exe/);
  assert.match(backend, /SystemRoot\\System32\\whoami\.exe/);
  assert.match(backend, /XIU_PROVIDER_INITIALIZE -eq '1'/);
  assert.match(backend, /\$LASTEXITCODE -ne 0/);
  assert.match(backend, /Get-Acl -LiteralPath \$p/);
});

test("constrained SDDL LA normalization requires both native SID and resolved owner account", { skip: process.platform !== "win32" }, async () => {
  const start = script.indexOf("function Get-XiuConstrainedDescriptor");
  const helper = script.slice(start, script.indexOf("\n    $identity =", start));
  const sid = "S-1-5-21-123-456-789-500";
  const descriptor = "O:LAG:BAD:PAI(A;OICI;FA;;;LA)";
  const cases = [
    { descriptor, sid, owner: "fixture\\admin", account: "FIXTURE\\ADMIN", expected: `O:${sid}G:BAD:PAI(A;OICI;FA;;;${sid})` },
    { descriptor, sid, owner: "other\\admin", account: "fixture\\admin", expected: "rejected" },
    { descriptor, sid: "S-1-5-21-123-456-789-1001", owner: "fixture\\admin", account: "fixture\\admin", expected: "rejected" },
    { descriptor, sid: "S-1-5-32-500", owner: "fixture\\admin", account: "fixture\\admin", expected: "rejected" },
    { descriptor: "O:BAG:BAD:P(A;;FA;;;BA)", sid, owner: "fixture\\admin", account: "fixture\\admin", expected: "O:BAG:BAD:P(A;;FA;;;BA)" },
  ];
  const result = await run(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoProfile", "-NonInteractive", "-Command", `${helper}\n$cases = ConvertFrom-Json $env:XIU_TEST_CASES; foreach ($case in $cases) { try { $actual = Get-XiuConstrainedDescriptor @{ Sddl=$case.descriptor; Owner=$case.owner } $case.sid $case.account } catch { $actual = 'rejected' }; if ($actual -cne $case.expected) { throw 'Descriptor fixture mismatch' } }; Write-Output 'ok'`], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment({ ...process.env, XIU_TEST_CASES: JSON.stringify(cases) }) });
  assert.equal(result.stdout.trim(), "ok");
});

test("native constrained ACL backend initializes empty objects, verifies read-only and rejects expanded permissions", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clm-中文-' "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mode = await run(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoProfile", "-NonInteractive", "-Command", "$ExecutionContext.SessionState.LanguageMode"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment(process.env) });
  const invoke = (target: string, directory: boolean, initialize: boolean) => run(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", script], {
    windowsHide: true, timeout: 15_000, maxBuffer: 1024,
    env: providerWindowsPowerShellEnvironment({ ...process.env, XIU_PROVIDER_PRIVATE_TARGET: target, XIU_PROVIDER_DIRECTORY: directory ? "1" : "0", XIU_PROVIDER_INITIALIZE: initialize ? "1" : "0" }),
  }).catch((error: unknown) => {
    throw new Error(`Constrained fixture ${directory ? "directory" : "file"}/${initialize ? "initialize" : "verify"}: ${providerWindowsPrivacyFailureStage(error)}/${providerWindowsPrivacyFailureCategory(error)}`);
  });
  for (const directory of [true, false]) {
    const target = path.join(root, directory ? "directory" : "file");
    if (directory) await fs.mkdir(target); else await fs.writeFile(target, "");
    // Elevated FullLanguage CI can create objects owned by Administrators.
    // Establish fixture ownership using the normal backend first. In real
    // constrained mode initialize directly, with no ownership takeover.
    if (mode.stdout.trim() === "FullLanguage") await verifyProviderWindowsPrivacy(target, directory, true);
    const descriptor = await run(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:XIU_TEST_TARGET).Sddl -replace 'S-1-[0-9]+(?:-[0-9]+)+','SID'"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment({ ...process.env, XIU_TEST_TARGET: target }) });
    // Synthetic empty fixtures only, with all numeric identities removed.
    assert.match(descriptor.stdout.trim(), /^[A-Z0-9:;()]+$/i);
    t.diagnostic(`${directory ? "directory" : "file"} descriptor shape: ${descriptor.stdout.trim()}`);
    assert.equal((await invoke(target, directory, true)).stdout.trim(), "XIU_ACL_V1:ok");
    assert.equal((await invoke(target, directory, false)).stdout.trim(), "XIU_ACL_V1:ok");
    // A deliberately broadened isolated fixture must be rejected, not repaired.
    await run(path.win32.join(process.env.SystemRoot!, "System32", "icacls.exe"), [target, "/grant", "*S-1-1-0:R", "/q"], { windowsHide: true });
    await assert.rejects(invoke(target, directory, false));
    await assert.rejects(invoke(target, directory, false));
    if (!directory) assert.equal(await fs.readFile(target, "utf8"), "");
  }
});
