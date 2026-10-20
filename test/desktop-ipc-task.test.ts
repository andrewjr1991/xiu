import assert from "node:assert/strict";
import test from "node:test";
import { registerTaskIpc, taskIpcChannels, type TaskIpcContext } from "../apps/desktop/main/ipc-task.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };

function harness(options: { workspace?: string; terminalRunning?: boolean; confirm?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  // Function arguments (the confirmation callbacks) are invoked so the recorded call shows what they resolve to.
  const record = (name: string) => async (...args: unknown[]) => {
    const shown = await Promise.all(args.map(async (arg) => typeof arg === "function" ? `fn(${JSON.stringify(await (arg as () => Promise<unknown>)())})` : JSON.stringify(arg)));
    calls.push(`tasks.${name}:${shown.join(",")}`);
    return { ok: name };
  };
  const ctx: TaskIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    serializeWriterStart: async (operation) => { calls.push("writer"); return operation(); },
    trustedWorkspacePath: () => { calls.push("workspace"); if (!options.workspace) throw new Error("no trusted workspace"); return options.workspace; },
    tasks: {
      connect: record("connect"), createTask: record("createTask"), continueTask: record("continueTask"), newConversation: record("newConversation"), steerTask: record("steerTask"), stopTask: record("stopTask"),
      setPlanMode: record("setPlanMode"), setApprovalMode: record("setApprovalMode"), decideApproval: record("decideApproval"), computerAcceptance: record("computerAcceptance"), cancelSubagent: record("cancelSubagent"), deleteTask: record("deleteTask"),
    } as never,
    terminalRunning: (workspace) => { calls.push(`terminal:${workspace}`); return options.terminalRunning === true; },
    stopComputerUse: () => { calls.push("stopComputerUse"); },
    workspaceSnapshot: async () => { calls.push("snapshot"); return { fresh: true } as never; },
    emitSnapshot: (value) => { calls.push("emit"); return value; },
    confirmFullAccess: async () => { calls.push("confirm:full-access"); return options.confirm === true; },
    confirmComputerAcceptance: async (request) => { calls.push(`confirm:acceptance:${request.decision}`); return options.confirm === true; },
    confirmSubagentCancel: async () => { calls.push("confirm:subagent"); return options.confirm === true; },
  };
  registerTaskIpc(ctx);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke };
}

test("the task session registers exactly its channels and every handler refuses an untrusted sender before touching state", async () => {
  const { calls, handlers, invoke } = harness({ workspace: "/ws", confirm: true });
  assert.deepEqual([...handlers.keys()].sort(), [...taskIpcChannels].sort());
  assert.equal(handlers.size, 12);
  for (const channel of taskIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, { text: "hi", taskId: "t1", confirmed: true }), /untrusted sender/, channel);
    assert.deepEqual(calls, ["trust"], `${channel} touched state for an untrusted sender`);
  }
});

test("connecting to the runtime validates the resume sequence before touching the controller", async () => {
  const { calls, invoke } = harness({ workspace: "/ws" });
  assert.deepEqual(await invoke(desktopChannels.runtimeConnect, trusted), { ok: "connect" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.connect:"/ws",']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.runtimeConnect, trusted, { afterSequence: 42 }), { ok: "connect" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.connect:"/ws",42']);
  for (const afterSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", Number.NaN]) {
    calls.length = 0;
    await assert.rejects(() => invoke(desktopChannels.runtimeConnect, trusted, { afterSequence }), /Invalid runtime sequence/, String(afterSequence));
    assert.deepEqual(calls, ["trust"], String(afterSequence));
  }
});

