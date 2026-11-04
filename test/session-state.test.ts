import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskPlanManager } from "../src/plan.js";
import { listSessionsWithIssues, loadSession, refreshSessionSummary } from "../src/session.js";

test("known malformed saved state is visible to history but cannot silently change restored Plan mode", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-session-state-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "state.jsonl");
  const invalid = [
    ...[null, "false", 0, [], {}].map((enabled) => ({ type: "plan_mode", enabled })),
    { type: "plan_mode" },
    { type: "plan", plan: { goal: "missing steps" } },
    { type: "plan", plan: { goal: "bad step", steps: [null] } },
    { type: "plan", plan: { goal: "bad status", steps: [{ id: "a", title: "Keep data", status: "PASS" }] } },
    { type: "plan", plan: { goal: "coerced status", steps: [{ id: "a", title: "Keep data", status: ["pending"] }] } },
    { type: "plan", plan: { goal: "duplicate ids", steps: [{ id: "a", title: "one", status: "pending" }, { id: "a", title: "two", status: "pending" }] } },
    { type: "stats", stats: { modelCalls: "3" } },
    { type: "stats", stats: { inputTokens: -1 } },
    { type: "stats", stats: [] },
  ];
  for (const event of invalid) {
    await fs.writeFile(file, [
      { type: "task", task: "Read-only task" },
      { type: "plan_mode", enabled: true },
      event,
    ].map((item) => JSON.stringify(item)).join("\n") + "\n");
    await assert.rejects(loadSession(cwd, "state"), { code: "SESSION_STATE_INVALID" }, JSON.stringify(event));
    const listing = await listSessionsWithIssues(cwd);
    assert.equal(listing.sessions.length, 1, "The history entry remains available for diagnosis.");
    assert.equal(listing.sessions[0]?.damagedLines, 1);
    assert.deepEqual(listing.unreadable, []);
  }
});

test("valid old plans, partial numeric stats and unknown events remain compatible", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-session-state-valid-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "valid.jsonl"), [
    { type: "task", task: "Inspect saved state" },
    { type: "plan_mode", enabled: true },
    { type: "plan", plan: { goal: "Inspect state", steps: [{ id: "read", title: "Read records", status: "pending" }] } },
    { type: "stats", stats: { modelCalls: 2, activeMs: 10.5, futureField: { privateText: "not a known statistic" } } },
    { type: "future_event_v2", payload: { anything: true } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const restored = await loadSession(cwd, "valid");
  assert.equal(restored.planMode, true);
  assert.equal(restored.stats.modelCalls, 2);
  assert.equal(restored.stats.activeMs, 10.5);
  assert.equal("futureField" in restored.stats, false);
  assert.match(new TaskPlanManager(restored.plan, restored.planMode).format(), /Read records/);
  assert.equal((await listSessionsWithIssues(cwd)).sessions[0]?.damagedLines, undefined);
});

test("a display summary cannot hide a subsequently damaged state record from restore", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-session-state-cache-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "cached.jsonl");
  await fs.writeFile(file, '{"type":"task","task":"Inspect only"}\n{"type":"plan_mode","enabled":true}\n');
  await refreshSessionSummary(file);
  const before = await fs.readFile(file, "utf8");
  await fs.appendFile(file, '{"type":"plan_mode","enabled":null}\n');
  await assert.rejects(loadSession(cwd, "cached"), { code: "SESSION_STATE_INVALID" });
  assert.equal(await fs.readFile(file, "utf8"), `${before}{"type":"plan_mode","enabled":null}\n`, "Restore must not repair or rewrite the log.");
});

test("old summaries fall back to a fresh state-validation scan without being rewritten", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-session-state-old-summary-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "old.jsonl");
  await fs.writeFile(file, '{"type":"task","task":"Inspect only"}\n{"type":"plan_mode","enabled":null}\n');
  await refreshSessionSummary(file);
  const summary = `${file}.summary.json`;
  const value = JSON.parse(await fs.readFile(summary, "utf8"));
  value.version = 1;
  value.item.damagedLines = 0;
  const old = JSON.stringify(value);
  await fs.writeFile(summary, old);
  assert.equal((await listSessionsWithIssues(cwd)).sessions[0]?.damagedLines, 1, "Earlier validation cannot hide damaged state in an unchanged source.");
  assert.equal(await fs.readFile(summary, "utf8"), old, "Listing remains read-only even when the cache schema changes.");
});
