import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, executeToolResult } from "../src/tools.js";

for (const toolName of ["run_process", "run_command"] as const) {
  for (const script of ["echo test", "node --version"]) {
    test(`${toolName}: npm test running ${JSON.stringify(script)} is not verification evidence`, async (t) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-npm-evidence-"));
      t.after(async () => { await fs.rm(cwd, { recursive: true, force: true }); });
      await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
        name: "offline-verification-fixture", version: "1.0.0", private: true,
        scripts: { test: script },
      }));
      const tool = builtinTools.find((candidate) => candidate.name === toolName)!;
      const input = toolName === "run_process"
        ? { program: "npm", args: ["test"] }
        : { command: process.platform === "win32" ? "npm.cmd test" : "npm test" };
      const result = await executeToolResult(tool, input, { cwd, approve: async () => true });
      assert.equal(result.status, "success", result.output);
      assert.equal(result.exitCode, 0, result.output);
      assert.equal(tool.isVerification?.(input, result.output), false,
        "a package script name and zero exit code must not turn an informational command into evidence");
    });
  }
}
