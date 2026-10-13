import assert from "node:assert/strict";
import test from "node:test";
import { readLaunchMetadata } from "../src/background-metadata.js";

test("Windows launch metadata retries delete-pending errors and accepts a vanished entry", () => {
  let reads = 0, waits = 0;
  assert.equal(readLaunchMetadata(() => { reads++; throw Object.assign(new Error("race"), { code: reads < 3 ? "EPERM" : "ENOENT" }); }, () => { waits++; }, "win32"), undefined);
  assert.equal(reads, 3); assert.equal(waits, 2);
});
test("persistent permissions and unrelated errors still fail closed", () => {
  for (const [platform, code, expected] of [["win32", "EPERM", 4], ["win32", "EACCES", 1], ["linux", "EPERM", 1]] as const) {
    let reads = 0;
    assert.throws(() => readLaunchMetadata(() => { reads++; throw Object.assign(new Error(code), { code }); }, () => undefined, platform), new RegExp(code));
    assert.equal(reads, expected);
  }
});
