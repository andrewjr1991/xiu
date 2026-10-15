import assert from "node:assert/strict";
import test from "node:test";
import { compareStartTimes, configureProcessStartTimeProbe, parseElapsed, processStartTime, processStartTimeSync, START_TIME_TOLERANCE_MS } from "../src/process-identity.js";

test("elapsed-time strings from ps are parsed in every documented shape", () => {
  assert.equal(parseElapsed("05"), undefined);
  assert.equal(parseElapsed("00:05"), 5_000);
  assert.equal(parseElapsed("1:02:03"), 3_723_000);
  assert.equal(parseElapsed("2-01:02:03\n"), (2 * 86_400 + 3_723) * 1000);
  assert.equal(parseElapsed("garbage"), undefined);
});

test("start times compare within a tolerance and stay unknown without evidence", () => {
  const recorded = "2026-10-15T10:00:00.000Z";
  const at = Date.parse(recorded);
  assert.equal(compareStartTimes(recorded, at), "match");
  assert.equal(compareStartTimes(recorded, at + START_TIME_TOLERANCE_MS), "match");
  assert.equal(compareStartTimes(recorded, at - START_TIME_TOLERANCE_MS - 1), "mismatch");
  assert.equal(compareStartTimes(recorded, at + 3_600_000), "mismatch");
  assert.equal(compareStartTimes(undefined, at), "unknown");
  assert.equal(compareStartTimes(recorded, undefined), "unknown");
  assert.equal(compareStartTimes("not a date", at), "unknown");
});

test("the OS probe reports this process's own start time and nothing for an absent PID", async (t) => {
  const expected = Date.now() - process.uptime() * 1000;
  const observed = await processStartTime(process.pid);
  assert.ok(observed !== undefined, `the ${process.platform} probe must answer for a live process`);
  assert.ok(Math.abs(observed - expected) <= START_TIME_TOLERANCE_MS, `observed ${new Date(observed).toISOString()} vs expected ${new Date(expected).toISOString()}`);
  if (process.platform !== "win32") {
    const cheap = processStartTimeSync(process.pid);
    assert.ok(cheap !== undefined && Math.abs(cheap - expected) <= START_TIME_TOLERANCE_MS, "the synchronous probe agrees");
  } else {
    assert.equal(processStartTimeSync(process.pid), undefined, "Windows has no cheap synchronous probe");
  }
  // A PID far above the usual range is almost certainly absent; an answer must then be undefined, never a guess.
  const absent = 2 ** 22 - 7;
  t.diagnostic(`probing absent pid ${absent}`);
  assert.equal(await processStartTime(absent), undefined);
});

test("tests can replace the probes and the override is removed again", async () => {
  configureProcessStartTimeProbe({ sync: (pid) => pid * 10, async: async (pid) => pid * 100 });
  try {
    assert.equal(processStartTimeSync(7), 70);
    assert.equal(await processStartTime(7), 700);
    configureProcessStartTimeProbe({ sync: () => 5 });
    assert.equal(await processStartTime(1), 5, "an async probe falls back to the sync override");
  } finally { configureProcessStartTimeProbe(); }
  assert.notEqual(processStartTimeSync(7), 70);
});
