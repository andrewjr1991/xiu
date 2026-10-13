import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATIC_DURATION_MS,
  AUTOMATIC_INPUT_LIMIT,
  inputNeedsConfirmation,
  mayReuseMergedGrant,
  nextTaskBudget,
} from "../apps/desktop/main/computer-use-policy.js";

test("a merged Full Access grant covers re-selection only while the task allowance remains", () => {
  const now = 1_000_000;
  const first = nextTaskBudget(undefined, "task-1", now, false);
  assert.deepEqual(first, { task: "task-1", deadline: now + AUTOMATIC_DURATION_MS, inputs: 0 });
  assert.equal(mayReuseMergedGrant({ automatic: true, grantMatches: true, budget: first, task: "task-1", now }), true);

  // Re-selecting under the merged grant continues the same deadline and count.
  const spent = { ...first, inputs: 42 };
  assert.equal(nextTaskBudget(spent, "task-1", now + 60_000, false), spent);

  // Exhausted inputs or an expired deadline require the dialog again.
  const exhausted = { ...first, inputs: AUTOMATIC_INPUT_LIMIT };
  assert.equal(mayReuseMergedGrant({ automatic: true, grantMatches: true, budget: exhausted, task: "task-1", now }), false);
  assert.equal(mayReuseMergedGrant({ automatic: true, grantMatches: true, budget: first, task: "task-1", now: first.deadline }), false);

  // Only an explicit confirmation starts a fresh allowance.
  assert.deepEqual(nextTaskBudget(exhausted, "task-1", now + 1, true), { task: "task-1", deadline: now + 1 + AUTOMATIC_DURATION_MS, inputs: 0 });
});

test("another task, a different grant or manual mode never reuse the merged grant", () => {
  const now = 5_000;
  const budget = nextTaskBudget(undefined, "task-1", now, false);
  assert.equal(mayReuseMergedGrant({ automatic: true, grantMatches: false, budget, task: "task-1", now }), false);
  assert.equal(mayReuseMergedGrant({ automatic: false, grantMatches: true, budget, task: "task-1", now }), false);
  // An exhausted allowance belongs to its task; a new task starts its own.
  const exhausted = { ...budget, inputs: AUTOMATIC_INPUT_LIMIT };
  assert.equal(mayReuseMergedGrant({ automatic: true, grantMatches: true, budget: exhausted, task: "task-2", now }), true);
  assert.deepEqual(nextTaskBudget(exhausted, "task-2", now, false), { task: "task-2", deadline: now + AUTOMATIC_DURATION_MS, inputs: 0 });
});

test("renderer-originated inputs always need confirmation, even in automatic mode", () => {
  assert.equal(inputNeedsConfirmation({ automatic: true, origin: "model" }), false);
  assert.equal(inputNeedsConfirmation({ automatic: true, origin: "renderer" }), true);
  assert.equal(inputNeedsConfirmation({ automatic: false, origin: "model" }), true);
  assert.equal(inputNeedsConfirmation({ automatic: false, origin: "renderer" }), true);
});
