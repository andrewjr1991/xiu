const assert = require("node:assert/strict");

function requireUiSmokeResult(stdout) {
  const start = stdout.lastIndexOf('{\n  "passed":');
  assert(start >= 0, "UI smoke did not produce a completion result.");
  let result;
  try { result = JSON.parse(stdout.slice(start)); }
  catch { throw new Error("UI smoke completion result is incomplete or invalid."); }
  assert.equal(result?.passed, true, "UI smoke did not report success.");
  assert(Array.isArray(result.viewports) && ["1366x768", "900x768"].every((viewport) => result.viewports.includes(viewport)), "UI smoke did not complete both required viewports.");
  assert(Array.isArray(result.calls) && result.calls.length > 0 && result.calls.every((call) => typeof call === "string"), "UI smoke is missing its fixture call trace.");
  return result;
}

module.exports = { requireUiSmokeResult };
