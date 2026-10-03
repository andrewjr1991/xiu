import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { CheckpointManager } from "../src/checkpoint.js";
import type { WorkspaceAgentHost } from "../src/runtime/workspace-agent-host.js";
import { TaskRunJournal } from "../src/task-run.js";
import { MultiAgentCoordinator } from "../src/multi-agent.js";
import { loadTaskChangeHistory, saveTaskChangeHistory } from "../src/task-change-history.js";
import type { TaskChangeReport } from "../src/task-changes.js";
import { XiuRuntime, type RuntimeTaskDriver } from "../src/runtime/xiu-runtime.js";
import type { WorkspaceManagementService } from "../src/runtime/workspace-management.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

class FakeDriver implements RuntimeTaskDriver {
  planMode = false;
  setPlanMode(enabled: boolean): void { this.planMode = enabled; }
  outcome: ReturnType<RuntimeTaskDriver["status"]>["outcome"] = "idle";
  result = deferred<string>();
  steering: string[] = [];
  run(): Promise<string> { this.outcome = "running"; return this.result.promise; }
  cancel(): boolean { this.outcome = "cancelled"; this.result.reject(new Error("cancelled")); return true; }
  steer(text: string): boolean { this.steering.push(text); return true; }
  status() { return { outcome: this.outcome, planMode: this.planMode }; }
}

function historicalReport(file: string, line: string): TaskChangeReport {
  return { view: "task", git: false, complete: true, preExisting: [], warnings: [], changes: [{
    path: file, kind: "created", source: "unknown", preExisting: false, staged: false,
    preview: `@@ -0,0 +1,1 @@ (preview)\n+ ${line}`, limitations: [],
  }] };
}

test("desktop cancellation binds current parent and child, requires confirmation, and respects Plan", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-child-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new XiuRuntime();
  const driver = new FakeDriver(); runtime.attachDriver(driver);
  const entered = deferred<void>();
  const coordinator = new MultiAgentCoordinator(root, async (_task, context) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return { result: "unused", stats: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, activeMs: 0 } };
  }, { onTaskUpdate: (run, child) => runtime.recordSubagent({ id: `${run.id}:${child.id}`, runId: run.id, taskId: child.id, title: child.title, role: child.role, status: child.status }) });
  await coordinator.initialize();
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime, coordinator, journal: new TaskRunJournal(root, path.join(root, "journals")), provider: { id: "p", label: "p", model: "m" } }));
  await controller.connect(root);
  const running = runtime.createTask("parent task");
  const run = await coordinator.start("fixture", [{ id: "reviewer", title: "Review", instructions: "fixture", role: "reviewer" }]);
  await entered.promise;
  const request = { runId: run.id, taskId: "reviewer", parentTaskId: runtime.snapshot().task!.id };
  let confirmations = 0;
  const confirm = async () => { confirmations++; return true; };
  await assert.rejects(controller.cancelSubagent(root, { ...request, parentTaskId: "old-parent" }, confirm), /不属于/);
  await assert.rejects(controller.cancelSubagent(root, { ...request, taskId: "foreign" }, confirm), /不属于/);
  assert.equal(confirmations, 0);
  await controller.cancelSubagent(root, request, async () => false);
  assert.equal(coordinator.get(run.id).tasks[0]!.status, "running");
  driver.planMode = true;
  await assert.rejects(controller.cancelSubagent(root, request, confirm), /Plan/);
  driver.planMode = false;
  await assert.rejects(controller.cancelSubagent(root, request, async () => { driver.planMode = true; return true; }), /已经变化/);
  assert.equal(coordinator.get(run.id).tasks[0]!.status, "running");
  driver.planMode = false;
  await controller.cancelSubagent(root, request, confirm);
  assert.equal(confirmations, 1);
  assert.equal(coordinator.get(run.id).tasks[0]!.status, "cancelled");
  await assert.rejects(controller.cancelSubagent(root, request, confirm), /已结束/);
  await coordinator.shutdown();
  driver.outcome = "completed"; driver.result.resolve("done"); await running;
});

