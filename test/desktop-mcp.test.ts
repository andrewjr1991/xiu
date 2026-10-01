import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";
import { WorkspaceMcpService } from "../src/runtime/mcp-service.js";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { TaskRunJournal } from "../src/task-run.js";
import { Agent } from "../src/agent.js";
import { TaskPlanManager } from "../src/plan.js";
import type { AgentTool, ModelProvider } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

async function setup(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-mcp-"));
  const file = path.join(root, "user-mcp.json");
  const config = { command: process.execPath, args: [fixture], risk: "read", toolRisks: { change: "dangerous" } };
  const save = (value = config) => fs.writeFile(file, JSON.stringify({ mcpServers: { test: value } }));
  await save();
  const manager = new McpManager(root, file);
  let tools: AgentTool[] = [];
  const service = new WorkspaceMcpService(manager, () => { tools = manager.tools(); });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, config, save, manager, service, tools: () => tools };
}

test("desktop MCP reads without spawning, explicitly grants exact configuration, connects and disconnects real stdio tools", async (t) => {
  const { root, service, tools } = await setup(t);
  const first = (await service.snapshot()).servers[0]!;
  assert.equal(first.state, "permission-required");
  assert.equal(first.tools, 0);
  assert.equal(tools().length, 0);
  assert.equal((await service.reload()).servers[0]?.state, "permission-required");
  await service.approve(first.name, first.fingerprint);
  assert.equal((await service.snapshot()).servers[0]?.state, "disconnected");
  assert.equal(tools().length, 0, "grant is not a connection or tool execution");
  assert.equal((await service.reload()).servers[0]?.state, "connected");
  assert.equal(tools().length, 2);
  assert.equal(await tools()[0]!.execute({ message: "desktop" }, { cwd: root, approve: async () => false }), "echo:desktop");
  await service.close();
  assert.equal(tools().length, 0);
  assert.equal((await service.snapshot()).servers[0]?.state, "disconnected");
});

test("MCP confirmation rejects configuration edits, not only added permissions, in both frontends", async (t) => {
  const { config, save, manager, service } = await setup(t);
  const first = (await service.snapshot()).servers[0]!;
  await save({ ...config, args: [fixture, "changed-target"] });
  await assert.rejects(service.approve(first.name, first.fingerprint), /changed since permission preview/);
  await assert.rejects(manager.approvePermissions(first.name, true, first.fingerprint), /changed since permission preview/);
  const changed = (await service.snapshot()).servers[0]!;
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(changed.approved, false);
  assert.equal(manager.tools().length, 0);
});

test("MCP shutdown waits for in-flight connection setup and leaves no registered tools", async (t) => {
  const { service, manager, tools } = await setup(t);
  await service.approve("test", (await service.snapshot()).servers[0]!.fingerprint);
  const connecting = service.reload();
  const closing = service.close();
  await Promise.all([connecting, closing]);
  assert.equal(tools().length, 0);
  assert.deepEqual(manager.connectedServerNames(), []);
});

test("MCP snapshot never exposes config or credentials and failed reload removes stale tools", async (t) => {
  const { file, config, save, service, tools } = await setup(t);
  const canary = "unusual-mcp-secret-49281";
  await save({ ...config, env: { SECRET: canary } } as typeof config);
  const snapshot = await service.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes(canary));
  assert.ok(!JSON.stringify(snapshot).includes(process.execPath));
  await service.approve("test", snapshot.servers[0]!.fingerprint);
  await service.reload();
  assert.equal(tools().length, 2);
  await fs.writeFile(file, "{invalid");
  await assert.rejects(service.reload());
  assert.equal(tools().length, 0);
});

test("MCP tools use real Agent danger approval and Plan read-only boundaries", async (t) => {
  const { root, service, tools } = await setup(t);
  await service.approve("test", (await service.snapshot()).servers[0]!.fingerprint);
  await service.reload();
  for (const planMode of [false, true]) {
    let calls = 0;
    const approvals: string[] = [];
    const provider: ModelProvider = { async complete(_system, messages) {
      if (++calls === 1) return { text: "try", toolCalls: [{ id: "call", name: "mcp__test__change", input: {} }], raw: {} };
      assert.match(messages.at(-1)?.content ?? "", planMode ? /plan mode is read-only/ : /denied|declined/i);
      return { text: "done", toolCalls: [], raw: {} };
    } };
    const agent = new Agent({ provider: "openai", model: "test", cwd: root, maxTurns: 3, autoApprove: false }, provider, tools(),
      async (request) => { approvals.push(request.risk); return false; }, {}, undefined, undefined, new TaskPlanManager(undefined, planMode));
    assert.equal(await agent.run("test boundary"), "done");
    assert.deepEqual(approvals, planMode ? [] : ["dangerous"]);
  }
});

test("desktop MCP lifecycle drains old host before creating a new workspace host", async (t) => {
  const { root } = await setup(t);
  const order: string[] = [];
  const controller = new DesktopTaskController(() => {}, async (workspace) => {
    order.push(`open:${workspace}`);
    return { runtime: new XiuRuntime(), journal: new TaskRunJournal(workspace, path.join(root, "journals")),
      provider: { id: "test", label: "Test", model: "test" },
      close: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); order.push(`close:${workspace}`); },
    };
  });
  await controller.connect(root);
  controller.detach();
  await controller.connect(path.join(root, "next"));
  assert.deepEqual(order, [`open:${root}`, `close:${root}`, `open:${path.join(root, "next")}`]);
  await controller.shutdown();
  assert.equal(order.at(-1), `close:${path.join(root, "next")}`);
});

test("desktop MCP changes fail closed under external writer lock and malformed confirmation", async (t) => {
  const { root, service } = await setup(t);
  const journal = new TaskRunJournal(root, path.join(root, "journals"));
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime: new XiuRuntime(), mcp: service,
    journal, provider: { id: "test", label: "Test", model: "test" }, close: () => service.close() }));
  const first = (await controller.mcpSnapshot(root)).servers[0]!;
  await assert.rejects(controller.changeMcp(root, "approve", { name: "test", fingerprint: first.fingerprint, confirmed: false } as never), /未完成/);
  assert.equal((await service.snapshot()).servers[0]?.approved, false);
  await journal.begin({ sessionId: "external", task: "external", model: "test", providerId: "openai" });
  await assert.rejects(controller.changeMcp(root, "reload"), /另一个 Xiu 进程/);
  await journal.complete("completed");
  await controller.shutdown();
});
