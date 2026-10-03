import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveNodeRuntime } from "../src/node-runtime.js";
import { resolveStdioLaunch } from "../src/mcp.js";
import { createWorkspaceAgentHost } from "../src/runtime/workspace-agent-host.js";
import { MultiAgentCoordinator } from "../src/multi-agent.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { applyRuntimeEvent } from "../src/runtime/protocol.js";
const profile = { id: "fixture", name: "Fixture", kind: "openai-compatible" as const, model: "mock", features: { tools: true, vision: false, image: false, video: false, audio: false } };

test("desktop Node resolution never launches Electron as npm/Node", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-node-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  Object.defineProperty(process.versions, "electron", { value: "40.0", configurable: true });
  t.after(() => { delete (process.versions as Record<string, string>).electron; });
  await assert.rejects(resolveNodeRuntime({ PATH: "" }), /XIU_NODE_NOT_FOUND/);
  const node = path.join(root, process.platform === "win32" ? "node.exe" : "node");
  await fs.writeFile(node, "fixture");
  assert.equal(await resolveNodeRuntime({ PATH: root }), node);
  if (process.platform !== "win32") return;
  await fs.mkdir(path.join(root, "node_modules", "npm", "bin"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "npm", "bin", "npx-cli.js"), "fixture");
  const launch = await resolveStdioLaunch("npx", ["-y", "example"], { PATH: root });
  assert.equal(launch.command, node);
  assert.notEqual(launch.command, process.execPath);
  assert.deepEqual(launch.args.slice(-2), ["-y", "example"]);
});

test("runtime child status is bounded, redacted and replayable", async () => {
  const runtime = new XiuRuntime({ sanitize: (text) => text.replaceAll("private-canary", "[redacted]") });
  runtime.attachDriver({ run: async () => { runtime.recordSubagent({ id: "run:child", runId: "run", title: "Child", role: "explorer", status: "completed", result: `private-canary${"x".repeat(20_000)}`, durationMs: 1200 }); return "done"; }, cancel: () => false, steer: () => false, status: () => ({ outcome: "completed" }) });
  const initial = runtime.snapshot();
  await runtime.createTask("test");
  const events = runtime.connect(0).events;
  let replay = initial;
  for (const event of events) replay = applyRuntimeEvent(replay, event);
  assert.equal(replay.task?.subagents?.[0]?.durationMs, 1200);
  assert.equal(replay.task?.subagents?.[0]?.result?.includes("private-canary"), false);
  assert.ok(replay.task!.subagents![0]!.result!.length <= 16_000);
});

test("desktop composition executes a real read-only child without inheriting full access", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-child-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const host = await createWorkspaceAgentHost(root, { profile, backgroundRoot: path.join(root, "background"), provider: { async complete(system, _messages, tools) {
    calls++;
    assert.ok(!tools.some((tool) => tool.name === "write_file" || tool.name === "spawn_agents"));
    assert.ok(tools.some((tool) => tool.name === "read_file"));
    assert.ok(!system.includes("trusted desktop host has explicitly granted full access"));
    return { text: "Investigated. VERDICT: PASS", toolCalls: [], raw: {} };
  } } });
  t.after(() => host.close?.());
  host.setApprovalMode!("full");
  const run = await host.coordinator!.start("investigate", [{ id: "child", title: "Check", instructions: "Investigate only", role: "explorer" }]);
  const completed = await host.coordinator!.wait(run.id, 10_000);
  assert.equal(completed.tasks[0]?.status, "completed");
  assert.equal(calls, 1);
  assert.match(completed.tasks[0]!.result!, /VERDICT: PASS/);
  assert.ok(host.background);
});

