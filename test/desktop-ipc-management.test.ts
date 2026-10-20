import assert from "node:assert/strict";
import test from "node:test";
import { managementIpcChannels, registerManagementIpc, type ManagementIpcContext } from "../apps/desktop/main/ipc-management.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };

function harness(options: { workspace?: string; terminalRunning?: boolean; chosen?: string } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  // Function arguments (the Skill source chooser) are invoked so the recorded call shows what they resolve to.
  const record = (name: string) => async (...args: unknown[]) => {
    const shown = await Promise.all(args.map(async (arg) => typeof arg === "function" ? `fn(${JSON.stringify(await (arg as () => Promise<unknown>)())})` : JSON.stringify(arg)));
    calls.push(`tasks.${name}:${shown.join(",")}`);
    return { ok: name };
  };
  const ctx: ManagementIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    serializeWriterStart: async (operation) => { calls.push("writer"); return operation(); },
    trustedWorkspacePath: () => { calls.push("workspace"); if (!options.workspace) throw new Error("no trusted workspace"); return options.workspace; },
    tasks: {
      manageMcp: record("manageMcp"), browseMcp: record("browseMcp"), mcpSnapshot: record("mcpSnapshot"), changeMcp: record("changeMcp"),
      managementSnapshot: record("managementSnapshot"), prepareSkillInstallation: record("prepareSkillInstallation"), cancelSkillInstallation: record("cancelSkillInstallation"),
      taskDiagnostics: record("taskDiagnostics"), changeManagement: record("changeManagement"), pluginSnapshot: record("pluginSnapshot"), changePlugin: record("changePlugin"),
    } as never,
    terminalRunning: (workspace) => { calls.push(`terminal:${workspace}`); return options.terminalRunning === true; },
    chooseSkillSource: async (sourceKind) => { calls.push(`choose:${sourceKind}`); return options.chosen; },
  };
  registerManagementIpc(ctx);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke };
}

test("the management panel registers exactly its channels and every handler refuses an untrusted sender first", async () => {
  const { calls, handlers, invoke } = harness({ workspace: "/ws" });
  assert.deepEqual([...handlers.keys()].sort(), [...managementIpcChannels].sort());
  assert.equal(handlers.size, 14);
  for (const channel of managementIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, { action: "reload" }), /untrusted sender/, channel);
    assert.deepEqual(calls.filter((call) => call.startsWith("tasks.") || call.startsWith("choose")), [], `${channel} touched state for an untrusted sender`);
  }
});

test("reads go straight to the controller while writes wait for the writer queue and a closed terminal", async () => {
  const { calls, invoke } = harness({ workspace: "/ws" });
  for (const [channel, method] of [[desktopChannels.mcpSnapshot, "mcpSnapshot"], [desktopChannels.managementSnapshot, "managementSnapshot"], [desktopChannels.pluginSnapshot, "pluginSnapshot"], [desktopChannels.taskDiagnostics, "taskDiagnostics"], [desktopChannels.skillCancel, "cancelSkillInstallation"]] as const) {
    calls.length = 0;
    assert.deepEqual(await invoke(channel, trusted), { ok: method });
    assert.deepEqual(calls, ["trust", "workspace", `tasks.${method}:"/ws"`], channel);
  }
  // Configuration and plugin changes queue first and check the sender inside the queued operation;
  // MCP browsing checks the sender before queueing. Both orders existed inline and are preserved.
  for (const [channel, method, request, order] of [
    [desktopChannels.managementChange, "changeManagement", { kind: "web", enabled: true }, ["writer", "trust"]],
    [desktopChannels.pluginChange, "changePlugin", { action: "enable", id: "demo" }, ["writer", "trust"]],
    [desktopChannels.mcpBrowse, "browseMcp", { server: "docs", kind: "resources" }, ["trust", "writer"]],
  ] as const) {
    calls.length = 0;
    assert.deepEqual(await invoke(channel, trusted, request), { ok: method });
    assert.deepEqual(calls, [...order, "workspace", "terminal:/ws", `tasks.${method}:"/ws",${JSON.stringify(request)}`], channel);
  }
  const busy = harness({ workspace: "/ws", terminalRunning: true });
  await assert.rejects(() => busy.invoke(desktopChannels.managementChange, trusted, { kind: "web" }), /请先关闭交互终端，再更改配置/);
  await assert.rejects(() => busy.invoke(desktopChannels.pluginChange, trusted, { action: "enable" }), /请先关闭交互终端，再更改插件/);
  await assert.rejects(() => busy.invoke(desktopChannels.mcpBrowse, trusted, { server: "docs" }), /请先关闭终端，再读取 MCP 内容/);
  assert.ok(!busy.calls.some((call) => call.startsWith("tasks.")), "a running terminal blocks every write before the controller is reached");
});

