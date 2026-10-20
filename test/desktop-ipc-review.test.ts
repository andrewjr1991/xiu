import assert from "node:assert/strict";
import test from "node:test";
import { registerReviewIpc, reviewIpcChannels, type ReviewIpcContext, type ReviewIpcIo } from "../apps/desktop/main/ipc-review.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };

function harness(options: { workspace?: string; terminalRunning?: boolean; confirm?: boolean; recoveryRunId?: string; switchWorkspaceAfterHistory?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  let workspaceReads = 0;
  const record = (name: string) => async (...args: unknown[]) => { calls.push(`tasks.${name}:${args.map((arg) => typeof arg === "function" ? "fn" : JSON.stringify(arg)).join(",")}`); return { ok: name }; };
  const ctx: ReviewIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    serializeWriterStart: async (operation) => { calls.push("writer"); return operation(); },
    trustedWorkspacePath: () => {
      calls.push("workspace"); if (!options.workspace) throw new Error("no trusted workspace");
      workspaceReads += 1;
      return options.switchWorkspaceAfterHistory && workspaceReads > 1 ? "/other" : options.workspace;
    },
    tasks: {
      openTaskHistory: async (workspace: string, request: unknown) => { calls.push(`tasks.openTaskHistory:${JSON.stringify(workspace)},${JSON.stringify(request)}`); return { taskId: "t1", attachmentReferences: { m1: ["a.png"] } } as never; },
      reviewSnapshot: async (workspace: string, changeView?: string) => {
        calls.push(`tasks.reviewSnapshot:${JSON.stringify(workspace)},${JSON.stringify(changeView)}`);
        return { recovery: options.recoveryRunId ? { runId: options.recoveryRunId, unknownOperations: ["a", "b", "c"] } : undefined } as never;
      },
      previewFile: record("previewFile"), previewMedia: record("previewMedia"), restoreCheckpoint: record("restoreCheckpoint"), recoverTask: record("recoverTask"), abandonRecovery: record("abandonRecovery"),
    } as never,
    terminalRunning: (workspace) => { calls.push(`terminal:${workspace}`); return options.terminalRunning === true; },
    historyThumbnail: () => "history-thumb",
    previewThumbnail: () => "preview-thumb",
    confirmCheckpointRestore: async (request) => { calls.push(`confirm:checkpoint:${request?.checkpointId}`); return options.confirm === true; },
    confirmRecoveryResume: async (unknownOperations) => { calls.push(`confirm:resume:${unknownOperations}`); return options.confirm === true; },
    confirmRecoveryAbandon: async () => { calls.push("confirm:abandon"); return options.confirm === true; },
  };
  const io: ReviewIpcIo = {
    restoreHistoryAttachments: async (workspace, references, thumbnail) => { calls.push(`restore:${workspace}:${JSON.stringify(references)}:${thumbnail(Buffer.alloc(0))}`); return { m1: [{ name: "a.png" }] } as never; },
  };
  registerReviewIpc(ctx, io);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke };
}

test("the review inspector registers exactly its channels and every handler refuses an untrusted sender before touching state", async () => {
  const { calls, handlers, invoke } = harness({ workspace: "/ws", confirm: true, recoveryRunId: "r1" });
  assert.deepEqual([...handlers.keys()].sort(), [...reviewIpcChannels].sort());
  assert.equal(handlers.size, 7);
  for (const channel of reviewIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, { runId: "r1", checkpointId: "c1" }), /untrusted sender/, channel);
    assert.deepEqual(calls, ["trust"], `${channel} touched state for an untrusted sender`);
  }
});

test("task history restores attachments with the injected thumbnail and refuses to answer after the workspace changed", async () => {
  const same = harness({ workspace: "/ws" });
  assert.deepEqual(await same.invoke(desktopChannels.taskHistoryOpen, trusted, { taskId: "t1" }), { taskId: "t1", attachmentReferences: { m1: ["a.png"] }, attachments: { m1: [{ name: "a.png" }] } });
  assert.deepEqual(same.calls, ["trust", "workspace", 'tasks.openTaskHistory:"/ws",{"taskId":"t1"}', 'restore:/ws:{"m1":["a.png"]}:history-thumb', "workspace"]);

  const switched = harness({ workspace: "/ws", switchWorkspaceAfterHistory: true });
  await assert.rejects(() => switched.invoke(desktopChannels.taskHistoryOpen, trusted, { taskId: "t1" }), /Workspace changed while loading history/);
});