test("coordinator shutdown cancels and drains children; disk results redact secrets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-child-drain-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = new MultiAgentCoordinator(root, async (_task, context) => {
    await new Promise<void>((resolve) => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { result: "private-canary", stats: { modelCalls: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, activeMs: 1 } };
  }, {}, 1, ["private-canary"]);
  const run = await coordinator.start("private-canary", [{ id: "child", title: "Check", instructions: "private-canary", role: "explorer" }]);
  await coordinator.shutdown();
  assert.equal(coordinator.get(run.id).tasks[0]?.status, "cancelled");
  assert.equal((await fs.readFile(path.join(root, ".xiu", "agents", `${run.id}.json`), "utf8")).includes("private-canary"), false);
});

test("real desktop parent tool flow emits completed specialist events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-parent-child-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let step = 0;
  let host: Awaited<ReturnType<typeof createWorkspaceAgentHost>>;
  host = await createWorkspaceAgentHost(root, { profile, backgroundRoot: path.join(root, ".xiu", "background"), journalRoot: path.join(root, ".xiu", "journal"), provider: { async complete(_system, _messages, tools) {
    if (!tools.some((tool) => tool.name === "spawn_agents")) return { text: "Child checked files. VERDICT: PASS", toolCalls: [], raw: {} };
    step++;
    if (step === 1) return { text: "Delegating investigation", toolCalls: [{ id: "spawn", name: "spawn_agents", input: { goal: "investigate", tasks: [{ id: "child", title: "Investigate", instructions: "Inspect only", role: "explorer" }] } }], raw: {} };
    if (step === 2) return { text: "Collecting results", toolCalls: [{ id: "wait", name: "wait_agents", input: { run_id: host.coordinator!.list()[0]!.id, timeout_ms: 1000 } }], raw: {} };
    return { text: "Investigation complete.", toolCalls: [], raw: {} };
  } } });
  t.after(() => host.close?.());
  host.setApprovalMode!("full");
  await host.runtime.createTask("Investigate using one specialist");
  assert.equal(host.runtime.snapshot().task?.state, "completed");
  const child = host.runtime.snapshot().task?.subagents?.[0];
  assert.equal(child?.status, "completed");
  assert.match(child!.result!, /Child checked/);
  const updates = host.runtime.connect(0).events.filter((event) => event.type === "subagent.updated");
  assert.ok(updates.length >= 2);
  assert.ok(updates.every((event) => event.type !== "subagent.updated" || !Object.keys(event.payload.agent).includes("instructions")));
});

test("desktop stop cancels an actual active child model call and waits for shutdown", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-parent-stop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let ready!: () => void;
  const childReady = new Promise<void>((resolve) => { ready = resolve; });
  let childAborted = false, step = 0;
  let host: Awaited<ReturnType<typeof createWorkspaceAgentHost>>;
  host = await createWorkspaceAgentHost(root, { profile, backgroundRoot: path.join(root, ".xiu", "background"), journalRoot: path.join(root, ".xiu", "journal"), provider: { async complete(_system, _messages, tools, signal) {
    if (!tools.some((tool) => tool.name === "spawn_agents")) {
      ready();
      return new Promise((_, reject) => signal!.addEventListener("abort", () => { childAborted = true; reject(new Error("cancelled")); }, { once: true }));
    }
    step++;
    return step === 1 ? { text: "Delegating", toolCalls: [{ id: "spawn", name: "spawn_agents", input: { goal: "investigate", tasks: [{ id: "child", title: "Investigate", instructions: "Inspect only", role: "explorer" }] } }], raw: {} } : { text: "Waiting", toolCalls: [{ id: "wait", name: "wait_agents", input: { run_id: host.coordinator!.list()[0]!.id, timeout_ms: 1000 } }], raw: {} };
  } } });
  t.after(() => host.close?.());
  host.setApprovalMode!("full");
  const execution = host.runtime.createTask("Investigate").catch((error) => error);
  await childReady;
  assert.equal(host.runtime.stopTask(), true);
  await execution;
  assert.equal(childAborted, true);
  assert.equal(host.runtime.snapshot().task?.state, "cancelled");
  assert.ok(host.coordinator!.list().every((run) => run.tasks.every((task) => !["pending", "running"].includes(task.status))));
});
