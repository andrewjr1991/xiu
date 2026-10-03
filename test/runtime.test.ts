import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canAutomaticallyApprove } from "../src/runtime/workspace-agent-host.js";
import { Agent } from "../src/agent.js";
import { AgentRuntimeAdapter } from "../src/runtime/agent-adapter.js";
import { applyRuntimeEvent, XIU_RUNTIME_SCHEMA_VERSION, type RuntimeEvent, type XiuRuntimeSnapshot } from "../src/runtime/protocol.js";
import { XiuRuntime, type RuntimeTaskDriver } from "../src/runtime/xiu-runtime.js";
import type { ModelProvider } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

class FakeDriver implements RuntimeTaskDriver {
  outcome: ReturnType<RuntimeTaskDriver["status"]>["outcome"] = "idle";
  readonly result = deferred<string>();
  cancelled = false;
  steering: string[] = [];

  async run(): Promise<string> {
    this.outcome = "running";
    return this.result.promise;
  }
  cancel(): boolean {
    if (this.outcome !== "running") return false;
    this.cancelled = true;
    this.outcome = "cancelled";
    this.result.reject(new Error("Task cancelled."));
    return true;
  }
  steer(text: string): boolean {
    if (this.outcome !== "running") return false;
    this.steering.push(text);
    return true;
  }
  status() { return { outcome: this.outcome }; }
}

test("desktop approval modes keep danger confirmation except in explicitly enabled full access", () => {
  assert.equal(canAutomaticallyApprove("ask", { risk: "write", sessionScope: "workspace-files:write" }), false);
  assert.equal(canAutomaticallyApprove("workspace", { risk: "write", sessionScope: "workspace-files:write" }), true);
  assert.equal(canAutomaticallyApprove("workspace", { risk: "execute", sessionScope: "project-verification" }), true);
  assert.equal(canAutomaticallyApprove("workspace", { risk: "execute", sessionScope: "run-process:publish" }), true);
  assert.equal(canAutomaticallyApprove("workspace", { risk: "dangerous", sessionScope: "dangerous:delete" }), false);
  assert.equal(canAutomaticallyApprove("full", { risk: "execute", sessionScope: "run-process:test" }), true);
  assert.equal(canAutomaticallyApprove("full", { risk: "dangerous", sessionScope: "dangerous:delete" }), true);
});

test("runtime emits a monotonic task stream and preserves one active task", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const seen: RuntimeEvent[] = [];
  runtime.subscribe((event) => seen.push(event));

  const running = runtime.createTask("build the feature");
  assert.equal(runtime.steerTask("also update tests"), true);
  await assert.rejects(() => runtime.createTask("second task"), /already active/);
  driver.outcome = "completed";
  driver.result.resolve("done");
  assert.equal(await running, "done");

  assert.deepEqual(seen.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(new Set(seen.map((event) => event.eventId)).size, seen.length);
  assert.deepEqual(seen.map((event) => event.type), ["task.started", "task.steered", "task.finished"]);
  assert.equal(runtime.snapshot().task?.state, "completed");
});

test("runtime conversation reset clears terminal presentation state but rejects active tasks", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("first task");
  assert.throws(() => runtime.resetConversation(), /active/);
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
  runtime.resetConversation();
  assert.equal(runtime.snapshot().task, undefined);
  assert.equal(runtime.snapshot().sequence, 0);
  assert.deepEqual(runtime.connect(0).events, []);
});

test("renderer reducer ignores duplicates and rejects event gaps", () => {
  const initial: XiuRuntimeSnapshot = { schemaVersion: XIU_RUNTIME_SCHEMA_VERSION, sequence: 0, generatedAt: "2026-01-01T00:00:00.000Z" };
  const started: RuntimeEvent<"task.started"> = {
    schemaVersion: XIU_RUNTIME_SCHEMA_VERSION,
    eventId: "event-1",
    taskId: "task-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "task.started",
    payload: { taskPreview: "task" },
  };
  const next = applyRuntimeEvent(initial, started);
  assert.equal(applyRuntimeEvent(next, started), next);
  assert.throws(() => applyRuntimeEvent(next, { ...started, eventId: "event-3", sequence: 3 }), /event gap/);
});

