import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { Agent } from "../src/agent.js";
import { TaskPlanManager, createPlanTools } from "../src/plan.js";
import { loadSession } from "../src/session.js";
import { TaskRunJournal } from "../src/task-run.js";
import { builtinTools } from "../src/tools.js";
import type { ModelProvider } from "../src/types.js";
import { createWorkspaceAgentHost } from "../src/runtime/workspace-agent-host.js";
import { AgentRuntimeAdapter } from "../src/runtime/agent-adapter.js";
import { applyRuntimeEvent } from "../src/runtime/protocol.js";
import { XiuRuntime, type RuntimeTaskDriver } from "../src/runtime/xiu-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-plan-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const journalRoot = path.join(root, "journal");
  return { root, workspace, journalRoot };
}
function driverFixture() {
  const finish = deferred<string>();
  let outcome: ReturnType<RuntimeTaskDriver["status"]>["outcome"] = "idle";
  let planMode = false;
  const driver: RuntimeTaskDriver = {
    async run() { outcome = "running"; return finish.promise; },
    cancel() { outcome = "cancelled"; finish.resolve("cancelled"); return true; },
    steer() { return true; },
    status: () => ({ outcome, planMode }),
    async setPlanMode(enabled) { planMode = enabled; },
  };
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  return { runtime, driver, finish };
}

test("shared runtime rejects mode changes during running, approval, stopping and pending mode changes", async () => {
  const { runtime, driver } = driverFixture();
  await runtime.setPlanMode(true);
  assert.equal(runtime.snapshot().planMode, true);
  const run = runtime.createTask("plan only");
  await assert.rejects(runtime.setPlanMode(false), /active/);
  const approval = runtime.requestApproval({ risk: "write", description: "should wait" });
  await assert.rejects(runtime.setPlanMode(false), /active/);
  runtime.stopTask();
  await assert.rejects(runtime.setPlanMode(false), /active/);
  assert.equal(await approval, false);
  await run;
  const changed = deferred<void>();
  driver.setPlanMode = () => changed.promise;
  const pending = runtime.setPlanMode(false);
  await assert.rejects(runtime.setPlanMode(true), /active/);
  await assert.rejects(runtime.createTask("race"), /mode change/);
  changed.resolve();
  await pending;
  await assert.rejects(runtime.setPlanMode("false" as never), /Invalid/);
  await assert.rejects(new XiuRuntime().setPlanMode(true), /driver/);
});

test("runtime reducer preserves the selected mode across follow-up task replacement", () => {
  const next = applyRuntimeEvent({ schemaVersion: 1, sequence: 3, generatedAt: "now", planMode: true,
    task: { id: "old", state: "completed", taskPreview: "old", startedAt: "now", updatedAt: "now" } },
  { schemaVersion: 1, sequence: 4, eventId: "new-event", taskId: "new", timestamp: "later", type: "task.started", payload: { taskPreview: "new" } });
  assert.equal(next.planMode, true);
});

test("desktop Plan changes are bound to the current idle host and conversation and reject stale or malformed requests", async (t) => {
  const { workspace, journalRoot } = await fixture(t);
  const { runtime } = driverFixture();
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime,
    journal: new TaskRunJournal(workspace, journalRoot), provider: { id: "fake", label: "Fake", model: "offline" } }));
  const initial = await controller.connect(workspace);
  assert.equal(initial.runtime.snapshot.planMode, false);
  await assert.rejects(controller.setPlanMode(workspace, { enabled: true, contextId: "stale" }), /上下文/);
  await assert.rejects(controller.setPlanMode(workspace, { enabled: "true" as never, contextId: initial.modeContextId! }), /Invalid/);
  await assert.rejects(controller.setPlanMode(`${workspace}-other`, { enabled: true, contextId: initial.modeContextId! }), /上下文/);
  const plan = await controller.setPlanMode(workspace, { enabled: true, contextId: initial.modeContextId! });
  assert.equal(plan.runtime.snapshot.planMode, true);
  assert.notEqual(plan.modeContextId, initial.modeContextId);
  await assert.rejects(controller.setPlanMode(workspace, { enabled: false, contextId: initial.modeContextId! }), /上下文/);
  const fresh = await controller.newConversation(workspace);
  await assert.rejects(controller.setPlanMode(workspace, { enabled: false, contextId: plan.modeContextId! }), /上下文/);
  const active = await controller.createTask(workspace, "task");
  await assert.rejects(controller.createTask(workspace, "duplicate task"), /已有任务/);
  assert.equal((await controller.connect(workspace)).modeContextId, active.modeContextId);
  await assert.rejects(controller.setPlanMode(workspace, { enabled: false, contextId: active.modeContextId! }), /任务或配置/);
  await controller.stopTask(workspace);
  await new Promise((resolve) => setImmediate(resolve));
  controller.detach();
  await controller.connect(workspace);
  await assert.rejects(controller.setPlanMode(workspace, { enabled: false, contextId: fresh.modeContextId! }), /上下文/);
});

