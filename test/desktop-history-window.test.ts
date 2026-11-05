import assert from "node:assert/strict";
import test from "node:test";
import { expandHistoryWindow, historyWindowForRound, latestHistoryWindow, normalizeHistoryWindow } from "../apps/desktop/renderer/src/history-window.js";

test("historical opening keeps the latest complete rounds with a bounded initial window", () => {
  assert.deepEqual(latestHistoryWindow(0), { start: 0, end: 0, total: 0 });
  assert.deepEqual(latestHistoryWindow(3), { start: 0, end: 3, total: 3 });
  assert.deepEqual(latestHistoryWindow(500), { start: 450, end: 500, total: 500 });
});

test("loading earlier and later rounds preserves every already displayed index", () => {
  let window = latestHistoryWindow(500);
  window = expandHistoryWindow(window, "earlier");
  assert.deepEqual(window, { start: 400, end: 500, total: 500 });
  const older = historyWindowForRound(500, 10);
  assert.deepEqual(expandHistoryWindow(older, "later"), { start: 0, end: 100, total: 500 });
  assert.deepEqual(expandHistoryWindow(older, "earlier"), older);
  for (let step = 0; step < 20; step++) window = expandHistoryWindow(window, "earlier");
  assert.deepEqual(window, { start: 0, end: 500, total: 500 });
});

test("every round can be reached directly, including uneven final batches", () => {
  assert.deepEqual(historyWindowForRound(0, 0), latestHistoryWindow(0));
  for (const total of [1, 49, 50, 51, 75, 500, 2000]) for (let round = 0; round < total; round++) {
    const window = historyWindowForRound(total, round);
    assert.ok(window.start <= round && round < window.end);
    assert.ok(window.end - window.start <= 50);
    assert.ok(window.start >= 0 && window.end <= total);
  }
});

test("snapshot growth retains displayed rounds without moving an older reading window", () => {
  assert.deepEqual(normalizeHistoryWindow(latestHistoryWindow(500), 501), { start: 450, end: 501, total: 501 });
  assert.deepEqual(normalizeHistoryWindow(historyWindowForRound(500, 20), 501), { start: 0, end: 50, total: 501 });
  assert.deepEqual(normalizeHistoryWindow(latestHistoryWindow(500), 20), { start: 0, end: 20, total: 20 });
  assert.deepEqual(normalizeHistoryWindow(latestHistoryWindow(500), 0), latestHistoryWindow(0));
});
