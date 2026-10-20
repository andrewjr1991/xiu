import assert from "node:assert/strict";
import test from "node:test";
import { registerWorkspaceIpc, workspaceIpcChannels, type WorkspaceIpcContext } from "../apps/desktop/main/ipc-workspace.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };

function harness(options: { taskRunning?: boolean; chosen?: string; current?: string; recent?: string[] } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  const snapshot = () => ({ workspace: options.current ? { id: options.current } : undefined, recent: (options.recent ?? []).map((id) => ({ id })) });
  const record = (name: string) => async (...args: unknown[]) => { calls.push(`${name}:${args.map((arg) => JSON.stringify(arg)).join(",")}`); return { ok: name }; };
  const ctx: WorkspaceIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    serializeWriterStart: async (operation) => { calls.push("writer"); return operation(); },
    workspaces: {
      snapshot: async () => { calls.push("snapshot"); return snapshot() as never; },
      selectWorkspace: record("select"), clearSelection: record("clear"), openRecent: record("openRecent"), removeRecent: record("removeRecent"), trustCurrent: record("trust-current"),
    } as never,
    tasks: { canChangeWorkspace: () => { calls.push("canChange"); return options.taskRunning !== true; }, detach: () => { calls.push("detach"); } },
    terminals: { stopAll: (message) => { calls.push(`stopAll:${message}`); } },
    providerRecovery: { invalidateContext: () => { calls.push("invalidate"); } },
    chooseWorkspaceDirectory: async () => { calls.push("choose"); return options.chosen; },
    emitSnapshot: (value) => { calls.push("emit"); return value; },
  };
  registerWorkspaceIpc(ctx);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke };
}

test("the workspace channels register exactly once and every handler refuses an untrusted sender before touching state", async () => {
  const { calls, handlers, invoke } = harness({ chosen: "/other" });
  assert.deepEqual([...handlers.keys()].sort(), [...workspaceIpcChannels].sort());
  assert.equal(handlers.size, 6);
  for (const channel of workspaceIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, { workspaceId: "w1", confirmed: true }), /untrusted sender/, channel);
    assert.deepEqual(calls.filter((call) => !["trust", "writer"].includes(call)), [], `${channel} touched state for an untrusted sender`);
  }
});

test("switching workspaces stops terminals and detaches the task controller first, and a cancelled picker only re-reads the snapshot", async () => {
  const picked = harness({ chosen: "/picked" });
  assert.deepEqual(await picked.invoke(desktopChannels.chooseWorkspace, trusted), { ok: "select" });
  assert.deepEqual(picked.calls, ["writer", "trust", "canChange", "choose", "stopAll:工作区已切换，终端会话已关闭。", "detach", 'select:"/picked"', "emit"]);

  const cancelled = harness({});
  assert.deepEqual(await cancelled.invoke(desktopChannels.chooseWorkspace, trusted), { workspace: undefined, recent: [] });
  assert.deepEqual(cancelled.calls, ["writer", "trust", "canChange", "choose", "snapshot"]);

  const recent = harness({});
  assert.deepEqual(await recent.invoke(desktopChannels.openRecentWorkspace, trusted, { workspaceId: "w2" }), { ok: "openRecent" });
  assert.deepEqual(recent.calls, ["writer", "trust", "stopAll:工作区已切换，终端会话已关闭。", "detach", 'openRecent:{"workspaceId":"w2"}', "emit"]);

  const closed = harness({});
  assert.deepEqual(await closed.invoke(desktopChannels.closeWorkspace, trusted), { ok: "clear" });
  assert.deepEqual(closed.calls, ["writer", "trust", "stopAll:工作区已关闭，终端会话已结束。", "detach", "clear:", "emit"]);
});

test("a running task blocks choosing a workspace before the picker opens", async () => {
  const { calls, invoke } = harness({ taskRunning: true, chosen: "/picked" });
  await assert.rejects(() => invoke(desktopChannels.chooseWorkspace, trusted), /任务仍在运行/);
  assert.deepEqual(calls, ["writer", "trust", "canChange"]);
});

test("removing a recent workspace needs an existing entry and explicit confirmation, and only the current one is detached", async () => {
  const missing = harness({ recent: ["w1"] });
  await assert.rejects(() => missing.invoke(desktopChannels.removeRecentWorkspace, trusted, { workspaceId: "w9", confirmed: true }), /最近项目不存在/);
  const unconfirmed = harness({ recent: ["w1"] });
  await assert.rejects(() => unconfirmed.invoke(desktopChannels.removeRecentWorkspace, trusted, { workspaceId: "w1" }), /需要明确确认/);
  assert.equal(unconfirmed.calls.includes("detach"), false);

  const other = harness({ recent: ["w1", "w2"], current: "w2" });
  assert.deepEqual(await other.invoke(desktopChannels.removeRecentWorkspace, trusted, { workspaceId: "w1", confirmed: true }), { ok: "removeRecent" });
  assert.deepEqual(other.calls, ["writer", "trust", "snapshot", 'removeRecent:{"workspaceId":"w1","confirmed":true},true', "emit"]);

  const current = harness({ recent: ["w1"], current: "w1" });
  assert.deepEqual(await current.invoke(desktopChannels.removeRecentWorkspace, trusted, { workspaceId: "w1", confirmed: true }), { ok: "removeRecent" });
  assert.deepEqual(current.calls, ["writer", "trust", "snapshot", "canChange", "stopAll:工作区已移除，终端会话已关闭。", "detach", 'removeRecent:{"workspaceId":"w1","confirmed":true},true', "emit"]);

  const busy = harness({ recent: ["w1"], current: "w1", taskRunning: true });
  await assert.rejects(() => busy.invoke(desktopChannels.removeRecentWorkspace, trusted, { workspaceId: "w1", confirmed: true }), /任务仍在运行/);
  assert.equal(busy.calls.includes("detach"), false);
});

test("trusting the current workspace invalidates the provider recovery context before emitting the new snapshot", async () => {
  const { calls, invoke } = harness({});
  assert.deepEqual(await invoke(desktopChannels.trustWorkspace, trusted, { trusted: true }), { ok: "trust-current" });
  assert.deepEqual(calls, ["trust", "invalidate", 'trust-current:{"trusted":true}', "emit"]);
});