test("desktop Plan rejects other writers, MCP work, pending Full Access confirmation, and a context replaced during lock checks", async (t) => {
  const { workspace, journalRoot } = await fixture(t);
  const { runtime } = driverFixture();
  const journal = new TaskRunJournal(workspace, journalRoot);
  const mcp = { busy: false };
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime, journal,
    mcp: mcp as never, setApprovalMode() {}, provider: { id: "fake", label: "Fake", model: "offline" } }));
  const connection = await controller.connect(workspace);
  const request = { enabled: true, contextId: connection.modeContextId! };
  const other = new TaskRunJournal(workspace, journalRoot);
  await other.begin({ sessionId: "other", task: "external", providerId: "fake", model: "offline" });
  await assert.rejects(controller.setPlanMode(workspace, request), /另一个/);
  await other.complete("cancelled");
  mcp.busy = true;
  await assert.rejects(controller.setPlanMode(workspace, request), /任务或配置/);
  mcp.busy = false;
  const confirmation = deferred<boolean>();
  const selecting = controller.setApprovalMode(workspace, { mode: "full" }, () => confirmation.promise);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(controller.setPlanMode(workspace, request), /任务或配置/);
  confirmation.resolve(false);
  await selecting;
  const lock = deferred<Awaited<ReturnType<TaskRunJournal["lockStatus"]>>>();
  journal.lockStatus = () => lock.promise;
  const changing = controller.setPlanMode(workspace, request);
  controller.detach();
  lock.resolve({ active: false, live: false });
  await assert.rejects(changing, /上下文/);
  assert.equal(runtime.snapshot().planMode, false);
});

test("real shared Agent in desktop Plan mode blocks writes, processes and child work under Full Access", async (t) => {
  const { workspace } = await fixture(t);
  const plan = new TaskPlanManager();
  const runtime = new XiuRuntime();
  let calls = 0;
  let approvals = 0;
  let childExecutions = 0;
  const outputs: string[] = [];
  const provider: ModelProvider = { async complete() {
    calls++;
    if (calls === 1) return { text: "Plan", raw: {}, toolCalls: [
      { id: "plan", name: "update_task_plan", input: { goal: "Inspect", steps: [{ id: "1", title: "Implement later", status: "pending" }] } },
      { id: "write", name: "write_file", input: { path: "forbidden.txt", content: "must not exist" } },
      { id: "command", name: "run_process", input: { program: "node", args: ["-e", "require('fs').writeFileSync('process.txt','no')"] } },
      { id: "child", name: "spawn_agent", input: {} },
    ] };
    return { text: "Planning deliverable complete", toolCalls: [], raw: {} };
  } };
  const agent = new Agent({ provider: "openai", providerId: "fake", model: "offline", cwd: workspace, maxTurns: 5, autoApprove: false, language: "en-US" }, provider,
    [...builtinTools, ...createPlanTools(plan), { name: "spawn_agent", risk: "execute", description: "spawn child", inputSchema: { type: "object" }, describe: () => "child", async execute() { childExecutions++; return "unsafe"; } }],
    async () => { approvals++; return true; }, runtime.agentEvents({ onToolEnd: (_name, output) => { outputs.push(output); } }), undefined, undefined, plan);
  agent.setAccessMode("full");
  runtime.attachDriver(new AgentRuntimeAdapter(agent));
  await runtime.setPlanMode(true);
  await runtime.createTask("Only create a plan");
  assert.equal(runtime.snapshot().planMode, true);
  assert.equal(runtime.snapshot().task?.state, "completed", "a planning deliverable can complete with pending future execution steps");
  assert.equal(plan.snapshot()?.steps[0]?.status, "pending");
  assert.equal(approvals, 0);
  assert.equal(childExecutions, 0);
  assert.equal(outputs.filter((output) => output.includes("plan mode is read-only")).length, 3);
  await assert.rejects(fs.stat(path.join(workspace, "forbidden.txt")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(workspace, "process.txt")), { code: "ENOENT" });
});

