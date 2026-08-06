import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceChangeNotice, summarizeTextChange, type WorkspaceFileSnapshot } from "../src/change-summary.js";

function snapshot(path: string, content: string | undefined, exists = true): WorkspaceFileSnapshot {
  return { path, exists, bytes: content === undefined ? 2_000_000 : Buffer.byteLength(content), content };
}

test("change summary reports created file lines and a bounded preview", () => {
  const change = summarizeTextChange("result.html", snapshot("result.html", "", false), snapshot("result.html", "<!doctype html>\n<table>\n001\n002\n</table>\n<script>\nmore"));
  assert.equal(change?.kind, "created");
  assert.equal(change?.additions, 7);
  assert.equal(change?.deletions, 0);
  assert.equal(change?.preview.length, 6);
  assert.match(change?.preview[0] ?? "", /^\+ <!doctype html>/);
});

test("change summary reports actual added and removed lines for a modification", () => {
  const before = snapshot("app.ts", "const keep = 1;\nconst oldValue = 2;\nexport { keep };");
  const after = snapshot("app.ts", "const keep = 1;\nconst newValue = 3;\nconst extra = true;\nexport { keep };");
  const change = summarizeTextChange("app.ts", before, after);
  assert.equal(change?.kind, "modified");
  assert.equal(change?.additions, 2);
  assert.equal(change?.deletions, 1);
  assert.deepEqual(change?.preview, ["- const oldValue = 2;", "+ const newValue = 3;", "+ const extra = true;"]);
});

test("workspace notice omits paths whose content did not change", () => {
  const before = new Map([["same.txt", snapshot("same.txt", "same")]]);
  const after = new Map([["same.txt", snapshot("same.txt", "same")]]);
  assert.equal(buildWorkspaceChangeNotice("write_file", "write same.txt", ["same.txt"], before, after), undefined);
});

test("large or binary snapshots fall back to byte-size summaries", () => {
  const before = snapshot("asset.bin", undefined, false);
  const after = snapshot("asset.bin", undefined, true);
  const change = summarizeTextChange("asset.bin", before, after);
  assert.equal(change?.kind, "created");
  assert.equal(change?.additions, undefined);
  assert.deepEqual(change?.preview, []);
  assert.equal(change?.bytesAfter, 2_000_000);
});
