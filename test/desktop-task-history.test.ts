import assert from "node:assert/strict";
import test from "node:test";
import { assertTaskHistoryRequest, buildTaskHistorySnapshot, reviewOperation, type TaskHistoryIo, type TaskHistorySession } from "../apps/desktop/main/task-history.js";
import type { RuntimeEvent } from "../src/runtime/protocol.js";
import type { TaskChangeReport } from "../src/task-changes.js";
import type { TaskRunOperation, TaskRunRecord } from "../src/task-run.js";

const workspace = "/workspace/demo";

function run(overrides: Partial<TaskRunRecord> & Pick<TaskRunRecord, "runId" | "sessionId" | "startedAt">): TaskRunRecord {
  return {
    version: 1, workspaceId: "ws", taskPreview: "task", providerId: "p", model: "m", status: "completed",
    updatedAt: overrides.startedAt, finishedAt: overrides.startedAt, ownerPid: 1, ownerInstance: "i",
    operations: [], recoveryPoints: [], events: [], ...overrides,
  };
}

function session(overrides: Partial<TaskHistorySession> & Pick<TaskHistorySession, "id">): TaskHistorySession {
  return { updatedAt: "2026-10-20T10:00:00.000Z", messages: [], replay: [], ...overrides };
}

function io(sessions: Record<string, TaskHistorySession>, reports: Record<string, TaskChangeReport> = {}): TaskHistoryIo & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    loaded,
    loadSession: async (cwd, id) => { loaded.push(id); assert.equal(cwd, workspace); const found = sessions[id]; if (!found) throw new Error(`no session ${id}`); return found; },
    loadTaskChangeHistory: async (_cwd, runId) => reports[runId],
  };
}

const event = (taskId: string, sequence: number, type: "task.started" | "assistant.message"): RuntimeEvent => ({
  schemaVersion: 1, eventId: `${taskId}-${sequence}`, taskId, sequence, timestamp: "2026-10-20T09:00:00.000Z", type,
  payload: type === "task.started" ? { taskPreview: "task" } : { text: "done", hasToolCalls: false },
} as RuntimeEvent);

test("history requests reject anything but a plain task ID before any file is read", async () => {
  for (const bad of [undefined, {}, { taskId: 42 }, { taskId: "" }, { taskId: "../escape" }, { taskId: "a".repeat(161) }]) {
    assert.throws(() => assertTaskHistoryRequest(bad as never), /Invalid task history request/);
  }
  let recent = 0;
  const fake = io({});
  await assert.rejects(() => buildTaskHistorySnapshot(workspace, { taskId: "..\\escape" }, { recent: async () => { recent++; return []; } }, fake), /Invalid task history request/);
  assert.equal(recent, 0);
  assert.deepEqual(fake.loaded, []);
});

test("a run ID resolves to its whole conversation and exact event streams are renumbered per run", async () => {
  const report = { files: [{ path: "a.ts", status: "modified" }] } as unknown as TaskChangeReport;
  const runs = [
    run({ runId: "run-2", sessionId: "s-1", startedAt: "2026-10-20T09:10:00.000Z", runtimeEvents: [event("live-9", 7, "task.started"), event("live-9", 8, "assistant.message")] }),
    run({ runId: "run-1", sessionId: "s-1", startedAt: "2026-10-20T09:00:00.000Z", runtimeEvents: [event("live-3", 1, "task.started")], providerId: "p1", model: "m1" }),
    run({ runId: "other", sessionId: "s-2", startedAt: "2026-10-20T09:05:00.000Z", runtimeEvents: [event("x", 1, "task.started")] }),
  ];
  const fake = io({ "s-1": session({ id: "s-1", replay: [{ task: "first task", supplements: [], receipts: [], changes: [], exact: true, response: "ok" }] }) }, { "run-1": report });
  const history = await buildTaskHistorySnapshot(workspace, { taskId: "run-1" }, { recent: async (limit) => { assert.equal(limit, 500); return runs; } }, fake);
  assert.deepEqual(fake.loaded, ["s-1"]);
  assert.equal(history.taskId, "s-1");
  assert.equal(history.title, "first task");
  assert.equal(history.status, "completed");
  assert.equal(history.fidelity, "exact");
  assert.deepEqual(history.events.map((item) => [item.taskId, item.sequence]), [["run-1", 1], ["run-2", 2], ["run-2", 3]]);
  assert.deepEqual(history.changeRounds?.map((round) => [round.id, Boolean(round.report)]), [["run-1", true], ["run-2", false]]);
  assert.equal(history.changes, report, "the newest round with a saved report is shown");
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.title]), [["user", "你"], ["assistant", "Xiu"]]);
});

test("a session without journal runs keeps attributable messages and invents no execution evidence", async () => {
  const fake = io({ "s-legacy": session({ id: "s-legacy", providerId: "legacy-p", model: "legacy-m", replay: [
    { task: "rename things token=abc123def456ghi789", supplements: ["also tests"], receipts: ["ran lint"], changes: [], exact: false, response: "renamed", completion: { message: "all good", success: true } },
  ] }) });
  const history = await buildTaskHistorySnapshot(workspace, { taskId: "s-legacy" }, { recent: async () => [] }, fake);
  assert.equal(history.status, "session");
  assert.equal(history.fidelity, "reconstructed");
  assert.equal(history.providerId, "legacy-p");
  assert.equal(history.model, "legacy-m");
  assert.deepEqual(history.events.map((item) => item.type), ["task.started", "task.steered", "assistant.message"]);
  assert.ok(history.events.every((item) => item.taskId === "s-legacy-round-1"));
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["user", "user", "activity", "assistant", "completion"]);
  assert.deepEqual(history.changeRounds, []);
  assert.equal(history.changes, undefined);
  assert.doesNotMatch(JSON.stringify(history), /abc123def456ghi789/);
});

test("review operations carry duration and bounded, redacted evidence", () => {
  const operation: TaskRunOperation = {
    id: "op-1", kind: "tool", name: "run_command", sideEffect: "process", replay: "verify-first", status: "succeeded", risk: "execute",
    startedAt: "2026-10-20T09:00:00.000Z", finishedAt: "2026-10-20T09:00:02.500Z", evidence: `api_key=sk-${"a".repeat(40)} ${"x".repeat(3_000)}`,
  };
  const shown = reviewOperation(operation, "command");
  assert.equal(shown.kind, "command");
  assert.equal(shown.durationMs, 2_500);
  assert.equal(shown.risk, "execute");
  assert.equal(shown.evidence?.length, 2_000);
  assert.doesNotMatch(shown.evidence ?? "", /a{40}/);
  const open = reviewOperation({ ...operation, finishedAt: undefined, evidence: undefined, risk: undefined }, "verification");
  assert.equal(open.kind, "verification");
  assert.equal("durationMs" in open, false);
  assert.equal("finishedAt" in open, false);
  assert.equal("risk" in open, false);
  assert.equal("evidence" in open, false);
});