test("desktop history continuation and recovery preserve the explicitly selected mode while CLI defaults restore history", async (t) => {
  const { workspace, journalRoot } = await fixture(t);
  const sessions = path.join(workspace, ".xiu", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "old.jsonl"), [
    { type: "task", task: "Historical task" }, { type: "plan_mode", enabled: false },
    { type: "plan", plan: { goal: "Old plan", steps: [{ id: "1", title: "Future work", status: "pending" }], updatedAt: new Date().toISOString() } },
  ].map((record) => JSON.stringify({ timestamp: new Date().toISOString(), ...record })).join("\n") + "\n");
  const restored = await loadSession(workspace, "old");
  const plan = new TaskPlanManager();
  const provider: ModelProvider = { async complete() { return { text: "Plan complete", toolCalls: [], raw: {} }; } };
  const runtime = new XiuRuntime();
  const journal = new TaskRunJournal(workspace, journalRoot);
  const agent = new Agent({ provider: "openai", providerId: "fake", model: "offline", cwd: workspace, maxTurns: 3, autoApprove: false, language: "en-US" }, provider, [], async () => false, runtime.agentEvents(), undefined, undefined, plan, undefined, undefined, journal);
  runtime.attachDriver(new AgentRuntimeAdapter(agent));
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime, agent, journal, provider: { id: "fake", label: "Fake", model: "offline" } }));
  const connected = await controller.connect(workspace);
  await controller.setPlanMode(workspace, { enabled: true, contextId: connected.modeContextId! });
  await controller.continueTask(workspace, "old", "Continue planning");
  while (["running", "waiting_approval", "stopping"].includes(runtime.snapshot().task?.state ?? "")) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.snapshot().task?.state, "completed", JSON.stringify(runtime.snapshot()));
  assert.equal(runtime.snapshot().planMode, true);
  assert.equal(agent.status().planMode, true);
  await controller.newConversation(workspace);
  assert.equal(agent.status().planMode, true);
  assert.equal(plan.snapshot(), undefined);
  await fs.writeFile(path.join(sessions, "recovery.jsonl"), [
    { type: "task", task: "Interrupted planning" }, { type: "plan_mode", enabled: false },
  ].map((record) => JSON.stringify({ timestamp: new Date().toISOString(), ...record })).join("\n") + "\n");
  const paused = await journal.begin({ sessionId: "recovery", task: "Interrupted planning", providerId: "fake", model: "offline" });
  await journal.pause("test fixture interrupted at a safe boundary");
  runtime.recordRecovery({ runId: paused.runId, status: "paused", interruptedOperations: 0, unknownSideEffects: 0, recommendation: "Resume only after confirmation" });
  await controller.recoverTask(workspace, { runId: paused.runId }, false);
  while (["running", "waiting_approval", "stopping"].includes(runtime.snapshot().task?.state ?? "")) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.snapshot().task?.state, "completed", JSON.stringify(runtime.snapshot()));
  assert.equal(agent.status().planMode, true, "recovery cannot silently leave the selected read-only mode");
  agent.restoreSession(restored);
  assert.equal(agent.status().planMode, false, "CLI session restore remains backward compatible");
  await agent.setPlanMode(true);
  agent.restoreSession(restored, { preservePlanMode: true });
  assert.equal(agent.status().planMode, true);
  await agent.setPlanMode(false);
  agent.restoreSession({ ...restored, planMode: true }, { preservePlanMode: true });
  assert.equal(agent.status().planMode, false, "historical Plan cannot silently change an explicit execution selection either");
  agent.clearConversation();
  assert.equal(agent.status().planMode, false, "CLI reset remains backward compatible");
  await controller.reviewSnapshot(workspace); // Drain asynchronous final change-history persistence before cleanup.
});