test("an idle controller identifies its own unfinished journal lock rather than another window", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-own-journal-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new TaskRunJournal(root, path.join(root, "journals"));
  await journal.begin({ sessionId: "unfinished", task: "fixture", providerId: "p", model: "m" });
  const runtime = new XiuRuntime();
  const driver = new FakeDriver();
  runtime.attachDriver(driver);
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime, journal, provider: { id: "p", label: "p", model: "m" } }));
  const connection = await controller.connect(root);
  assert.equal(connection.writer, "recovery-required");
  assert.match(connection.journalWarning!, /本窗口/);
  assert.equal((await journal.lockStatus()).active, true);
  const running = runtime.createTask("fixture active task");
  assert.equal((await controller.reviewSnapshot(root)).recovery, undefined);
  driver.outcome = "completed"; driver.result.resolve("done");
  await running;
});

test("desktop management reload revokes Full Access and preserves Plan; active tasks cannot mutate", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-management-controller-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let changed = 0;
  let driver: FakeDriver;
  const controller = new DesktopTaskController(() => undefined, async () => {
    const runtime = new XiuRuntime();
    driver = new FakeDriver(); runtime.attachDriver(driver);
    return { runtime, provider: { id: "test", label: "Test", model: "test-model" }, journal: new TaskRunJournal(workspace, path.join(workspace, "journals")),
      setApprovalMode() {}, management: { change: async () => { changed++; } } as unknown as WorkspaceManagementService };
  });
  const initial = await controller.connect(workspace);
  const planned = await controller.setPlanMode(workspace, { enabled: true, contextId: initial.modeContextId });
  await controller.setApprovalMode(workspace, { mode: "full", contextId: planned.modeContextId }, async () => true);
  const reloaded = await controller.changeManagement(workspace, { action: "routing", revision: "fixture", enabled: true });
  assert.equal(changed, 1);
  assert.equal(reloaded.approvalMode, "ask");
  assert.equal(reloaded.runtime.snapshot.planMode, true);
  assert.notEqual(reloaded.modeContextId, planned.modeContextId);
  await controller.createTask(workspace, "fixture running task");
  await assert.rejects(controller.changeManagement(workspace, { action: "routing", revision: "fixture", enabled: false }));
  assert.equal(changed, 1);
  driver!.outcome = "completed"; driver!.result.resolve("done");
});

test("desktop empty-provider runtime opens but cannot create, continue or recover tasks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-no-provider-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new XiuRuntime();
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime, providerConfigured: false,
    provider: { id: "unconfigured", label: "未配置渠道", model: "unconfigured" }, journal: new TaskRunJournal(root, path.join(root, "journals")),
  }));
  assert.equal((await controller.connect(root, 0)).runtime.snapshot.task, undefined);
  await assert.rejects(controller.createTask(root, "must not start"), /尚未配置渠道/);
  await assert.rejects(controller.continueTask(root, "old-task", "must not restore"), /尚未配置渠道/);
  await assert.rejects(controller.recoverTask(root, { runId: "old-run" }, true), /尚未配置渠道/);
  assert.equal((await controller.connect(root, 0)).runtime.snapshot.task, undefined);
});

test("desktop task controller owns one workspace runtime and forwards versioned events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-task-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const journals = path.join(root, "journals");
  await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const drivers = new Map<string, FakeDriver>();
  const factory = async (workspace: string): Promise<WorkspaceAgentHost> => {
    const runtime = new XiuRuntime();
    const driver = new FakeDriver();
    drivers.set(workspace, driver);
    runtime.attachDriver(driver);
    return { runtime, provider: { id: "test", label: "Test", model: "test-model" }, journal: new TaskRunJournal(workspace, journals) };
  };
  const seen: string[] = [];
  const controller = new DesktopTaskController((event) => seen.push(event.type), factory);
  const started = await controller.createTask(first, "implement G3");
  assert.equal(started.runtime.snapshot.task?.state, "running");
  assert.equal(started.provider.model, "test-model");
  assert.deepEqual(seen, ["task.started"]);
  await assert.rejects(() => controller.assertCanReconfigure(first), /任务运行期间/);
  await assert.rejects(() => controller.assertCanUseTerminal(first), /任务运行期间/);
  assert.equal(await controller.steerTask(first, "add tests"), true);
  assert.throws(() => controller.detach(), /still running|仍在运行/);
  await assert.rejects(() => controller.connect(second, 0), /still running|仍在运行/);
  assert.equal(await controller.stopTask(first), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await controller.connect(first, 0)).runtime.snapshot.task?.state, "cancelled");
  controller.detach();
  assert.equal((await controller.connect(second, 0)).runtime.snapshot.task, undefined);
});

