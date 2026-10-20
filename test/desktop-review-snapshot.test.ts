import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertChangeView, buildReviewSnapshot, currentGitBranch, type ReviewSnapshotHost, type ReviewSnapshotIo, type ReviewSnapshotState } from "../apps/desktop/main/review-snapshot.js";
import type { Checkpoint } from "../src/checkpoint.js";
import type { TaskChangeReport, TaskChangeSnapshot } from "../src/task-changes.js";
import type { InterruptedTaskRun, TaskRunOperation, TaskRunRecord } from "../src/task-run.js";

const workspace = "/workspace/demo";
const baseline = { capturedAt: "2026-10-20T09:00:00.000Z" } as unknown as TaskChangeSnapshot;

function report(view: TaskChangeReport["view"], changes: Array<{ path: string; kind: string }> = []): TaskChangeReport {
  return { view, git: true, changes: changes as TaskChangeReport["changes"], preExisting: [], complete: true, warnings: ["existing"] };
}

function operation(kind: TaskRunOperation["kind"], name: string, startedAt: string): TaskRunOperation {
  return { id: `${name}-${startedAt}`, kind, name, sideEffect: "none", replay: "forbidden", status: "succeeded", startedAt };
}

function run(overrides: Partial<TaskRunRecord> & Pick<TaskRunRecord, "runId" | "sessionId" | "startedAt">): TaskRunRecord {
  return {
    version: 1, workspaceId: "ws", taskPreview: "task", providerId: "p", model: "m", status: "completed", updatedAt: overrides.startedAt,
    ownerPid: 1, ownerInstance: "i", operations: [], recoveryPoints: [], events: [], ...overrides,
  };
}

interface HostOptions { taskId?: string; current?: TaskRunRecord; latest?: TaskRunRecord; recent?: TaskRunRecord[]; interrupted?: InterruptedTaskRun; checkpoints?: Checkpoint[]; background?: NonNullable<ReviewSnapshotHost["background"]> }

function host(options: HostOptions = {}): ReviewSnapshotHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runtime: { snapshot: () => ({ task: options.taskId ? { id: options.taskId } : undefined }) } as unknown as ReviewSnapshotHost["runtime"],
    journal: {
      currentRun: () => { calls.push("currentRun"); return options.current; },
      latest: async () => { calls.push("latest"); return options.latest; },
      interrupted: async () => { calls.push("interrupted"); return options.interrupted; },
      recent: async () => { calls.push("recent"); return options.recent ?? []; },
    },
    ...(options.checkpoints ? { checkpointManager: { list: async () => options.checkpoints! } } : {}),
    ...(options.background ? { background: options.background } : {}),
  };
}

function state(overrides: Partial<ReviewSnapshotState> = {}): ReviewSnapshotState {
  return { baseline: () => undefined, completedTaskChanges: () => undefined, active: () => false, ...overrides };
}

function io(reports: Partial<Record<string, TaskChangeReport>> = {}): ReviewSnapshotIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    inspectTaskChanges: async (cwd, snapshot) => { calls.push(`inspect:${snapshot === baseline ? "baseline" : "other"}`); assert.equal(cwd, workspace); return report("task", [{ path: "src/a.ts", kind: "modified" }, { path: "src/b.ts", kind: "deleted" }, { path: "src/c.ts", kind: "created" }]); },
    getWorkspaceDiff: async (_cwd, view = "workspace") => { calls.push(`diff:${view}`); return report(view); },
    listReviewFiles: async () => { calls.push("files"); return [{ path: "src/a.ts", size: 1, kind: "text" } as never]; },
    loadTaskChangeHistory: async (_cwd, runId) => reports[runId],
    currentBranch: async () => { calls.push("branch"); return "feature/x"; },
  };
}

test("an unknown change view is rejected before the host is read", async () => {
  for (const bad of ["", "diff", undefined, 1]) assert.throws(() => assertChangeView(bad as never), /Invalid change view/);
  const fake = host();
  await assert.rejects(() => buildReviewSnapshot(workspace, "all" as never, fake, state(), io()), /Invalid change view/);
  assert.deepEqual(fake.calls, []);
});

