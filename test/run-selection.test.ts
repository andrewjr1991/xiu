import assert from "node:assert/strict";
import test from "node:test";
import { selectRun } from "../src/commands/run-selection.js";
import type { TaskRunRecord } from "../src/task-run.js";

/** Only the fields the selector reads; the records are newest first, as the journal lists them. */
function journal(runIds: string[]) {
  const runs = runIds.map((runId) => ({ runId }) as TaskRunRecord);
  return { latest: async () => runs[0], recent: async () => runs };
}

test("run:<number> selects by 1-based list index and run:<prefix> by run id", async () => {
  const source = journal(["aaaa1111-0000-4000-8000-000000000001", "bbbb2222-0000-4000-8000-000000000002"]);
  assert.equal((await selectRun(source, undefined, "en-US", "/diff runs"))?.runId, "aaaa1111-0000-4000-8000-000000000001");
  assert.equal((await selectRun(source, "2", "en-US", "/diff runs"))?.runId, "bbbb2222-0000-4000-8000-000000000002");
  assert.equal((await selectRun(source, "BBBB2", "en-US", "/diff runs"))?.runId, "bbbb2222-0000-4000-8000-000000000002");
  await assert.rejects(() => selectRun(source, "3", "en-US", "/diff runs"), /There is no run #3; 2 recent run\(s\) exist\. List them with \/diff runs\./);
  await assert.rejects(() => selectRun(source, "abc", "en-US", "/diff runs"), /at least 4 characters/);
  await assert.rejects(() => selectRun(source, "cccc", "en-US", "/diff runs"), /No run id among the 2 recent run\(s\) starts with cccc/);
});

test("a digits-only prefix of a hex run id selects that run instead of being read as a list index", async () => {
  // Run ids are UUIDs; about one in forty starts with eight digits, which used to be parsed as run #69049616.
  const source = journal(["69049616-0000-4000-8000-000000000001", "12345678-0000-4000-8000-000000000002"]);
  assert.equal((await selectRun(source, "69049616", "en-US", "/diff runs"))?.runId, "69049616-0000-4000-8000-000000000001");
  assert.equal((await selectRun(source, "1234", "en-US", "/diff runs"))?.runId, "12345678-0000-4000-8000-000000000002");
  // A digits-only selector that matches no run id by prefix is still the list index.
  assert.equal((await selectRun(source, "2", "en-US", "/diff runs"))?.runId, "12345678-0000-4000-8000-000000000002");
  assert.equal((await selectRun(source, "0001", "en-US", "/diff runs"))?.runId, "69049616-0000-4000-8000-000000000001");
});

test("an ambiguous prefix asks for more characters", async () => {
  const source = journal(["abcd0001-0000-4000-8000-000000000001", "abcd0002-0000-4000-8000-000000000002"]);
  await assert.rejects(() => selectRun(source, "abcd", "en-US", "/report runs"), /matches 2 runs; add more characters/);
  assert.equal((await selectRun(source, "abcd0002", "en-US", "/report runs"))?.runId, "abcd0002-0000-4000-8000-000000000002");
});