test("desktop task controller blocks Provider reconfiguration while another writer owns the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-provider-lock-"));
  const workspace = path.join(root, "workspace");
  const journals = path.join(root, "journals");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const external = new TaskRunJournal(workspace, journals);
  await external.begin({ sessionId: "external", task: "external task", providerId: "p", model: "m" });
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime,
    provider: { id: "test", label: "Test", model: "test-model" },
    journal: new TaskRunJournal(workspace, journals),
  }));

  await assert.rejects(() => controller.assertCanReconfigure(workspace), /另一个 Xiu 进程/);
  await assert.rejects(() => controller.assertCanUseTerminal(workspace), /另一个 Xiu 进程/);
  await external.complete("cancelled");
  await controller.assertCanReconfigure(workspace);
});

test("desktop checkpoint restore requires main-process confirmation and preserves a safety checkpoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-restore-"));
  const workspace = path.join(root, "workspace");
  const journals = path.join(root, "journals");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "note.txt"), "before\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkpointManager = new CheckpointManager(workspace, "desktop-session");
  const checkpoint = await checkpointManager.capture("write_file", { path: "note.txt" }, "before edit");
  assert.ok(checkpoint);
  await fs.writeFile(path.join(workspace, "note.txt"), "after\n");
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime, provider: { id: "test", label: "Test", model: "test-model" },
    journal: new TaskRunJournal(workspace, journals), checkpointManager,
  }));
  await assert.rejects(() => controller.restoreCheckpoint(workspace, { checkpointId: checkpoint.id }, false), /主进程确认/);
  const review = await controller.restoreCheckpoint(workspace, { checkpointId: checkpoint.id }, true);
  assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), "before\n");
  assert.ok(review.checkpoints.length >= 2, "restoring creates a fresh safety checkpoint first");
});

test("desktop task history opens a bounded, redacted resumable transcript", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-history-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  const journals = path.join(root, "journals");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-1.jsonl"), [
    JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00.000Z", task: "创建页面 api_key=secret-value" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-29T01:00:01.000Z", text: "已完成 Bearer abcdefghijklmnopqrstuvwxyz", toolCalls: [] }),
  ].join("\n") + "\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime, provider: { id: "test", label: "Test", model: "test-model" },
    journal: new TaskRunJournal(workspace, journals),
  }));
  const history = await controller.openTaskHistory(workspace, { taskId: "session-1" });
  assert.equal(history.taskId, "session-1");
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["user", "assistant"]);
  assert.doesNotMatch(JSON.stringify(history), /secret-value|abcdefghijklmnopqrstuvwxyz/);
  assert.match(JSON.stringify(history), /REDACTED/);
  assert.equal(history.fidelity, "reconstructed");
  assert.equal(history.changes, undefined, "old sessions remain readable without inventing a current-workspace diff");
  await assert.rejects(() => controller.openTaskHistory(workspace, { taskId: "..\\escape" }), /Invalid task history/);
});

test("legacy web history keeps result evidence out of the action description", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-web-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-web.jsonl"), `${JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00.000Z", task: "搜索新闻" })}\n`);
  const journal = new TaskRunJournal(workspace, path.join(root, "journals"));
  const run = await journal.begin({ sessionId: "session-web", task: "搜索新闻", providerId: "test", model: "model" });
  const operation = await journal.beginOperation({ kind: "tool", name: "web_search", risk: "read", sideEffect: "none" });
  const evidence = "UNTRUSTED WEB CONTENT: external evidence\nSearch query: news\nResults (10):";
  await journal.finishOperation(operation, "succeeded", evidence);
  await journal.complete("completed");
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime, provider: { id: "test", label: "Test", model: "model" }, journal }));
  const history = await controller.openTaskHistory(workspace, { taskId: run.runId });
  const started = history.events.find((event) => event.type === "tool.started");
  const finished = history.events.find((event) => event.type === "tool.finished");
  assert.equal(started?.type === "tool.started" && started.payload.description, "web_search");
  assert.equal(finished?.type === "tool.finished" && finished.payload.summary, evidence.replace(/\n/g, " "));
});

test("desktop task history reuses the exact persisted runtime event stream", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-exact-history-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  const journals = path.join(root, "journals");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-exact.jsonl"), `${JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00.000Z", task: "生成页面" })}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new TaskRunJournal(workspace, journals);
  const run = await journal.begin({ sessionId: "session-exact", task: "生成页面", providerId: "test", model: "model" });
  await journal.complete("completed");
  await journal.saveRuntimeEvents(run.runId, [{
    schemaVersion: 1, eventId: "event-1", taskId: "runtime-task", sequence: 1,
    timestamp: "2026-09-29T01:00:00.000Z", type: "task.started", payload: { taskPreview: "生成页面" },
  }]);
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime, provider: { id: "test", label: "Test", model: "model" }, journal,
  }));
  const history = await controller.openTaskHistory(workspace, { taskId: run.runId });
  assert.equal(history.fidelity, "exact");
  assert.deepEqual(history.events.map((event) => event.eventId), ["event-1"]);
});