test("MCP OAuth decisions bypass the writer queue and connection changes map to their action", async () => {
  const { calls, invoke } = harness({ workspace: "/ws", terminalRunning: true });
  for (const action of ["oauth-decision", "oauth-cancel"]) {
    calls.length = 0;
    assert.deepEqual(await invoke(desktopChannels.mcpManage, trusted, { action, server: "docs" }), { ok: "manageMcp" });
    assert.deepEqual(calls, ["trust", "workspace", `tasks.manageMcp:"/ws",${JSON.stringify({ action, server: "docs" })}`], `${action} must not wait behind a long connection operation or the terminal check`);
  }
  await assert.rejects(() => invoke(desktopChannels.mcpManage, trusted, { action: "add", server: "docs" }), /请先关闭终端，再管理 MCP/);
  const idle = harness({ workspace: "/ws" });
  assert.deepEqual(await idle.invoke(desktopChannels.mcpManage, trusted, { action: "add", server: "docs" }), { ok: "manageMcp" });
  assert.deepEqual(idle.calls, ["trust", "writer", "workspace", "terminal:/ws", 'tasks.manageMcp:"/ws",{"action":"add","server":"docs"}']);
  for (const [channel, action] of [[desktopChannels.mcpReload, "reload"], [desktopChannels.mcpDisconnect, "disconnect"], [desktopChannels.mcpApprove, "approve"]] as const) {
    idle.calls.length = 0;
    assert.deepEqual(await idle.invoke(channel, trusted, { server: "docs" }), { ok: "changeMcp" });
    assert.deepEqual(idle.calls, ["trust", "writer", "workspace", "terminal:/ws", `tasks.changeMcp:"/ws","${action}",{"server":"docs"}`], channel);
    await assert.rejects(() => harness({ workspace: "/ws", terminalRunning: true }).invoke(channel, trusted), /请先关闭交互终端，再更改 MCP 连接/);
  }
});

test("Skill installation asks the native chooser only for a valid local source and passes remote URLs through", async () => {
  const local = harness({ workspace: "/ws", chosen: "/home/me/skill" });
  assert.deepEqual(await local.invoke(desktopChannels.skillPrepare, trusted), { ok: "prepareSkillInstallation" });
  assert.deepEqual(local.calls, ["writer", "trust", "workspace", "terminal:/ws", "choose:directory", 'tasks.prepareSkillInstallation:"/ws",fn("/home/me/skill")']);
  local.calls.length = 0;
  await local.invoke(desktopChannels.skillPrepare, trusted, "file");
  assert.ok(local.calls.includes("choose:file"));
  const cancelled = harness({ workspace: "/ws" });
  await cancelled.invoke(desktopChannels.skillPrepare, trusted, "directory");
  assert.ok(cancelled.calls.includes('tasks.prepareSkillInstallation:"/ws",fn(undefined)'), "a cancelled chooser resolves undefined for the controller to treat as no-op");
  const bad = harness({ workspace: "/ws" });
  await assert.rejects(() => bad.invoke(desktopChannels.skillPrepare, trusted, "zip"), /无效的技能导入方式/);
  assert.ok(!bad.calls.some((call) => call.startsWith("choose") || call.startsWith("tasks.")));
  const busy = harness({ workspace: "/ws", terminalRunning: true });
  await assert.rejects(() => busy.invoke(desktopChannels.skillPrepare, trusted), /请先关闭交互终端/);
  await assert.rejects(() => busy.invoke(desktopChannels.skillPrepareRemote, trusted, { url: "https://example.com/skill.git" }), /请先关闭交互终端/);
  const remote = harness({ workspace: "/ws" });
  assert.deepEqual(await remote.invoke(desktopChannels.skillPrepareRemote, trusted, { url: "https://example.com/skill.git" }), { ok: "prepareSkillInstallation" });
  assert.deepEqual(remote.calls, ["writer", "trust", "workspace", "terminal:/ws", 'tasks.prepareSkillInstallation:"/ws",fn("https://example.com/skill.git"),"remote"']);
  assert.ok(!remote.calls.some((call) => call.startsWith("choose")), "a remote install never opens the file chooser");
});