test("starting, continuing and switching Plan mode queue behind the writer and refuse while the terminal holds the workspace", async () => {
  const free = harness({ workspace: "/ws" });
  assert.deepEqual(await free.invoke(desktopChannels.taskCreate, trusted, { text: "do it", answerTo: { taskId: "t1", questionId: "q1" } }), { ok: "createTask" });
  assert.deepEqual(free.calls, ["trust", "writer", "workspace", "terminal:/ws", 'tasks.createTask:"/ws","do it",{"taskId":"t1","questionId":"q1"}']);
  free.calls.length = 0;
  assert.deepEqual(await free.invoke(desktopChannels.taskContinue, trusted, { taskId: "t1", text: "more" }), { ok: "continueTask" });
  assert.deepEqual(free.calls, ["trust", "writer", "workspace", "terminal:/ws", 'tasks.continueTask:"/ws","t1","more"']);
  free.calls.length = 0;
  assert.deepEqual(await free.invoke(desktopChannels.planModeSet, trusted, { enabled: true }), { ok: "setPlanMode" });
  // Any controlled computer-use session stops before the mode flips.
  assert.deepEqual(free.calls, ["trust", "writer", "workspace", "terminal:/ws", "stopComputerUse", 'tasks.setPlanMode:"/ws",{"enabled":true}']);
  free.calls.length = 0;
  assert.deepEqual(await free.invoke(desktopChannels.conversationNew, trusted), { ok: "newConversation" });
  assert.deepEqual(free.calls, ["trust", "writer", "workspace", 'tasks.newConversation:"/ws"']);

  const busy = harness({ workspace: "/ws", terminalRunning: true });
  for (const [channel, message] of [
    [desktopChannels.taskCreate, "交互终端仍在运行。请先关闭终端，再启动 Agent 任务。"],
    [desktopChannels.taskContinue, "交互终端仍在运行。请先关闭终端，再继续 Agent 任务。"],
    [desktopChannels.planModeSet, "交互终端仍在运行，请先关闭终端再切换 Plan 模式。"],
  ] as const) {
    busy.calls.length = 0;
    await assert.rejects(() => busy.invoke(channel, trusted, { text: "x", taskId: "t1", enabled: true }), (error: Error) => error.message === message, channel);
    assert.deepEqual(busy.calls, ["trust", "writer", "workspace", "terminal:/ws"], channel);
  }
});

test("steering, stopping and approval decisions bypass the writer queue", async () => {
  const { calls, invoke } = harness({ workspace: "/ws" });
  assert.deepEqual(await invoke(desktopChannels.taskSteer, trusted, { text: "turn left" }), { ok: "steerTask" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.steerTask:"/ws","turn left"']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.taskStop, trusted), { ok: "stopTask" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.stopTask:"/ws"']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.approvalDecide, trusted, { approvalId: "a1", decision: "approve" }), { ok: "decideApproval" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.decideApproval:"/ws",{"approvalId":"a1","decision":"approve"}']);
});

test("Full Access, computer acceptance and subagent cancel hand the native confirmation to the controller instead of deciding themselves", async () => {
  const accepted = harness({ workspace: "/ws", confirm: true });
  assert.deepEqual(await accepted.invoke(desktopChannels.approvalModeSet, trusted, { mode: "full-access" }), { ok: "setApprovalMode" });
  assert.deepEqual(accepted.calls, ["trust", "workspace", "confirm:full-access", 'tasks.setApprovalMode:"/ws",{"mode":"full-access"},fn(true)']);
  accepted.calls.length = 0;
  assert.deepEqual(await accepted.invoke(desktopChannels.computerAcceptance, trusted, { taskId: "t1", decision: "rejected" }), { ok: "computerAcceptance" });
  assert.deepEqual(accepted.calls, ["trust", "workspace", "confirm:acceptance:rejected", 'tasks.computerAcceptance:"/ws",{"taskId":"t1","decision":"rejected"},fn(true)']);
  accepted.calls.length = 0;
  assert.deepEqual(await accepted.invoke(desktopChannels.subagentCancel, trusted, { runId: "r1", taskId: "t2", parentTaskId: "t1" }), { ok: "cancelSubagent" });
  assert.deepEqual(accepted.calls, ["trust", "writer", "workspace", "confirm:subagent", 'tasks.cancelSubagent:"/ws",{"runId":"r1","taskId":"t2","parentTaskId":"t1"},fn(true)']);

  const declined = harness({ workspace: "/ws", confirm: false });
  await declined.invoke(desktopChannels.approvalModeSet, trusted, { mode: "full-access" });
  assert.equal(declined.calls.at(-1), 'tasks.setApprovalMode:"/ws",{"mode":"full-access"},fn(false)');
});

test("deleting a task needs explicit confirmation and then emits a fresh workspace snapshot", async () => {
  const { calls, invoke } = harness({ workspace: "/ws" });
  await assert.rejects(() => invoke(desktopChannels.taskDelete, trusted, { taskId: "t1" }), /删除任务需要明确确认/);
  assert.deepEqual(calls, ["trust", "writer", "workspace"]);
  calls.length = 0;
  await assert.rejects(() => invoke(desktopChannels.taskDelete, trusted, { taskId: "t1", confirmed: "yes" }), /删除任务需要明确确认/);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.taskDelete, trusted, { taskId: "t1", confirmed: true }), { fresh: true });
  assert.deepEqual(calls, ["trust", "writer", "workspace", 'tasks.deleteTask:"/ws",{"taskId":"t1","confirmed":true},true', "snapshot", "emit"]);
});