test("mixed legacy and exact rounds retain replies in their own round and preserve child results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mixed-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-mixed.jsonl"), [
    { type: "task", task: "make snake", timestamp: "2026-10-03T01:00:00Z" },
    { type: "assistant", text: "old snake result" },
    { type: "task", task: "review with children", timestamp: "2026-10-03T02:00:00Z" },
    { type: "assistant", text: "new review result" },
  ].map((event) => JSON.stringify(event)).join("\n"));
  const journal = new TaskRunJournal(workspace, path.join(root, "journals"));
  await journal.begin({ sessionId: "session-mixed", task: "make snake", providerId: "p", model: "m" });
  await journal.complete("completed");
  const latest = await journal.begin({ sessionId: "session-mixed", task: "review with children", providerId: "p", model: "m" });
  await journal.complete("completed");
  await journal.saveRuntimeEvents(latest.runId, [
    { schemaVersion: 1, eventId: "new-start", taskId: "new", sequence: 1, timestamp: latest.startedAt, type: "task.started", payload: { taskPreview: "review with children" } },
    { schemaVersion: 1, eventId: "child-complete", taskId: "new", sequence: 2, timestamp: latest.startedAt, type: "subagent.updated", payload: { agent: { id: "child", runId: "child-run", title: "Review", role: "reviewer", status: "completed", result: "child result" } } },
    { schemaVersion: 1, eventId: "new-reply", taskId: "new", sequence: 3, timestamp: latest.startedAt, type: "assistant.message", payload: { text: "new review result", hasToolCalls: false } },
  ]);
  const runtime = new XiuRuntime(); runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime, journal, provider: { id: "p", label: "p", model: "m" } }));
  const history = await controller.openTaskHistory(workspace, { taskId: "session-mixed" });
  const split = history.events.findIndex((event) => event.eventId === "new-start");
  assert.ok(split > 0);
  assert.match(JSON.stringify(history.events.slice(0, split)), /old snake result/);
  assert.doesNotMatch(JSON.stringify(history.events.slice(split)), /old snake result/);
  assert.match(JSON.stringify(history.events.slice(split)), /child result/);
  assert.equal(history.events.filter((event) => event.type === "assistant.message").length, 2);
  assert.equal(history.fidelity, "reconstructed");
  assert.deepEqual(history.events.map((event) => event.sequence), history.events.map((_, index) => index + 1));
});

