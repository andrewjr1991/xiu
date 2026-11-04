import assert from "node:assert/strict";
import test from "node:test";
import { verificationSummary } from "../apps/desktop/renderer/src/verification-presentation.js";
import { verificationSummaryLabel } from "../src/status-labels.js";

test("verification presentation rejects damaged counters and never treats model prose as evidence", () => {
  const valid = { total: 2, passed: 1, failed: 0, stale: 1, revision: 1, state: "stale" };
  assert.deepEqual(verificationSummary(valid), valid);
  for (const value of [undefined, null, [], "all tests passed", { ...valid, passed: -1 }, { ...valid, total: 3 }, { ...valid, passed: {} }, { ...valid, state: "passed" }, { ...valid, revision: Infinity }]) assert.equal(verificationSummary(value), undefined);
  assert.deepEqual(verificationSummary({ total: 0, passed: 0, failed: 0, stale: 0, revision: 0, state: "not_run" }), { total: 0, passed: 0, failed: 0, stale: 0, revision: 0, state: "not_run" });
});

test("CLI ledger labels distinguish unavailable history, no checks and stale evidence", () => {
  assert.equal(verificationSummaryLabel(undefined, "en-US"), "no ledger recorded in this process");
  assert.equal(verificationSummaryLabel({ total: 0, passed: 0, failed: 0, stale: 0, revision: 0, state: "not_run" }, "zh-CN"), "本轮未运行程序检查");
  assert.equal(verificationSummaryLabel({ total: 2, passed: 1, failed: 0, stale: 1, revision: 1, state: "stale" }, "en-US"), "passed 1/2 · failed 0 · stale 1");
});
