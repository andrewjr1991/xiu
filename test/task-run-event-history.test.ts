import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunJournal, taskOperationSignature } from "../src/task-run.js";
import type { RuntimeEvent } from "../src/runtime/protocol.js";

const events: RuntimeEvent[] = [{ schemaVersion: 1, eventId: "display-event", taskId: "runtime-task", sequence: 1,
  timestamp: "2026-11-07T00:00:00.000Z", type: "assistant.message", payload: { text: "display fixture", hasToolCalls: false } }];
async function fixture(t: test.TestContext, paused = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-event-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, "runs"), journal = new TaskRunJournal(root, storage);
  const run = await journal.begin({ sessionId: "saved", task: "offline fixture", providerId: "offline", model: "offline" });
  await journal.beginOperation({ kind: "tool", name: "earlier effect", signature: taskOperationSignature("earlier effect", { id: 1 }), sideEffect: "external" });
  if (paused) await journal.pause("fixture pause");
  const directory = path.join(storage, journal.workspaceId), file = path.join(directory, `${run.runId}.json`);
  return { root, storage, journal, run, directory, file, other: new TaskRunJournal(root, storage) };
}
function beforeHistoryCommit(t: test.TestContext, action: () => Promise<void>) {
  const rename = fs.rename;
  let triggered = false;
  t.mock.method(fs, "rename", async (temporary: Parameters<typeof fs.rename>[0], target: Parameters<typeof fs.rename>[1]) => {
    const value = JSON.parse(await fs.readFile(temporary, "utf8"));
    const stream = value.runtimeEvents ?? value.events;
    if (!triggered && Array.isArray(stream) && stream.some(item => item?.eventId === "display-event")) {
      triggered = true; await action();
    }
    return rename(temporary, target);
  });
  return () => assert.equal(triggered, true, "controlled history commit was not reached");
}
test("a late event-history save cannot undo an explicit abandonment", async t => {
  const f = await fixture(t);
  let abandoned = "";
  const checked = beforeHistoryCommit(t, async () => {
    await f.other.abandon(f.run.runId); abandoned = await fs.readFile(f.file, "utf8");
  });
  await f.journal.saveRuntimeEvents(f.run.runId, events); checked();
  assert.equal(await fs.readFile(f.file, "utf8"), abandoned);
  assert.equal((await f.other.read(f.run.runId))?.status, "abandoned");
  assert.equal(await f.other.interrupted(), undefined);
  assert.deepEqual((await f.other.read(f.run.runId))?.runtimeEvents, events);
});
test("a late event-history save cannot resurrect a recovered source", async t => {
  const f = await fixture(t);
  const checked = beforeHistoryCommit(t, async () => {
    await f.other.begin({ sessionId: "resumed", task: "confirmed recovery", providerId: "offline", model: "offline", resumedFrom: f.run.runId });
    await f.other.complete("completed");
  });
  await f.journal.saveRuntimeEvents(f.run.runId, events); checked();
  assert.equal((await f.other.read(f.run.runId))?.status, "abandoned");
  assert.equal(await f.other.interrupted(), undefined);
});
test("a late event-history save cannot recreate a deleted run", async t => {
  const f = await fixture(t);
  const checked = beforeHistoryCommit(t, async () => { assert.equal(await f.other.delete(f.run.runId), true); });
  await f.journal.saveRuntimeEvents(f.run.runId, events); checked();
  await assert.rejects(fs.access(f.file));
  assert.equal(await f.other.read(f.run.runId), undefined);
  assert.deepEqual((await f.other.scan()).records, []);
});
test("event history cannot be saved as final history while the run is active", async t => {
  const f = await fixture(t, false), before = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.journal.saveRuntimeEvents(f.run.runId, events), /paused|finished|active/i);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  await f.journal.complete("completed");
});
test("optional event-history IO failure does not poison execution-state persistence", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  const checked = beforeHistoryCommit(t, async () => { throw Object.assign(new Error("private fixture failure"), { code: "EIO" }); });
  await assert.rejects(f.journal.saveRuntimeEvents(f.run.runId, events), error => (error as { storageCode?: string }).storageCode === "EIO" || (error as NodeJS.ErrnoException).code === "EIO"); checked();
  assert.equal(f.journal.persistenceFailure(), undefined);
  assert.equal((await f.journal.read(f.run.runId))?.runtimeEventsUnavailable, true);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  await f.journal.abandon(f.run.runId);
  await f.journal.begin({ sessionId: "new", task: "explicit new task", providerId: "offline", model: "offline" });
  await f.journal.beginOperation({ kind: "tool", name: "read", sideEffect: "none" });
  await f.journal.complete("completed");
});