test("reconnect returns missed events or requires a fresh snapshot after retention", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("task");
  runtime.steerTask("one");
  const replay = runtime.connect(1);
  assert.equal(replay.resyncRequired, false);
  assert.deepEqual(replay.events.map((event) => event.sequence), [2]);
  assert.equal(runtime.connect(99).resyncRequired, true);
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
});

test("stop cancels the real driver and reaches a cancelled terminal state", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("long task");
  assert.equal(runtime.stopTask(), true);
  await assert.rejects(running, /cancelled/);
  assert.equal(driver.cancelled, true);
  assert.equal(runtime.snapshot().task?.state, "cancelled");
});

test("approval is represented as runtime state and resolved only by its exact id", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("task");
  const approval = runtime.requestApproval({ description: "write file", risk: "write" });
  const approvalId = runtime.snapshot().task?.pendingApproval?.id;
  assert.ok(approvalId);
  assert.equal(runtime.snapshot().task?.state, "waiting_approval");
  assert.throws(() => runtime.decideApproval("stale", true), /stale/);
  runtime.decideApproval(approvalId, true);
  assert.equal(await approval, true);
  assert.equal(runtime.snapshot().task?.state, "running");
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
});

test("session approval remembers only an explicit non-dangerous operation scope", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("task");
  const first = runtime.requestApproval({ description: "run npm test", risk: "execute", sessionScope: "run-process:npm-test" });
  const approvalId = runtime.snapshot().task?.pendingApproval?.id;
  assert.ok(approvalId);
  runtime.decideApproval(approvalId, true, undefined, true);
  assert.equal(await first, true);
  assert.equal(await runtime.requestApproval({ description: "run npm test again", risk: "execute", sessionScope: "run-process:npm-test" }), true);
  const different = runtime.requestApproval({ description: "run another command", risk: "execute", sessionScope: "run-process:other" });
  assert.equal(runtime.snapshot().task?.state, "waiting_approval");
  const differentId = runtime.snapshot().task?.pendingApproval?.id;
  assert.ok(differentId);
  runtime.decideApproval(differentId, false);
  assert.equal(await different, false);
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
});

test("session approval cannot remember an unscoped or dangerous operation", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("task");
  const unscoped = runtime.requestApproval({ description: "write", risk: "write" });
  const unscopedId = runtime.snapshot().task?.pendingApproval?.id;
  assert.ok(unscopedId);
  assert.throws(() => runtime.decideApproval(unscopedId, true, undefined, true), /explicitly scoped/);
  runtime.decideApproval(unscopedId, false);
  assert.equal(await unscoped, false);
  const dangerous = runtime.requestApproval({ description: "delete", risk: "dangerous", sessionScope: "dangerous:delete" });
  const dangerousId = runtime.snapshot().task?.pendingApproval?.id;
  assert.ok(dangerousId);
  assert.throws(() => runtime.decideApproval(dangerousId, true, "dangerous", true), /non-dangerous/);
  runtime.decideApproval(dangerousId, false);
  assert.equal(await dangerous, false);
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
});

test("dangerous approvals require an explicit core-validated confirmation", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("dangerous task");
  const decision = runtime.requestApproval({ description: "delete external data", risk: "dangerous", preview: "target: remote/item" });
  const pending = runtime.snapshot().task?.pendingApproval;
  assert.equal(pending?.scope, "once");
  assert.match(pending?.recovery ?? "", /无法.*恢复/);
  assert.throws(() => runtime.decideApproval(pending!.id, true), /explicit risk confirmation/);
  runtime.decideApproval(pending!.id, true, "dangerous");
  assert.equal(await decision, true);
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
});