test("review snapshot and previews pass straight through with the trusted workspace and the bounded preview thumbnail", async () => {
  const { calls, invoke } = harness({ workspace: "/ws" });
  await invoke(desktopChannels.reviewSnapshot, trusted, { changeView: "workspace" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.reviewSnapshot:"/ws","workspace"']);
  calls.length = 0;
  await invoke(desktopChannels.reviewSnapshot, trusted);
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.reviewSnapshot:"/ws",undefined']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.filePreview, trusted, { path: "src/a.ts" }), { ok: "previewFile" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.previewFile:"/ws",{"path":"src/a.ts"}']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.mediaPreview, trusted, { path: "a.png" }), { ok: "previewMedia" });
  assert.deepEqual(calls, ["trust", "workspace", 'tasks.previewMedia:"/ws",{"path":"a.png"},fn']);
});

test("checkpoint restore and recovery abandon always ask first and forward the user's answer to the controller", async () => {
  const accepted = harness({ workspace: "/ws", confirm: true });
  assert.deepEqual(await accepted.invoke(desktopChannels.checkpointRestore, trusted, { checkpointId: "c1" }), { ok: "restoreCheckpoint" });
  assert.deepEqual(accepted.calls, ["trust", "confirm:checkpoint:c1", "workspace", 'tasks.restoreCheckpoint:"/ws",{"checkpointId":"c1"},true']);
  accepted.calls.length = 0;
  assert.deepEqual(await accepted.invoke(desktopChannels.recoveryAbandon, trusted, { runId: "r1" }), { ok: "abandonRecovery" });
  assert.deepEqual(accepted.calls, ["trust", "confirm:abandon", "workspace", 'tasks.abandonRecovery:"/ws",{"runId":"r1"},true']);

  const declined = harness({ workspace: "/ws", confirm: false });
  await declined.invoke(desktopChannels.checkpointRestore, trusted, { checkpointId: "c1" });
  assert.equal(declined.calls.at(-1), 'tasks.restoreCheckpoint:"/ws",{"checkpointId":"c1"},false');
  declined.calls.length = 0;
  await declined.invoke(desktopChannels.recoveryAbandon, trusted, { runId: "r1" });
  assert.equal(declined.calls.at(-1), 'tasks.abandonRecovery:"/ws",{"runId":"r1"},false');
});

test("resuming an interrupted task re-reads the workspace review, refuses a stale run, needs a closed terminal and a confirmation", async () => {
  const ok = harness({ workspace: "/ws", confirm: true, recoveryRunId: "r1" });
  assert.deepEqual(await ok.invoke(desktopChannels.recoveryResume, trusted, { runId: "r1" }), { ok: "recoverTask" });
  assert.deepEqual(ok.calls, ["trust", "writer", "workspace", "terminal:/ws", 'tasks.reviewSnapshot:"/ws","workspace"', "confirm:resume:3", 'tasks.recoverTask:"/ws",{"runId":"r1"},true']);

  const stale = harness({ workspace: "/ws", confirm: true, recoveryRunId: "r2" });
  await assert.rejects(() => stale.invoke(desktopChannels.recoveryResume, trusted, { runId: "r1" }), /恢复记录不存在或已经变化/);
  assert.equal(stale.calls.some((call) => call.startsWith("confirm") || call.startsWith("tasks.recoverTask")), false);

  const none = harness({ workspace: "/ws", confirm: true });
  await assert.rejects(() => none.invoke(desktopChannels.recoveryResume, trusted, { runId: "r1" }), /恢复记录不存在或已经变化/);

  const busy = harness({ workspace: "/ws", confirm: true, recoveryRunId: "r1", terminalRunning: true });
  await assert.rejects(() => busy.invoke(desktopChannels.recoveryResume, trusted, { runId: "r1" }), /交互终端仍在运行。请先关闭终端，再恢复 Agent 任务。/);
  assert.deepEqual(busy.calls, ["trust", "writer", "workspace", "terminal:/ws"]);

  const cancelled = harness({ workspace: "/ws", confirm: false, recoveryRunId: "r1" });
  await assert.rejects(() => cancelled.invoke(desktopChannels.recoveryResume, trusted, { runId: "r1" }), /已取消恢复/);
  assert.equal(cancelled.calls.some((call) => call.startsWith("tasks.recoverTask")), false);
});
