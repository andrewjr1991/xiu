import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PROVIDER_WINDOWS_PRIVACY_SCRIPT, providerWindowsPowerShellPath, providerWindowsPowerShellEnvironment, verifyProviderWindowsPrivacy } from "../src/provider-config-migration.js";

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

test("native constrained ACL backend initializes empty objects, verifies read-only and rejects expanded permissions", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clm-中文-' "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mode = await run(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoProfile", "-NonInteractive", "-Command", "$ExecutionContext.SessionState.LanguageMode"], { windowsHide: true, timeout: 15_000, maxBuffer: 1024, env: providerWindowsPowerShellEnvironment(process.env) });
  const invoke = (target: string, directory: boolean, initialize: boolean) => run(providerWindowsPowerShellPath(process.env.SystemRoot), ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", script], {
    windowsHide: true, timeout: 15_000, maxBuffer: 1024,
    env: providerWindowsPowerShellEnvironment({ ...process.env, XIU_PROVIDER_PRIVATE_TARGET: target, XIU_PROVIDER_DIRECTORY: directory ? "1" : "0", XIU_PROVIDER_INITIALIZE: initialize ? "1" : "0" }),
  });
  for (const directory of [true, false]) {
    const target = path.join(root, directory ? "directory" : "file");
    if (directory) await fs.mkdir(target); else await fs.writeFile(target, "");
    // Elevated FullLanguage CI can create objects owned by Administrators.
    // Establish fixture ownership using the normal backend first. In real
    // constrained mode initialize directly, with no ownership takeover.
    if (mode.stdout.trim() === "FullLanguage") await verifyProviderWindowsPrivacy(target, directory, true);
    assert.equal((await invoke(target, directory, true)).stdout.trim(), "XIU_ACL_V1:ok");
    assert.equal((await invoke(target, directory, false)).stdout.trim(), "XIU_ACL_V1:ok");
    // A deliberately broadened isolated fixture must be rejected, not repaired.
    await run(path.win32.join(process.env.SystemRoot!, "System32", "icacls.exe"), [target, "/grant", "*S-1-1-0:R", "/q"], { windowsHide: true });
    await assert.rejects(invoke(target, directory, false));
    await assert.rejects(invoke(target, directory, false));
    if (!directory) assert.equal(await fs.readFile(target, "utf8"), "");
  }
});