test("real desktop host forwards idle Plan mode to its shared manager and resets it on reopening", async (t) => {
  const { workspace, journalRoot } = await fixture(t);
  const finish = deferred<void>();
  let calls = 0;
  const options = {
    profile: { id: "fixture", name: "Fixture", kind: "openai-compatible" as const, model: "offline", features: { tools: true, vision: false, image: false, video: false, audio: false } },
    backgroundRoot: path.join(workspace, ".xiu", "background"), journalRoot,
    provider: { async complete() {
      calls++;
      await finish.promise;
      if (calls === 1) return { text: "Inspect", raw: {}, toolCalls: [{ id: "blocked", name: "write_file", input: { path: "forbidden.txt", content: "no" } }] };
      return { text: "Planning complete", toolCalls: [], raw: {} };
    } },
  };
  const host = await createWorkspaceAgentHost(workspace, options);
  await host.runtime.setPlanMode(true);
  host.setApprovalMode!("full");
  assert.equal(host.agent!.status().planMode, true);
  const running = host.runtime.createTask("Plan without changes");
  await assert.rejects(host.agent!.setPlanMode(false), /while a task is running/);
  finish.resolve();
  await running;
  assert.equal(host.runtime.snapshot().task?.state, "failed", "denied tool-only work is not a completed planning deliverable");
  assert.equal(host.agent!.status().failureReason, "tool_failed");
  await assert.rejects(fs.stat(path.join(workspace, "forbidden.txt")), { code: "ENOENT" });
  await host.close!();
  const reopened = await createWorkspaceAgentHost(workspace, options);
  assert.equal(reopened.runtime.snapshot().planMode, false);
  await reopened.close!();
});


