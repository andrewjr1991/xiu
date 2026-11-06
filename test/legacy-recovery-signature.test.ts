import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { AgentRuntimeAdapter } from "../src/runtime/agent-adapter.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { Agent } from "../src/agent.js";
import { loadSession } from "../src/session.js";
import { TaskRunJournal, recoveryContinuation, taskOperationSignature, type TaskRunRecord, type TaskSideEffect } from "../src/task-run.js";
import type { AgentTool } from "../src/types.js";

type Risk = "read" | "write" | "execute" | "dangerous";
interface Case { label: string; effect: TaskSideEffect; risk: Risk; changes?: boolean; status?: "unknown" | "started" | "succeeded"; signature?: "empty" | "opaque" | "known"; calls: number; full?: boolean }
async function fixture(t: test.TestContext, c: Case) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-legacy-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), journalRoot = path.join(root, "runs");
  await fs.mkdir(cwd);
  const journal = new TaskRunJournal(cwd, journalRoot);
  const run = await journal.begin({ sessionId: "old", task: "old", providerId: "offline", model: "offline" });
  await journal.beginOperation({ kind: "tool", name: "prior", sideEffect: c.effect, signature: taskOperationSignature("prior", { path: "prior" }) });
  await journal.pause("fixture pause");
  const file = path.join(journalRoot, journal.workspaceId, `${run.runId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as TaskRunRecord;
  const operation = record.operations[0]!;
  operation.status = c.status ?? "unknown";
  if (c.signature === "empty") operation.signature = "";
  else if (c.signature === "opaque") operation.signature = "old-opaque-signature";
  else if (c.signature !== "known") delete operation.signature;
  await fs.writeFile(file, JSON.stringify(record) + "\n");
  const next = new TaskRunJournal(cwd, journalRoot), restored = await next.interrupted();
  assert.ok(restored);
  return { cwd, next, restored };
}
function agentFixture(f: Awaited<ReturnType<typeof fixture>>, c: Case) {
  let calls = 0, turn = 0;
  const tool: AgentTool = { name: "next", description: "fixture", inputSchema: { type: "object", properties: {} }, risk: c.risk,
    changesWorkspace: c.changes ?? false, describe: () => "fixture", execute: async () => { calls++; return "fixture result"; } };
  const agent = new Agent({ config: { cwd: f.cwd, provider: "openai", providerId: "offline", model: "offline", autoApprove: true },
    provider: { async complete() { return turn++ === 0 ? { text: "", toolCalls: [{ id: "call", name: "next", input: { path: "different" } }], raw: {} }
      : { text: "done", toolCalls: [], raw: {} }; } }, tools: [tool], approve: async () => true, taskRunJournal: f.next });
  if (c.full) agent.setAccessMode("full");
  return { agent, calls: () => calls, resetProvider: () => { turn = 0; } };
}
const cases: Case[] = [
  { label: "workspace effect", effect: "workspace", risk: "write", changes: true, calls: 0 },
  { label: "external effect", effect: "external", risk: "write", calls: 0 },
  { label: "process effect", effect: "process", risk: "execute", calls: 0 },
  { label: "unknown effect under Full Access", effect: "unknown", risk: "dangerous", full: true, calls: 0 },
  { label: "successful effect", effect: "workspace", status: "succeeded", risk: "write", changes: true, calls: 0 },
  { label: "started effect", effect: "workspace", status: "started", risk: "write", changes: true, calls: 0 },
  { label: "empty signature", effect: "workspace", signature: "empty", risk: "write", changes: true, calls: 0 },
  { label: "unrecognized signature", effect: "workspace", signature: "opaque", risk: "write", changes: true, calls: 0 },
  { label: "workspace-changing read tag", effect: "workspace", risk: "read", changes: true, calls: 0 },
  { label: "readonly inspection", effect: "workspace", risk: "read", calls: 1 },
  { label: "only readonly history", effect: "none", risk: "write", changes: true, calls: 1 },
  { label: "identified distinct operation", effect: "workspace", signature: "known", risk: "write", changes: true, calls: 1 },
];
for (const c of cases) {
  test(`legacy recovery signature boundary: ${c.label}`, async (t) => {
    const f = await fixture(t, c), state = agentFixture(f, c);
    if (c.signature !== "known" && c.effect !== "none") {
      assert.match(f.restored.recommendation, /usable.*signature/);
      assert.match(recoveryContinuation(f.restored, "en-US"), /read-only tools/);
      assert.match(recoveryContinuation(f.restored, "zh-CN"), /只读工具/);
    }
    state.agent.setRecoverySource(f.restored);
    await state.agent.run("Inspect the prior outcome before deciding what to do next.");
    assert.equal(state.calls(), c.calls);
    if (!c.calls) {
      const history = await loadSession(f.cwd, state.agent.status().sessionId);
      assert.ok(history.messages.some((message) => message.role === "tool" && /usable.*signature/.test(message.content)));
    }
  });
}

test("explicitly clearing abandoned recovery state does not retain a stale inspection-only restriction", async (t) => {
  const c: Case = { label: "reset", effect: "workspace", risk: "write", changes: true, calls: 1 };
  const f = await fixture(t, c), state = agentFixture(f, c);
  state.agent.setRecoverySource(f.restored);
  await f.next.abandon(f.restored.runId, "fixture explicit abandon");
  state.agent.setRecoverySource(undefined);
  await state.agent.run("Explicit new task after abandonment.");
  assert.equal(state.calls(), 1);
});

test("ending a restricted recovery does not restrict a later explicit new task", async (t) => {
  const c: Case = { label: "next task", effect: "workspace", risk: "write", changes: true, calls: 0 };
  const f = await fixture(t, c), state = agentFixture(f, c);
  state.agent.setRecoverySource(f.restored);
  await state.agent.run("Inspection recovery.");
  assert.equal(state.calls(), 0);
  state.resetProvider();
  await state.agent.run("Explicit next task.");
  assert.equal(state.calls(), 1);
});


async function controllerFixture(f: Awaited<ReturnType<typeof fixture>>, state: ReturnType<typeof agentFixture>) {
  const runtime = new XiuRuntime();
  runtime.attachDriver(new AgentRuntimeAdapter(state.agent));
  runtime.recordRecovery({ runId: f.restored.runId, status: "paused", interruptedOperations: f.restored.interruptedOperations.length,
    unknownSideEffects: f.restored.pendingSideEffects.length, recommendation: f.restored.recommendation });
  const controller = new DesktopTaskController(() => {}, async () => ({ agent: state.agent, runtime, journal: f.next,
    provider: { id: "offline", label: "Offline", model: "offline" } }));
  await controller.connect(f.cwd);
  return { controller, runtime };
}

test("desktop explicit abandonment clears an attached legacy recovery before a new task", async (t) => {
  const c: Case = { label: "desktop reset", effect: "workspace", risk: "write", changes: true, calls: 1 };
  const f = await fixture(t, c), state = agentFixture(f, c);
  state.agent.setRecoverySource(f.restored); // A preflight stopped after attaching recovery, before task launch.
  const { controller, runtime } = await controllerFixture(f, state);
  await controller.abandonRecovery(f.cwd, { runId: f.restored.runId }, true);
  await controller.createTask(f.cwd, "Explicit new task after abandonment.");
  const deadline = Date.now() + 10000;
  while (["running", "waiting_approval", "stopping"].includes(runtime.snapshot().task?.state ?? "")) {
    assert.ok(Date.now() < deadline, "offline task must finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(state.calls(), 1);
  const created = (await f.next.recent()).find((record) => record.runId !== f.restored.runId);
  assert.ok(created);
  assert.equal(created.resumedFrom, undefined);
  await controller.reviewSnapshot(f.cwd);
  controller.detach();
});

test("failed desktop abandonment keeps the attached recovery decision and inspection boundary", async (t) => {
  const c: Case = { label: "desktop failed reset", effect: "workspace", risk: "write", changes: true, calls: 0 };
  const f = await fixture(t, c), state = agentFixture(f, c);
  state.agent.setRecoverySource(f.restored);
  const { controller } = await controllerFixture(f, state);
  const abandon = f.next.abandon.bind(f.next);
  f.next.abandon = async () => { throw Object.assign(new Error("fixture write failure"), { code: "EACCES" }); };
  await assert.rejects(controller.abandonRecovery(f.cwd, { runId: f.restored.runId }, true), /fixture write failure/);
  f.next.abandon = abandon;
  assert.equal((await f.next.read(f.restored.runId))?.status, "paused");
  await state.agent.run("Continue the explicitly attached inspection recovery.");
  assert.equal(state.calls(), 0);
  controller.detach();
});

test("inspection-only recovery guidance retains the categorical no-automatic-replay warning", async (t) => {
  const c: Case = { label: "guidance", effect: "workspace", risk: "write", changes: true, calls: 0 };
  const f = await fixture(t, c);
  assert.match(f.restored.recommendation, /Never replay unknown operations automatically\./);
  assert.match(f.restored.recommendation, /read-only tools/);
});
