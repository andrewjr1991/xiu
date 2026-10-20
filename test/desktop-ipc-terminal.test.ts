import assert from "node:assert/strict";
import test from "node:test";
import { registerTerminalIpc, terminalIpcChannels, type TerminalIpcContext } from "../apps/desktop/main/ipc-terminal.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };

function harness(options: { workspace?: string; terminalBlocked?: string } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  const record = (name: string) => (...args: unknown[]) => { calls.push(`terminals.${name}:${args.map((arg) => JSON.stringify(arg)).join(",")}`); return { ok: name }; };
  const ctx: TerminalIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    serializeWriterStart: async (operation) => { calls.push("writer"); return operation(); },
    trustedWorkspacePath: () => { calls.push("workspace"); if (!options.workspace) throw new Error("no trusted workspace"); return options.workspace; },
    tasks: { assertCanUseTerminal: async (workspace) => { calls.push(`canUse:${workspace}`); if (options.terminalBlocked) throw new Error(options.terminalBlocked); } },
    terminals: { snapshot: record("snapshot"), start: record("start"), write: record("write"), resize: record("resize"), stop: record("stop") } as never,
  };
  registerTerminalIpc(ctx);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke };
}

test("the terminal channels register exactly once and every handler refuses an untrusted sender before touching the terminal", async () => {
  const { calls, handlers, invoke } = harness({ workspace: "/ws" });
  assert.deepEqual([...handlers.keys()].sort(), [...terminalIpcChannels].sort());
  assert.equal(handlers.size, 5);
  for (const channel of terminalIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, { sessionId: "s1", data: "ls\n" }), /untrusted sender/, channel);
    assert.deepEqual(calls, ["trust"], `${channel} touched state for an untrusted sender`);
  }
});

test("snapshot, write, resize and stop resolve the trusted workspace and go straight to the terminal controller", async () => {
  const { calls, invoke } = harness({ workspace: "/ws" });
  assert.deepEqual(await invoke(desktopChannels.terminalSnapshot, trusted), { ok: "snapshot" });
  assert.deepEqual(calls, ["trust", "workspace", 'terminals.snapshot:"/ws"']);
  calls.length = 0;
  assert.equal(await invoke(desktopChannels.terminalWrite, trusted, { sessionId: "s1", data: "ls\n" }), undefined);
  assert.deepEqual(calls, ["trust", "workspace", 'terminals.write:"/ws",{"sessionId":"s1","data":"ls\\n"}']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.terminalResize, trusted, { sessionId: "s1", cols: 120, rows: 40 }), { ok: "resize" });
  assert.deepEqual(calls, ["trust", "workspace", 'terminals.resize:"/ws",{"sessionId":"s1","cols":120,"rows":40}']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.terminalStop, trusted, { sessionId: "s1" }), { ok: "stop" });
  assert.deepEqual(calls, ["trust", "workspace", 'terminals.stop:"/ws","s1"']);
});

test("starting a terminal waits for the writer queue and the task controller's terminal check, and a blocked check never starts a session", async () => {
  const allowed = harness({ workspace: "/ws" });
  assert.deepEqual(await allowed.invoke(desktopChannels.terminalStart, trusted, { cwd: "src" }), { ok: "start" });
  assert.deepEqual(allowed.calls, ["trust", "writer", "workspace", "canUse:/ws", 'terminals.start:"/ws",{"cwd":"src"}']);

  const blocked = harness({ workspace: "/ws", terminalBlocked: "任务仍在运行，终端不可用。" });
  await assert.rejects(() => blocked.invoke(desktopChannels.terminalStart, trusted), /任务仍在运行/);
  assert.deepEqual(blocked.calls, ["trust", "writer", "workspace", "canUse:/ws"]);
});

test("without a trusted workspace every handler fails before reaching the terminal controller", async () => {
  const { calls, invoke } = harness({});
  for (const channel of terminalIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, trusted, { sessionId: "s1" }), /no trusted workspace/, channel);
    assert.equal(calls.some((call) => call.startsWith("terminals.")), false, channel);
  }
});
