import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { requireUiSmokeResult } = require("../apps/desktop/scripts/ui-smoke-result.cjs") as { requireUiSmokeResult(stdout: string): unknown };

test("UI completion requires this run's complete result rather than a zero exit or progress text", () => {
  const result = { passed: true, viewports: ["1366x768", "900x768"], calls: ["task:create"] };
  assert.deepEqual(requireUiSmokeResult(`UI smoke: progress\n${JSON.stringify(result, null, 2)}\n`), result);
  for (const output of ["", "UI smoke: progress only", "all checks passed", '{\n  "passed": true,', JSON.stringify({ ...result, passed: false }, null, 2), JSON.stringify({ ...result, viewports: ["1366x768"] }, null, 2), JSON.stringify({ ...result, calls: [] }, null, 2)]) {
    assert.throws(() => requireUiSmokeResult(output));
  }
});