test("new event history leaves legacy inline events and core bytes unchanged", async t => {
  const f = await fixture(t), record = JSON.parse(await fs.readFile(f.file, "utf8"));
  record.runtimeEvents = [{ ...events[0], eventId: "legacy-event" }];
  const before = JSON.stringify(record) + "\n"; await fs.writeFile(f.file, before);
  assert.equal((await f.other.read(f.run.runId))?.runtimeEvents?.[0]?.eventId, "legacy-event");
  await f.journal.saveRuntimeEvents(f.run.runId, events);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.deepEqual((await f.other.read(f.run.runId))?.runtimeEvents, events);
});
for (const [label, override] of [
  ["future version", { version: 2 }], ["different run", { runId: "other" }], ["different workspace", { workspaceId: "other" }],
  ["invalid events", { events: {} }], ["invalid sequence", { events: [{ ...events[0], sequence: -1 }] }],
  ["invalid event envelope", { events: [{ ...events[0], payload: null }] }],
] as const) {
  test(`${label} event history degrades display without hiding recovery or changing core`, async t => {
    const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
    await fs.writeFile(path.join(f.directory, `${f.run.runId}.events`), JSON.stringify(Object.assign({ version: 1, runId: f.run.runId, workspaceId: f.journal.workspaceId, events }, override)));
    const view = await f.other.read(f.run.runId);
    assert.equal(view?.status, "paused"); assert.equal(view?.runtimeEventsUnavailable, true); assert.equal(view?.runtimeEvents, undefined);
    assert.equal((await f.other.scan()).records.length, 1); assert.deepEqual((await f.other.scan()).unreadable, []);
    const recovery = await f.other.interrupted();
    assert.equal(recovery?.runId, f.run.runId); assert.equal(recovery?.pendingSideEffects.length, 1);
    assert.equal(recovery?.runtimeEventsUnavailable, undefined);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    await f.other.begin({ sessionId: "recovered", task: "confirmed recovery", providerId: "offline", model: "offline", resumedFrom: f.run.runId });
    await f.other.complete("completed");
    assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).runtimeEventsUnavailable, undefined);
  });
}
test("a directory in place of event history is not followed or deleted with its core record", async t => {
  const f = await fixture(t), history = path.join(f.directory, `${f.run.runId}.events`), before = await fs.readFile(f.file, "utf8");
  await fs.mkdir(history); await fs.writeFile(path.join(history, "keep"), "private fixture");
  assert.equal((await f.other.read(f.run.runId))?.runtimeEventsUnavailable, true);
  await assert.rejects(f.other.delete(f.run.runId), /unsafe/i);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.equal(await fs.readFile(path.join(history, "keep"), "utf8"), "private fixture");
});
test("event history deletion removes only the exact associated display file", async t => {
  const f = await fixture(t), history = path.join(f.directory, `${f.run.runId}.events`), keep = path.join(f.root, "keep.txt");
  await fs.writeFile(keep, "keep"); await f.journal.saveRuntimeEvents(f.run.runId, events);
  assert.equal(await f.other.delete(f.run.runId), true);
  await assert.rejects(fs.access(history)); await assert.rejects(fs.access(f.file));
  assert.equal(await fs.readFile(keep, "utf8"), "keep");
});
test("display metadata IO errors stay out of recovery and never expose raw failure text", async t => {
  const f = await fixture(t), history = path.join(f.directory, `${f.run.runId}.events`), open = fs.open;
  await f.journal.saveRuntimeEvents(f.run.runId, events);
  t.mock.method(fs, "open", async (target: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1]) => {
    if (target === history) throw Object.assign(new Error("private-path-and-secret-canary"), { code: "EACCES" });
    return open(target, flags);
  });
  const view = await f.other.read(f.run.runId);
  assert.equal(view?.runtimeEventsUnavailable, true);
  assert.doesNotMatch(JSON.stringify(view), /private-path-and-secret-canary/);
  assert.equal((await f.other.interrupted())?.pendingSideEffects.length, 1);
  assert.equal(f.other.persistenceFailure(), undefined);
});
test("event history remains bounded to the most recent 1000 events without mutating caller input", async t => {
  const f = await fixture(t), input = Array.from({ length: 1001 }, (_, sequence) => ({ ...events[0], eventId: String(sequence), sequence })) as RuntimeEvent[];
  await f.journal.saveRuntimeEvents(f.run.runId, input);
  const saved = (await f.other.read(f.run.runId))!.runtimeEvents!;
  assert.equal(saved.length, 1000); assert.equal(saved[0]?.eventId, "1"); assert.equal(saved.at(-1)?.eventId, "1000");
  assert.equal(input.length, 1001); assert.equal(input[0]?.eventId, "0");
});
test("oversized display files are not read and oversized saves leave core unchanged", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8"), history = path.join(f.directory, `${f.run.runId}.events`);
  const handle = await fs.open(history, "wx"); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  assert.equal((await f.other.read(f.run.runId))?.runtimeEventsUnavailable, true);
  assert.equal((await f.other.interrupted())?.runId, f.run.runId);
  await assert.rejects(f.journal.saveRuntimeEvents(f.run.runId, [{ ...events[0], type: "assistant.message", payload: { text: "x".repeat(16 * 1024 * 1024), hasToolCalls: false } }]), /history/i);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  assert.equal(f.journal.persistenceFailure(), undefined);
});


