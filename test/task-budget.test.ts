import assert from "node:assert/strict";
import test from "node:test";
import { taskBudgetSnapshot } from "../src/task-budget.js";

test("task budgets are unlimited until a limit is configured", () => {
  assert.equal(taskBudgetSnapshot({ warningRatio: 0.8 }, { tokens: 10, modelCalls: 1, toolCalls: 1, failures: 0, wallTimeMs: 100 }).state, "unlimited");
});

test("task budgets warn before exhaustion and identify exhausted metrics", () => {
  const limits = { tokens: 100, modelCalls: 10, warningRatio: 0.8 };
  const warning = taskBudgetSnapshot(limits, { tokens: 80, modelCalls: 1, toolCalls: 0, failures: 0, wallTimeMs: 10 });
  assert.equal(warning.state, "warning");
  assert.deepEqual(warning.warning, ["tokens"]);
  const exhausted = taskBudgetSnapshot(limits, { tokens: 101, modelCalls: 10, toolCalls: 0, failures: 0, wallTimeMs: 10 });
  assert.equal(exhausted.state, "exhausted");
  assert.deepEqual(exhausted.exhausted, ["tokens", "modelCalls"]);
});