test("desktop task history never mixes events from another conversation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-isolated-history-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  const journals = path.join(root, "journals");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-a.jsonl"), `${JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00.000Z", task: "alpha task" })}\n`);
  await fs.writeFile(path.join(sessions, "session-b.jsonl"), `${JSON.stringify({ type: "task", timestamp: "2026-09-29T02:00:00.000Z", task: "beta task" })}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new TaskRunJournal(workspace, journals);
  const alpha = await journal.begin({ sessionId: "session-a", task: "alpha task", providerId: "test", model: "model" });
  await journal.complete("completed");
  await journal.saveRuntimeEvents(alpha.runId, [{ schemaVersion: 1, eventId: "alpha-event", taskId: alpha.runId, sequence: 1, timestamp: "2026-09-29T01:00:00.000Z", type: "assistant.message", payload: { text: "alpha-only", hasToolCalls: false } }]);
  await saveTaskChangeHistory(workspace, alpha.runId, historicalReport("alpha.txt", "alpha-only-change"));
  const beta = await journal.begin({ sessionId: "session-b", task: "beta task", providerId: "test", model: "model" });
  await journal.complete("completed");
  await journal.saveRuntimeEvents(beta.runId, [{ schemaVersion: 1, eventId: "beta-event", taskId: beta.runId, sequence: 1, timestamp: "2026-09-29T02:00:00.000Z", type: "assistant.message", payload: { text: "beta-only", hasToolCalls: false } }]);
  await saveTaskChangeHistory(workspace, beta.runId, historicalReport("beta.txt", "beta-only-change"));
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime, provider: { id: "test", label: "Test", model: "model" }, journal }));
  const history = await controller.openTaskHistory(workspace, { taskId: "session-a" });
  assert.equal(history.taskId, "session-a");
  assert.match(JSON.stringify(history), /alpha-only/);
  assert.match(JSON.stringify(history.changes), /alpha-only-change/);
  assert.doesNotMatch(JSON.stringify(history), /beta-only|beta-event|beta-only-change/);
});

test("desktop task completion persists a final change report and history reloads it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-change-history-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  const journals = path.join(root, "journals");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-snapshot.jsonl"), `${JSON.stringify({ type: "task", timestamp: "2026-09-30T01:00:00.000Z", task: "创建快照" })}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new TaskRunJournal(workspace, journals);
  let outcome: ReturnType<RuntimeTaskDriver["status"]>["outcome"] = "idle";
  const driver: RuntimeTaskDriver = {
    async run() {
      outcome = "running";
      await journal.begin({ sessionId: "session-snapshot", task: "创建快照", providerId: "test", model: "model" });
      await fs.writeFile(path.join(workspace, "created-by-task.txt"), "snapshot line\n");
      await journal.complete("completed");
      outcome = "completed";
      return "done";
    },
    cancel() { return false; }, steer() { return false; }, status() { return { outcome }; },
  };
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime, provider: { id: "test", label: "Test", model: "model" }, journal,
  }));
  await controller.createTask(workspace, "创建快照");
  while (runtime.snapshot().task?.state === "running") await new Promise((resolve) => setImmediate(resolve));
  const run = (await journal.recent())[0]!;
  const history = await controller.openTaskHistory(workspace, { taskId: "session-snapshot" });
  assert.equal(history.changes?.changes[0]?.path, "created-by-task.txt");
  assert.match(history.changes?.changes[0]?.preview ?? "", /snapshot line/);
  assert.equal((await loadTaskChangeHistory(workspace, run.runId))?.changes[0]?.path, "created-by-task.txt");
});