test("draft events stream safely and tool output is bounded before leaving the core", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const running = runtime.createTask("stream task");
  const events = runtime.agentEvents();
  events.onDraftPreview?.("partial reply", 13);
  events.onTextStreamEnd?.();
  events.onToolEnd?.("read_file", "summary", {
    result: { status: "success", output: "x".repeat(20_000), retryable: false, sideEffectState: "none" },
    verification: false,
  });
  const replay = runtime.connect(0).events;
  assert.ok(replay.some((event) => event.type === "assistant.draft"));
  assert.ok(replay.some((event) => event.type === "assistant.stream-end"));
  const finished = replay.find((event) => event.type === "tool.finished");
  assert.equal(finished?.type === "tool.finished" ? finished.payload.result?.output.length : 0, 16_000);
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
});

test("runtime redacts secrets before events and snapshots leave the core", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  const seen: RuntimeEvent[] = [];
  runtime.subscribe((event) => seen.push(event));
  const running = runtime.createTask("use api_key=top-secret-value");
  driver.outcome = "completed";
  driver.result.resolve("Bearer abcdefghijklmnopqrstuvwxyz");
  await running;
  const serialized = JSON.stringify({ snapshot: runtime.snapshot(), seen });
  assert.doesNotMatch(serialized, /top-secret-value|abcdefghijklmnopqrstuvwxyz/);
  assert.match(serialized, /REDACTED/);
});

test("unknown side effects block recovery until explicitly confirmed", () => {
  const runtime = new XiuRuntime();
  runtime.recordRecovery({
    runId: "run-1",
    status: "recoverable",
    interruptedOperations: 2,
    unknownSideEffects: 1,
    recommendation: "verify first",
  });
  assert.throws(() => runtime.assertRecoveryConfirmed("run-1", false), /Unknown side effects/);
  assert.doesNotThrow(() => runtime.assertRecoveryConfirmed("run-1", true));
  assert.throws(() => runtime.assertRecoveryConfirmed("other", true), /stale/);
});

test("recovery and resumed task remain one continuous event identity", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  runtime.recordRecovery({
    runId: "run-continuity",
    status: "paused",
    interruptedOperations: 1,
    unknownSideEffects: 0,
    recommendation: "resume after confirmation",
  });
  runtime.assertRecoveryConfirmed("run-continuity", false);
  const running = runtime.createTask("continue safely");
  driver.outcome = "completed";
  driver.result.resolve("done");
  await running;
  const connection = runtime.connect(0);
  assert.deepEqual(connection.events.map((event) => event.taskId), ["run-continuity", "run-continuity", "run-continuity"]);
  const reduced = connection.events.reduce(applyRuntimeEvent, {
    schemaVersion: XIU_RUNTIME_SCHEMA_VERSION,
    sequence: 0,
    generatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies XiuRuntimeSnapshot);
  assert.equal(reduced.task?.state, "completed");
});

test("a broken UI subscriber is detached without aborting the task", async () => {
  const driver = new FakeDriver();
  const runtime = new XiuRuntime();
  runtime.attachDriver(driver);
  let calls = 0;
  runtime.subscribe(() => { calls++; throw new Error("renderer disconnected"); });
  const running = runtime.createTask("continue without renderer");
  driver.outcome = "completed";
  driver.result.resolve("done");
  assert.equal(await running, "done");
  assert.equal(calls, 1);
});

test("Agent adapter runs a real Agent task through the shared runtime", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-runtime-agent-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const provider: ModelProvider = {
    complete: async () => ({ text: "finished through runtime", toolCalls: [], raw: {} }),
  };
  const runtime = new XiuRuntime();
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, autoApprove: true },
    provider,
    [],
    (request) => runtime.requestApproval(request),
    runtime.agentEvents(),
  );
  runtime.attachDriver(new AgentRuntimeAdapter(agent));
  assert.equal(await runtime.createTask("answer once"), "finished through runtime");
  assert.equal(runtime.snapshot().task?.state, "completed");
  assert.ok(runtime.connect(0).events.some((event) => event.type === "assistant.message"));
});