test("failed Plan-mode persistence never changes the selected policy and pending changes exclude session/task races", async (t) => {
  const { workspace } = await fixture(t);
  const sessions = path.join(workspace, ".xiu", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, "old.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "task", task: "Old task", timestamp: new Date().toISOString() })}\n`);
  const restored = await loadSession(workspace, "old");
  const manager = new TaskPlanManager(undefined, true);
  const agent = new Agent({ provider: "openai", providerId: "fake", model: "offline", cwd: workspace, language: "en-US" },
    { async complete() { return { text: "done", toolCalls: [], raw: {} }; } }, [], async () => false, {}, undefined, undefined, manager);
  agent.restoreSession(restored, { preservePlanMode: true });
  await fs.rename(file, `${file}.backup`);
  await fs.mkdir(file); // Deterministic append failure on every platform, without permission assumptions.
  const changing = agent.setPlanMode(false);
  await assert.rejects(agent.run("must not race"), /mode change/);
  assert.throws(() => agent.clearConversation(), /mode change/);
  assert.throws(() => agent.restoreSession(restored), /mode change/);
  await assert.rejects(changing);
  assert.equal(agent.status().planMode, true);
  await fs.rmdir(file);
  await fs.rename(`${file}.backup`, file);
  await agent.setPlanMode(false);
  assert.equal(agent.status().planMode, false, "failure releases the mode-change latch for an explicit retry");
});


for (const failingRecord of ["stats", "diagnostics"]) {
  test(`failed final ${failingRecord} persistence releases the Agent for repaired-log mode/session changes and new tasks`, async (t) => {
    const { workspace, journalRoot } = await fixture(t);
    const manager = new TaskPlanManager(undefined, true);
    const runtime = new XiuRuntime();
    const agent = new Agent({ provider: "openai", providerId: "fake", model: "offline", cwd: workspace, language: "en-US" },
      { async complete() { return { text: "Planning done", toolCalls: [], raw: {} }; } }, [], async () => false, runtime.agentEvents(), undefined, undefined, manager);
    runtime.attachDriver(new AgentRuntimeAdapter(agent));
    const controller = new DesktopTaskController(() => {}, async () => ({ runtime, agent,
      journal: new TaskRunJournal(workspace, journalRoot), provider: { id: "fake", label: "Fake", model: "offline" } }));
    await controller.connect(workspace);
    let sawStats = false;
    let brokenFile: string | undefined;
    const appendFile = fs.appendFile.bind(fs);
    t.mock.method(fs, "appendFile", async (...args: Parameters<typeof fs.appendFile>) => {
      const line = String(args[1]);
      if (line.includes('"type":"stats"')) sawStats = true;
      if (!brokenFile && sawStats && line.includes(`"type":"${failingRecord}"`)) {
        brokenFile = String(args[0]);
        await fs.rename(brokenFile, `${brokenFile}.backup`);
        await fs.mkdir(brokenFile);
      }
      return appendFile(...args);
    });
    await assert.rejects(runtime.createTask("Planning only"));
    assert.ok(brokenFile, "the deterministic failure must hit final persistence");
    assert.equal(runtime.snapshot().task?.state, "failed");
    assert.equal(agent.status().outcome, "failed");
    assert.equal(agent.cancel(), false, "the failed run no longer owns an active controller");
    await fs.rmdir(brokenFile);
    await fs.rename(`${brokenFile}.backup`, brokenFile);
    agent.restoreSession(await loadSession(workspace, agent.status().sessionId), { preservePlanMode: true });
    const connection = await controller.newConversation(workspace);
    const switched = await controller.setPlanMode(workspace, { enabled: false, contextId: connection.modeContextId! });
    assert.equal(switched.runtime.snapshot.planMode, false);
    await runtime.createTask("A fresh task after the log was repaired");
    assert.equal(runtime.snapshot().task?.state, "completed");
    await controller.reviewSnapshot(workspace);
  });
}

async function startedConversation(t: { after: (fn: () => Promise<unknown>) => void }) {
  const { workspace, journalRoot } = await fixture(t);
  const manager = new TaskPlanManager();
  const runtime = new XiuRuntime();
  const journal = new TaskRunJournal(workspace, journalRoot);
  const agent = new Agent({ provider: "openai", providerId: "fake", model: "offline", cwd: workspace, language: "en-US" },
    { async complete() { return { text: "Done", toolCalls: [], raw: {} }; } }, [], async () => false, runtime.agentEvents(), undefined, undefined, manager);
  runtime.attachDriver(new AgentRuntimeAdapter(agent));
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime, agent, journal, provider: { id: "fake", label: "Fake", model: "offline" } }));
  const connection = await controller.connect(workspace);
  await runtime.createTask("Initial conversation");
  await controller.reviewSnapshot(workspace);
  const sessionId = agent.status().sessionId!;
  return { workspace, runtime, agent, journal, controller, connection, sessionId, file: path.join(workspace, ".xiu", "sessions", `${sessionId}.jsonl`) };
}