test("desktop task deletion removes a whole conversation but preserves workspace files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-delete-task-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  const journals = path.join(root, "journals");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(workspace, "keep.txt"), "keep\n");
  await fs.writeFile(path.join(sessions, "session-delete.jsonl"), `${JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00.000Z", task: "删除我" })}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new TaskRunJournal(workspace, journals);
  const first = await journal.begin({ sessionId: "session-delete", task: "第一轮", providerId: "test", model: "model" });
  await journal.complete("completed");
  const second = await journal.begin({ sessionId: "session-delete", task: "第二轮", providerId: "test", model: "model", resumedFrom: first.runId });
  await journal.complete("completed");
  await saveTaskChangeHistory(workspace, first.runId, historicalReport("first.txt", "first"));
  await saveTaskChangeHistory(workspace, second.runId, historicalReport("second.txt", "second"));
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime, provider: { id: "test", label: "Test", model: "model" }, journal,
  }));
  await assert.rejects(() => controller.deleteTask(workspace, { taskId: second.runId, confirmed: true }, false), /主进程确认/);
  await controller.deleteTask(workspace, { taskId: second.runId, confirmed: true }, true);
  assert.equal((await journal.recent()).length, 0);
  await assert.rejects(() => fs.access(path.join(sessions, "session-delete.jsonl")));
  assert.equal(await loadTaskChangeHistory(workspace, first.runId), undefined);
  assert.equal(await loadTaskChangeHistory(workspace, second.runId), undefined);
  assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "keep\n");
});

test("desktop deletes journal-only conversations by sidebar session ID and tolerates stale retries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-orphan-task-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "keep.txt"), "untouched");
  const journal = new TaskRunJournal(workspace, path.join(root, "journals"));
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const run = await journal.begin({ sessionId: "manually-removed-session", task: "fixture", providerId: "test", model: "model" });
    await journal.complete("failed");
    await saveTaskChangeHistory(workspace, run.runId, historicalReport("keep.txt", "untouched"));
    runs.push(run);
  }
  const unrelated = await journal.begin({ sessionId: "other-session", task: "keep", providerId: "test", model: "model" });
  await journal.complete("completed");
  const runtime = new XiuRuntime(); runtime.attachDriver(new FakeDriver());
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime, journal, provider: { id: "test", label: "test", model: "model" } }));
  const request = { taskId: "manually-removed-session", confirmed: true };
  await assert.rejects(controller.deleteTask(workspace, request, false));
  assert.equal((await journal.recent()).length, 3);
  await controller.deleteTask(workspace, request, true);
  await controller.deleteTask(workspace, request, true);
  assert.deepEqual((await journal.recent()).map((r) => r.runId), [unrelated.runId]);
  for (const run of runs) assert.equal(await loadTaskChangeHistory(workspace, run.runId), undefined);
  assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "untouched");
});

test("desktop approval mode is applied by the main-process controller and exposed to the renderer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-approval-mode-"));
  const workspace = path.join(root, "workspace");
  const journals = path.join(root, "journals");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new XiuRuntime();
  runtime.attachDriver(new FakeDriver());
  const modes: string[] = [];
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime,
    provider: { id: "test", label: "Test", model: "test-model-with-a-long-name" },
    journal: new TaskRunJournal(workspace, journals),
    setApprovalMode(mode) { modes.push(mode); },
  }));
  assert.equal((await controller.connect(workspace, 0)).approvalMode, "ask");
  const connection = await controller.setApprovalMode(workspace, { mode: "workspace" });
  assert.equal(connection.approvalMode, "workspace");
  assert.deepEqual(modes, ["ask", "workspace"]);
  await assert.rejects(() => controller.setApprovalMode(workspace, { mode: "invalid" as never }), /Invalid approval mode/);
});

test("desktop can continue a historical session and start a genuinely fresh conversation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-continue-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(workspace, ".xiu", "sessions");
  const journals = path.join(root, "journals");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "session-old.jsonl"), [
    JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00.000Z", task: "创建页面" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-29T01:00:01.000Z", text: "第一轮完成", toolCalls: [] }),
  ].join("\n") + "\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new XiuRuntime();
  const driver = new FakeDriver();
  runtime.attachDriver(driver);
  let restoredId: string | undefined;
  let cleared = 0;
  const fakeAgent = {
    restoreSession(restored: { id: string }) { restoredId = restored.id; },
    async setModel() {},
    clearConversation() { cleared++; },
  };
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime, provider: { id: "test", label: "Test", model: "test-model" },
    journal: new TaskRunJournal(workspace, journals), agent: fakeAgent as unknown as WorkspaceAgentHost["agent"],
  }));
  const continued = await controller.continueTask(workspace, "session-old", "继续补充测试");
  assert.equal(restoredId, "session-old");
  assert.equal(continued.runtime.snapshot.task?.taskPreview, "继续补充测试");
  assert.ok(continued.runtime.events.some((event) => event.type === "assistant.message" && event.payload.text === "第一轮完成"));
  driver.outcome = "completed";
  driver.result.resolve("done");
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await controller.newConversation(workspace);
  assert.equal(cleared, 1);
  assert.equal(fresh.runtime.snapshot.task, undefined);
});

test("switching model preserves the same session but never restores Full Access", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-switch-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".xiu", "sessions"), { recursive: true });
  await fs.writeFile(path.join(root, ".xiu", "sessions", "old.jsonl"), JSON.stringify({ type: "task", timestamp: "2026-09-29T01:00:00Z", task: "original goal" }) + "\n");
  const models: string[] = [];
  const sessions: string[] = [];
  const modes: string[] = [];
  let hosts = 0;
  const controller = new DesktopTaskController(() => undefined, async () => {
    const first = hosts++ === 0;
    const runtime = new XiuRuntime(); runtime.attachDriver(new FakeDriver());
    return { runtime, provider: { id: "fixture", label: "fixture", model: first ? "first" : "second" }, journal: new TaskRunJournal(root, path.join(root, "journals")),
      setApprovalMode: (mode) => { modes.push(mode); },
      agent: { status: () => ({ sessionId: first ? "old" : undefined }), restoreSession: (session: { id: string }) => sessions.push(session.id), setModel: async (model: string) => { models.push(model); } } as unknown as WorkspaceAgentHost["agent"] };
  });
  await controller.connect(root);
  await controller.reload(root);
  assert.deepEqual(sessions, ["old"]);
  assert.deepEqual(models, ["second"]);
  assert.ok(modes.every((mode) => mode === "ask"));
});
