import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { createPlanTools, TaskPlanManager } from "../src/plan.js";
import { builtinTools } from "../src/tools.js";
import { loadSession } from "../src/session.js";
import type { ModelProvider } from "../src/types.js";

test("task plan validates and formats live step state", async () => {
  const manager = new TaskPlanManager();
  manager.update("Ship v0.4", [
    { id: "stream", title: "Add streaming", status: "completed" },
    { id: "plan", title: "Add plan mode", status: "in_progress" },
  ]);
  assert.match(manager.format(), /√ stream/);
  assert.match(manager.format(), /→ plan/);
  assert.throws(() => manager.update("bad", [
    { id: "a", title: "A", status: "in_progress" },
    { id: "b", title: "B", status: "in_progress" },
  ]), /only one/);
});

test("plan mode blocks workspace changes at the Agent boundary", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-mode-"));
  const manager = new TaskPlanManager(undefined, true);
  let calls = 0;
  const provider: ModelProvider = {
    async complete(_system, messages) {
      calls++;
      if (calls === 1) return { text: "try write", toolCalls: [{ id: "write-1", name: "write_file", input: { path: "blocked.txt", content: "no" } }], raw: {} };
      assert.match(messages.at(-1)?.content ?? "", /plan mode is read-only/);
      return { text: "planned only", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true },
    provider,
    [...builtinTools, ...createPlanTools(manager)],
    async () => true,
    {},
    undefined,
    undefined,
    manager,
  );
  assert.equal(await agent.run("plan without edits"), "planned only");
  await assert.rejects(fs.access(path.join(cwd, "blocked.txt")));
});

test("task plans persist with the resumable session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-persist-"));
  const manager = new TaskPlanManager();
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls++;
      if (calls === 1) return {
        text: "plan",
        toolCalls: [{ id: "plan-1", name: "update_task_plan", input: { goal: "finish", steps: [{ id: "one", title: "Done", status: "completed" }] } }],
        raw: {},
      };
      return { text: "finished", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true },
    provider,
    createPlanTools(manager),
    async () => true,
    {}, undefined, undefined, manager,
  );
  await agent.run("make a plan");
  const restored = await loadSession(cwd);
  assert.equal(restored.plan?.goal, "finish");
  assert.equal(restored.plan?.steps[0]?.status, "completed");
});