test("the task view inspects the in-memory baseline and lists commands, tools and rounds from the journal", async () => {
  const operations = [
    operation("model", "model", "2026-10-20T09:00:00.000Z"),
    operation("tool", "write_file", "2026-10-20T09:00:01.000Z"),
    operation("tool", "run_command", "2026-10-20T09:00:02.000Z"),
    operation("verification", "npm test", "2026-10-20T09:00:03.000Z"),
    operation("tool", "run_process", "2026-10-20T09:00:04.000Z"),
  ];
  const latest = run({ runId: "run-2", sessionId: "s-1", startedAt: "2026-10-20T09:00:00.000Z", status: "running", operations, manualAcceptance: { decision: "passed", at: "2026-10-20T09:01:00.000Z", scope: "computer-result" } });
  const recent = [latest, run({ runId: "run-1", sessionId: "s-1", startedAt: "2026-10-20T08:00:00.000Z" }), run({ runId: "elsewhere", sessionId: "s-2", startedAt: "2026-10-20T08:30:00.000Z" })];
  const fakeHost = host({ taskId: "t-1", current: latest, recent });
  const fakeIo = io({ "run-1": report("task") });
  const snapshot = await buildReviewSnapshot(workspace, "task", fakeHost, state({ baseline: () => baseline }), fakeIo);
  assert.deepEqual(fakeIo.calls.filter((call) => call.startsWith("inspect") || call.startsWith("diff")), ["inspect:baseline"]);
  assert.equal(snapshot.changeView, "task");
  assert.deepEqual(snapshot.changes.warnings, ["existing"], "a baseline-backed view adds no warning");
  assert.equal(snapshot.overview?.taskChanges, snapshot.changes);
  assert.equal(snapshot.overview?.branch, "feature/x");
  assert.equal(snapshot.overview?.taskId, "t-1");
  assert.deepEqual(snapshot.artifacts, [{ path: "src/a.ts", kind: "modified" }, { path: "src/c.ts", kind: "created" }]);
  assert.deepEqual(snapshot.commands.map((item) => item.name), ["run_process", "run_command"]);
  assert.deepEqual(snapshot.tools?.map((item) => item.name), ["run_process", "run_command", "write_file"]);
  assert.deepEqual(snapshot.validations.map((item) => item.name), ["npm test"]);
  assert.deepEqual(snapshot.run, { id: "run-2", status: "running", startedAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T09:00:00.000Z" });
  assert.deepEqual(snapshot.manualAcceptance, { eligible: true, decision: "passed", at: "2026-10-20T09:01:00.000Z", scope: "computer-result" });
  assert.deepEqual(snapshot.changeRounds?.map((round) => [round.id, Boolean(round.report)]), [["run-1", true], ["run-2", false]]);
  assert.deepEqual(snapshot.checkpoints, []);
  assert.deepEqual(snapshot.background, []);
  assert.equal(snapshot.recovery, undefined);
});

test("without a baseline the task view falls back to the workspace diff with a warning, and other views never warn", async () => {
  const fakeIo = io();
  const fallback = await buildReviewSnapshot(workspace, "task", host({ taskId: "t-1" }), state(), fakeIo);
  assert.deepEqual(fakeIo.calls.filter((call) => call.startsWith("diff")), ["diff:workspace"]);
  assert.deepEqual(fallback.changes.warnings, ["no-task-baseline: no in-memory baseline is available; showing current workspace changes.", "existing"]);
  assert.equal(fallback.overview?.taskChanges, undefined);
  assert.equal(fallback.run, undefined);
  assert.deepEqual(fallback.artifacts, []);
  const completed = report("task", [{ path: "done.ts", kind: "created" }]);
  const staged = await buildReviewSnapshot(workspace, "staged", host({ taskId: "t-1" }), state({ completedTaskChanges: () => ({ taskId: "t-1", report: completed }) }), fakeIo);
  assert.equal(staged.changes.view, "staged");
  assert.deepEqual(staged.changes.warnings, ["existing"]);
  assert.equal(staged.overview?.taskChanges, completed, "the finished task's report still feeds the overview");
  assert.deepEqual(staged.artifacts, [{ path: "done.ts", kind: "created" }]);
  const other = await buildReviewSnapshot(workspace, "task", host({ taskId: "t-2" }), state({ completedTaskChanges: () => ({ taskId: "t-1", report: completed }) }), fakeIo);
  assert.match(other.changes.warnings[0] ?? "", /no-task-baseline/, "another task's report is not reused");
});

test("a finished task's saved report is served as a copy, and recovery evidence appears only while idle", async () => {
  const completed = report("task", [{ path: "done.ts", kind: "modified" }]);
  const interrupted: InterruptedTaskRun = {
    ...run({ runId: "run-x", sessionId: "s-1", startedAt: "2026-10-20T07:00:00.000Z", status: "paused" }),
    interruptedOperations: [operation("verification", "npm test", "2026-10-20T07:00:01.000Z"), operation("tool", "run_command", "2026-10-20T07:00:02.000Z")],
    pendingSideEffects: [], recommendation: "verify first",
    recoveryPoints: [{ at: "2026-10-20T07:00:00.500Z", kind: "checkpoint", evidence: "cp-1" }, { at: "2026-10-20T07:00:01.500Z", kind: "checkpoint", evidence: "cp-2" }] as InterruptedTaskRun["recoveryPoints"],
  };
  const checkpoints = Array.from({ length: 85 }, (_, index) => ({ id: `cp-${index}`, createdAt: "2026-10-20T07:00:00.000Z", tool: "write_file", description: "d", files: [] }));
  const background = () => [{ id: "bg-1", command: `curl -H "Authorization: Bearer ${"x".repeat(40)}" ${"y".repeat(300)}`, state: "running" as const, running: true, elapsedMs: 1, outputBytes: 0 }];
  const shared = { taskId: "t-1", interrupted, checkpoints, background };
  const idle = await buildReviewSnapshot(workspace, "task", host(shared), state({ completedTaskChanges: () => ({ taskId: "t-1", report: completed }) }), io());
  assert.deepEqual(idle.changes, completed);
  assert.notEqual(idle.changes, completed, "the renderer gets a copy of the stored report");
  assert.deepEqual(idle.changes.warnings, ["existing"]);
  assert.equal(idle.recovery?.status, "paused");
  assert.deepEqual(idle.recovery?.unknownOperations.map((item) => item.kind), ["verification", "command"]);
  assert.deepEqual(idle.recovery?.lastRecoveryPoint, { at: "2026-10-20T07:00:01.500Z", kind: "checkpoint", evidence: "cp-2" });
  assert.equal(idle.checkpoints.length, 80);
  assert.notEqual(idle.checkpoints[0], checkpoints[0]);
  assert.equal(idle.background?.[0]?.command.length, 240);
  assert.doesNotMatch(idle.background?.[0]?.command ?? "", /x{40}/);
  const busy = host(shared);
  const active = await buildReviewSnapshot(workspace, "task", busy, state({ active: () => true, completedTaskChanges: () => ({ taskId: "t-1", report: completed }) }), io());
  assert.equal(active.recovery, undefined);
  assert.ok(!busy.calls.includes("interrupted"), "a busy workspace never reads the interrupted journal");
});

test("the current Git branch is read from the workspace and is absent outside a branch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-review-branch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await currentGitBranch(root), undefined);
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
  await git("init", "-q", "-b", "review/branch-name");
  assert.equal(await currentGitBranch(root), "review/branch-name");
  await git("checkout", "-q", "--orphan", "detached-less");
  assert.equal(await currentGitBranch(root), "detached-less");
});