for (const operation of ["new", "delete"]) {
  test(`a deferred ${operation} conversation request cannot partially mutate a concurrent Plan change`, async (t) => {
    const f = await startedConversation(t);
    const lockEntered = deferred<void>();
    const lock = deferred<Awaited<ReturnType<TaskRunJournal["lockStatus"]>>>();
    const lockStatus = f.journal.lockStatus.bind(f.journal);
    let firstLock = true;
    f.journal.lockStatus = () => {
      if (firstLock) { firstLock = false; lockEntered.resolve(); return lock.promise; }
      return lockStatus();
    };
    const logEntered = deferred<void>();
    const log = deferred<void>();
    const appendFile = fs.appendFile.bind(fs);
    t.mock.method(fs, "appendFile", async (...args: Parameters<typeof fs.appendFile>) => {
      if (String(args[1]).includes('"type":"plan_mode"')) { logEntered.resolve(); await log.promise; }
      return appendFile(...args);
    });
    const mutation = operation === "new"
      ? f.controller.newConversation(f.workspace)
      : f.controller.deleteTask(f.workspace, { taskId: f.sessionId, confirmed: true }, true);
    const rejected = assert.rejects(mutation, /上下文|任务或配置/);
    await lockEntered.promise;
    const plan = f.controller.setPlanMode(f.workspace, { enabled: true, contextId: f.connection.modeContextId! });
    await logEntered.promise;
    // Reproduce the narrow completion boundary where Agent and Runtime latches
    // can finish on different microtasks. Neither operation may partially clear.
    log.resolve();
    lock.resolve({ active: false, live: false });
    await Promise.all([rejected, plan]);
    assert.equal(f.agent.status().sessionId, f.sessionId);
    assert.equal(f.agent.status().planMode, true);
    assert.equal(f.runtime.snapshot().task?.state, "completed");
    assert.ok((await fs.stat(f.file)).isFile(), "the rejected deletion must preserve session bytes");
    await f.controller.newConversation(f.workspace);
    assert.equal(f.agent.status().sessionId, undefined);
    assert.equal(f.runtime.snapshot().task, undefined);
    assert.equal(f.runtime.snapshot().planMode, true);
  });
}

test("session deletion excludes mode changes and task starts through its asynchronous deletion work", async (t) => {
  const f = await startedConversation(t);
  const entered = deferred<void>();
  const records = deferred<Awaited<ReturnType<TaskRunJournal["recent"]>>>();
  f.journal.recent = () => { entered.resolve(); return records.promise; };
  const deleting = f.controller.deleteTask(f.workspace, { taskId: f.sessionId, confirmed: true }, true);
  await entered.promise;
  assert.equal(f.controller.canChangeWorkspace(), false);
  await assert.rejects(f.controller.setPlanMode(f.workspace, { enabled: true, contextId: f.connection.modeContextId! }), /任务或配置/);
  await assert.rejects(f.controller.createTask(f.workspace, "must not start during deletion"), /已有任务/);
  await assert.rejects(f.controller.newConversation(f.workspace), /任务运行期间/);
  records.resolve([]);
  await deleting;
  assert.equal(f.controller.canChangeWorkspace(), true);
  assert.equal(f.agent.status().sessionId, undefined);
  assert.equal(f.runtime.snapshot().task, undefined);
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});

test("same-workspace Provider reconfiguration preserves Plan but resets Full Access; close and workspace changes reset both", async (t) => {
  const { root, workspace, journalRoot } = await fixture(t);
  const otherWorkspace = path.join(root, "other");
  await fs.mkdir(otherWorkspace);
  let created = 0;
  let closed = 0;
  const modes: string[] = [];
  const controller = new DesktopTaskController(() => {}, async (cwd) => {
    created++;
    const { runtime } = driverFixture();
    return { runtime, journal: new TaskRunJournal(cwd, journalRoot), provider: { id: `provider-${created}`, label: "Fixture", model: "offline" },
      setApprovalMode: (mode) => { modes.push(mode); }, close: async () => { closed++; } };
  });
  const initial = await controller.connect(workspace);
  const selected = await controller.setPlanMode(workspace, { enabled: true, contextId: initial.modeContextId! });
  await controller.setApprovalMode(workspace, { mode: "full" }, async () => true);
  const reconfigured = await controller.reload(workspace);
  assert.equal(reconfigured.runtime.snapshot.planMode, true);
  assert.equal(reconfigured.approvalMode, "ask");
  assert.equal(reconfigured.provider.id, "provider-2");
  assert.notEqual(reconfigured.modeContextId, selected.modeContextId);
  assert.equal(closed, 1);
  await assert.rejects(controller.setApprovalMode(workspace, { mode: "full" }), /首次确认/);
  const execution = await controller.setPlanMode(workspace, { enabled: false, contextId: reconfigured.modeContextId! });
  assert.equal(execution.runtime.snapshot.planMode, false);
  const executionReload = await controller.reload(workspace);
  assert.equal(executionReload.runtime.snapshot.planMode, false);
  await controller.setPlanMode(workspace, { enabled: true, contextId: executionReload.modeContextId! });
  controller.detach();
  const reopened = await controller.connect(workspace);
  assert.equal(reopened.runtime.snapshot.planMode, false);
  assert.equal(reopened.approvalMode, "ask");
  await controller.setPlanMode(workspace, { enabled: true, contextId: reopened.modeContextId! });
  const switched = await controller.connect(otherWorkspace);
  assert.equal(switched.runtime.snapshot.planMode, false);
  assert.equal(switched.approvalMode, "ask");
  assert.equal(modes.at(-1), "ask");
  await controller.shutdown();
});

