import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalTime } from "../src/local-time.js";

test("times people read are local time to the second rather than raw ISO strings", () => {
  const local = new Date(2026, 9, 19, 23, 46, 18, 223);
  assert.equal(formatLocalTime(local.toISOString()), "2026-10-19 23:46:18");
  assert.equal(formatLocalTime(local.getTime()), "2026-10-19 23:46:18");
  assert.equal(formatLocalTime(local), "2026-10-19 23:46:18");
  assert.equal(formatLocalTime(new Date(2026, 0, 5, 7, 8, 9)), "2026-01-05 07:08:09");
  assert.equal(formatLocalTime("not a date"), "not a date");
});
