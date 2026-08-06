import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MultiAgentCoordinator, selectSubagentTools, validateTaskGraph, type SubagentExecutor } from "../src/multi-agent.js";
import type { AgentTool } from "../src/types.js";

const stats = { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, activeMs: 10 };

test("task graph rejects duplicates, missing dependencies, and cycles", () => {
  assert.throws(() => validateTaskGraph([
    { id: "same", title: "A", instructions: "A", role: "explorer" },
    { id: "same", title: "B", instructions: "B", role: "reviewer" },
  ]), /Duplicate/);
  assert.throws(() => validateTaskGraph([
    { id: "a", title: "A", instructions: "A", role: "explorer", dependencies: ["missing"] },
  ]), /unknown dependency/);
  assert.throws(() => validateTaskGraph([
    { id: "a", title: "A", instructions: "A", role: "explorer", dependencies: ["b"] },
    { id: "b", title: "B", instructions: "B", role: "reviewer", dependencies: ["a"] },
  ]), /cycle/);
});

test("shared read-only agents cannot see write, execute, dangerous, or dynamic-risk tools", () => {
  const tool = (name: string, risk: AgentTool["risk"]): AgentTool => ({
    name, risk, description: name, inputSchema: { type: "object" }, describe: () => name, async execute() { return name; },
  });
  const tools = [tool("read", "read"), tool("write", "write"), tool("execute", "execute"), tool("danger", "dangerous"), tool("dynamic", () => "read")];
  assert.deepEqual(selectSubagentTools(tools, "shared_readonly").map((item) => item.name), ["read"]);
  assert.deepEqual(selectSubagentTools(tools, "worktree").map((item) => item.name), tools.map((item) => item.name));
});

test("three independent read-only agents run concurrently", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agents-parallel-"));
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const executor: SubagentExecutor = async (task) => {
    active++;
    peak = Math.max(peak, active);
    if (active === 3) release();
    await allStarted;
    active--;
    return { result: `done ${task.id}`, stats };
  };
  const coordinator = new MultiAgentCoordinator(cwd, executor);
  await coordinator.initialize();
  const run = await coordinator.start("parallel", ["a", "b", "c"].map((id) => ({ id, title: id, instructions: id, role: "explorer" })));
  const completed = await coordinator.wait(run.id, 2_000);
  assert.equal(completed.status, "completed");
  assert.equal(peak, 3);
  assert.deepEqual(completed.tasks.map((task) => task.status), ["completed", "completed", "completed"]);
});

test("dependencies start only after their prerequisites complete", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agents-deps-"));
  const events: string[] = [];
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    events.push(`start:${task.id}`);
    if (task.id === "first") await new Promise((resolve) => setTimeout(resolve, 30));
    if (task.id === "second") assert.deepEqual(context.dependencyResults, [{ id: "first", result: "first-result" }]);
    events.push(`end:${task.id}`);
    return { result: `${task.id}-result`, stats };
  });
  const run = await coordinator.start("ordered", [
    { id: "first", title: "first", instructions: "first", role: "explorer" },
    { id: "second", title: "second", instructions: "second", role: "reviewer", dependencies: ["first"] },
  ]);
  assert.equal((await coordinator.wait(run.id, 2_000)).status, "completed");
  assert.ok(events.indexOf("end:first") < events.indexOf("start:second"));
});

test("one agent can be cancelled without stopping another", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agents-cancel-"));
  const executor: SubagentExecutor = async (task, context) => {
    if (task.id === "slow") await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
    else await new Promise((resolve) => setTimeout(resolve, 30));
    return { result: task.id, stats };
  };
  const coordinator = new MultiAgentCoordinator(cwd, executor, {}, 2);
  const run = await coordinator.start("cancel one", [
    { id: "slow", title: "slow", instructions: "slow", role: "explorer" },
    { id: "fast", title: "fast", instructions: "fast", role: "reviewer" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await coordinator.cancel(run.id, "slow");
  const completed = await coordinator.wait(run.id, 2_000);
  assert.equal(completed.tasks.find((task) => task.id === "slow")?.status, "cancelled");
  assert.equal(completed.tasks.find((task) => task.id === "fast")?.status, "completed");
});

test("persisted running agents recover as interrupted and can retry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agents-resume-"));
  const directory = path.join(cwd, ".xiu", "agents");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "saved.json"), JSON.stringify({
    id: "saved", goal: "resume", status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), concurrency: 1,
    tasks: [{ id: "task", title: "task", instructions: "task", role: "explorer", mode: "shared_readonly", dependencies: [], status: "running", createdAt: new Date().toISOString() }],
  }));
  const coordinator = new MultiAgentCoordinator(cwd, async () => ({ result: "retried", stats }));
  await coordinator.initialize();
  assert.equal(coordinator.get("saved").tasks[0]?.status, "interrupted");
  await coordinator.retry("saved", "task");
  const completed = await coordinator.wait("saved", 2_000);
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks[0]?.result, "retried");
});
