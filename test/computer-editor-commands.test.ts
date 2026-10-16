import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native editor dispatch selects message or keyboard once and preserves rejection/unknown outcomes", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xiu-editor-routing-"));
  try {
    const framework = path.join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319");
    const executable = path.join(directory, "EditorRoutingTests.exe");
    const compiled = spawnSync(path.join(framework, "csc.exe"), [
      "/nologo", "/target:exe", "/platform:x64", "/main:ComputerEditorCommandTests", `/out:${executable}`,
      "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", "/r:System.Web.Extensions.dll",
      ...["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll"].map(name => `/r:${path.join(framework, "WPF", name)}`),
      fileURLToPath(new URL("../apps/desktop/native/ComputerBridge.cs", import.meta.url)),
      fileURLToPath(new URL("./fixtures/computer-editor-commands.cs", import.meta.url)),
    ], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.equal(compiled.error, undefined);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS message timeout\/error never replays/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
