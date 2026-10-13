import assert from "node:assert/strict";
import type fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { BACKGROUND_BOOTSTRAP_SOURCE } from "../src/background-bootstrap.js";
import { replaceFileWithRetry } from "../src/background-lifecycle.js";

function renamer(failures: string[]): { io: typeof fs; calls: () => number } {
  let calls = 0;
  const io = {
    renameSync() {
      calls += 1;
      const code = failures.shift();
      if (code) throw Object.assign(new Error(code), { code });
    },
  } as unknown as typeof fs; // Only renameSync is used.
  return { io, calls: () => calls };
}

test("record replacement retries while Windows holds the target open", () => {
  const { io, calls } = renamer(["EPERM", "EACCES", "EBUSY"]);
  replaceFileWithRetry(io, "record.json.tmp", "record.json");
  assert.equal(calls(), 4);
});

test("record replacement does not retry other errors", () => {
  const { io, calls } = renamer(["ENOENT"]);
  assert.throws(() => replaceFileWithRetry(io, "record.json.tmp", "record.json"), { code: "ENOENT" });
  assert.equal(calls(), 1);
});

test("record replacement gives up after a bounded number of attempts", () => {
  const { io, calls } = renamer(Array.from({ length: 20 }, () => "EPERM"));
  assert.throws(() => replaceFileWithRetry(io, "record.json.tmp", "record.json"), { code: "EPERM" });
  assert.equal(calls(), 7);
});

test("the bootstrap source embeds the retrying replacement and still compiles", () => {
  assert.match(BACKGROUND_BOOTSTRAP_SOURCE, /const replaceFileWithRetry = /);
  assert.doesNotMatch(BACKGROUND_BOOTSTRAP_SOURCE, /fs\.renameSync\(temporary/);
  assert.doesNotThrow(() => new vm.Script(BACKGROUND_BOOTSTRAP_SOURCE));
});
