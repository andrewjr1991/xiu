import test from "node:test";
import assert from "node:assert/strict";
import { textDiff } from "../src/text-diff.js";
import { changeStats } from "../apps/desktop/renderer/src/change-stats.js";

test("large replacement retains additions and full independent counts despite preview truncation", () => {
  const old = Array.from({ length: 1042 }, (_, i) => `old-${i}-${"x".repeat(90)}`).join("\n");
  const next = Array.from({ length: 1059 }, (_, i) => `new-${i}-${"x".repeat(90)}`).join("\n");
  const diff = textDiff(old, next);
  assert.deepEqual(diff.stats, { additions: 1059, deletions: 1042, exact: true });
  assert.match(diff.preview!, /\n- old-/); assert.match(diff.preview!, /\n\+ new-/);
  assert.match(diff.preview!, /preview truncated/);
  assert.ok(Buffer.byteLength(diff.preview!) <= 16384);
  assert.match(diff.fullDiff!, /new-1058/);
  assert.doesNotMatch(diff.fullDiff!, /preview truncated/);
  assert.equal(changeStats({ ...diff, path: "a", kind: "modified", source: "unknown", preExisting: false, staged: false, limitations: [] }).approximate, false);
});
test("separate changes do not count unchanged interior lines", () => {
  const diff = textDiff("a\nold\nkeep\nold2\nz\n", "a\nnew\nkeep\nnew2\nz\n");
  assert.deepEqual(diff.stats, { additions: 2, deletions: 2, exact: true });
  assert.doesNotMatch(diff.preview!, /[-+] keep/);
  assert.match(diff.fullDiff!, /\n keep\n/);
  assert.match(diff.preview!, /@@ -2,1 \+2,1/); assert.match(diff.preview!, /@@ -4,1 \+4,1/);
});
test("creation, deletion, empty and bounded-work fallback", () => {
  assert.deepEqual(textDiff("", "a\nb\n").stats, { additions: 2, deletions: 0, exact: true });
  assert.deepEqual(textDiff("a\n", "").stats, { additions: 0, deletions: 1, exact: true });
  assert.equal(textDiff("same", "same").preview, undefined);
  assert.match(textDiff("a\nz", "a\nnew\nz").preview!, /@@ -1,0 \+2,1/);
  assert.match(textDiff("a\nold\nz", "a\nz").preview!, /@@ -2,1 \+1,0/);
  const diff = textDiff("a\n".repeat(1600), "b\n".repeat(1600));
  assert.equal(diff.stats.exact, false);
  assert.match(diff.preview!, /\+ b/);
});

test("legacy truncated replacement uses saved hunk spans as estimates, never zero additions", () => {
  const result = changeStats({ path: "index.html", kind: "modified", source: "unknown", preExisting: false, staged: false, limitations: [], preview: "@@ -33,1042 +33,1059 @@ (preview)\n- old\n... (preview truncated)" });
  assert.deepEqual(result, { additions: 1059, deletions: 1042, approximate: true });
});