test("a later successful metadata save clears the current-host failure notice without changing core", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  beforeHistoryCommit(t, async () => { throw Object.assign(new Error("private fixture failure"), { code: "EIO" }); });
  await assert.rejects(f.journal.saveRuntimeEvents(f.run.runId, events), error => {
    assert.doesNotMatch((error as Error).message, /private fixture failure/);
    return true;
  });
  assert.equal((await f.journal.read(f.run.runId))?.runtimeEventsUnavailable, true);
  await f.journal.saveRuntimeEvents(f.run.runId, events);
  assert.equal((await f.journal.read(f.run.runId))?.runtimeEventsUnavailable, undefined);
  assert.deepEqual((await f.journal.read(f.run.runId))?.runtimeEvents, events);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("display files cannot replace execution, recovery, or acceptance authority", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  await fs.writeFile(path.join(f.directory, `${f.run.runId}.events`), JSON.stringify({ version: 1, runId: f.run.runId, workspaceId: f.journal.workspaceId, events,
    status: "completed", ownerPid: 0, operations: [], approvalMode: "full", planMode: false, manualAcceptance: { decision: "passed" } }));
  const view = await f.other.read(f.run.runId);
  assert.equal(view?.status, "paused"); assert.equal(view?.manualAcceptance, undefined); assert.equal(view?.operations[0]?.status, "unknown");
  assert.deepEqual(view?.runtimeEvents, events);
  assert.equal((await f.other.interrupted())?.pendingSideEffects.length, 1);
  await assert.rejects(f.other.begin({ sessionId: "new", task: "must not start", providerId: "offline", model: "offline" }), /decision/);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});
test("human result metadata never copies display overlays into authoritative records", async t => {
  const f = await fixture(t), record = JSON.parse(await fs.readFile(f.file, "utf8"));
  record.status = "completed";
  record.operations.push({ id: "computer", kind: "tool", name: "computer_input", status: "succeeded", sideEffect: "external", replay: "forbidden", startedAt: record.startedAt });
  await fs.writeFile(f.file, JSON.stringify(record) + "\n");
  await f.journal.saveRuntimeEvents(f.run.runId, events);
  await f.other.recordComputerAcceptance(f.run.runId, "passed", true);
  const stored = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(stored.status, "completed"); assert.equal(stored.runtimeEvents, undefined); assert.equal(stored.runtimeEventsUnavailable, undefined);
  assert.equal(stored.manualAcceptance.decision, "passed");
  assert.deepEqual((await f.other.read(f.run.runId))?.runtimeEvents, events);
});