test("replacement hosts stay unpublished until Plan is restored and restore failures stay closed", async (t) => {
  const { workspace, journalRoot } = await fixture(t);
  const restoring = deferred<void>();
  const restore = deferred<void>();
  let count = 0;
  let failedHostClosed = false;
  const controller = new DesktopTaskController(() => {}, async (cwd) => {
    count++;
    const generation = count;
    const { runtime, driver } = driverFixture();
    const setPlanMode = driver.setPlanMode!.bind(driver);
    if (generation === 2) driver.setPlanMode = async (enabled) => { restoring.resolve(); await restore.promise; await setPlanMode(enabled); };
    if (generation === 3) driver.setPlanMode = undefined;
    return { runtime, journal: new TaskRunJournal(cwd, journalRoot), provider: { id: `provider-${generation}`, label: "Fixture", model: "offline" },
      close: async () => { if (generation === 3) failedHostClosed = true; } };
  });
  const initial = await controller.connect(workspace);
  await controller.setPlanMode(workspace, { enabled: true, contextId: initial.modeContextId! });
  const reload = controller.reload(workspace);
  await restoring.promise;
  let connectResolved = false;
  const connecting = controller.connect(workspace).then((connection) => { connectResolved = true; return connection; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectResolved, false, "no caller can see the replacement in its temporary Execute default");
  assert.equal(controller.canChangeWorkspace(), false);
  restore.resolve();
  assert.equal((await reload).runtime.snapshot.planMode, true);
  assert.equal((await connecting).runtime.snapshot.planMode, true);
  await assert.rejects(controller.reload(workspace), /Plan mode is unavailable/);
  assert.equal(failedHostClosed, true);
  const retried = await controller.connect(workspace);
  assert.equal(retried.provider.id, "provider-4");
  assert.equal(retried.runtime.snapshot.planMode, true, "retry preserves the explicit read-only choice after a failed replacement");
  await controller.shutdown();
});

test("closing during slow host disposal cancels Plan retention before an explicit reopen", async (t) => {
  const { workspace, journalRoot } = await fixture(t);
  const closing = deferred<void>();
  const close = deferred<void>();
  let generation = 0;
  const controller = new DesktopTaskController(() => {}, async () => {
    const current = ++generation;
    const { runtime } = driverFixture();
    return { runtime, journal: new TaskRunJournal(workspace, journalRoot), provider: { id: "fake", label: "Fixture", model: "offline" },
      close: async () => { if (current === 1) { closing.resolve(); await close.promise; } } };
  });
  const initial = await controller.connect(workspace);
  await controller.setPlanMode(workspace, { enabled: true, contextId: initial.modeContextId! });
  const reloading = assert.rejects(controller.reload(workspace), /上下文已经变化/);
  await closing.promise;
  controller.detach(); // Explicit close invalidates the in-flight same-workspace replacement.
  const reopen = controller.connect(workspace);
  close.resolve();
  await reloading;
  assert.equal((await reopen).runtime.snapshot.planMode, false);
  await controller.shutdown();
});
