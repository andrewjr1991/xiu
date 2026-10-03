import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { createPlanTools, TaskPlanManager } from "../src/plan.js";
import { builtinTools } from "../src/tools.js";
import { loadSession } from "../src/session.js";
import { TaskRunJournal } from "../src/task-run.js";
import type { ModelProvider } from "../src/types.js";

test("task plan validates and formats live step state", async () => {
  const manager = new TaskPlanManager();
  manager.update("Ship v0.4", [
    { id: "stream", title: "Add streaming", status: "completed" },
    { id: "plan", title: "Add plan mode", status: "in_progress" },
  ]);
  assert.match(manager.format(), /√ stream/);
  assert.match(manager.format(), /→ plan/);
  assert.match(manager.updateSummary(), /Task plan updated: 1\/2; now: Add plan mode/);
  assert.doesNotMatch(manager.updateSummary(), /Add streaming/);
  assert.doesNotMatch(manager.updateSummary(), /\/tasks/);
  assert.throws(() => manager.update("bad", [
    { id: "a", title: "A", status: "in_progress" },
    { id: "b", title: "B", status: "in_progress" },
  ]), /only one/);
});

test("Chinese mode rejects English natural-language plan steps", () => {
  const manager = new TaskPlanManager(undefined, false, "zh-CN");
  assert.throws(() => manager.update("Build the feature", [
    { id: "inspect", title: "Inspect current implementation", status: "in_progress" },
  ]), /必须使用简体中文/);
  assert.doesNotThrow(() => manager.update("完成终端交互修复", [
    { id: "inspect", title: "检查 src\/cli.ts", status: "in_progress" },
  ]));
});

test("Chinese mode normalizes Traditional Chinese plan text", () => {
  const manager = new TaskPlanManager(undefined, false, "zh-CN");
  manager.update("驗證並完成", [
    { id: "verify", title: "檢查檔案並整理結果", status: "in_progress", note: "確保沒有遺漏" },
  ]);
  const plan = manager.snapshot()!;
  assert.equal(plan.goal, "验证并完成");
  assert.equal(plan.steps[0]?.title, "检查档案并整理结果");
  assert.equal(plan.steps[0]?.note, "确保没有遗漏");
});

test("Chinese mode hides untranslated titles restored from an older session", () => {
  const manager = new TaskPlanManager({
    goal: "Build the feature",
    updatedAt: new Date().toISOString(),
    steps: [{ id: "inspect", title: "Inspect current implementation", status: "in_progress", note: "Read all related files" }],
  }, false, "zh-CN");
  const output = manager.format();
  assert.match(output, /目标: 当前任务/);
  assert.match(output, /步骤 inspect/);
  assert.doesNotMatch(output, /Build the feature|Inspect current|Read all/);
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

test("an ignored plan reminder never turns pending or in-progress work into success", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-incomplete-"));
  const manager = new TaskPlanManager();
  let calls = 0;
  const gates: string[] = [];
  let completed = "";
  const journal = new TaskRunJournal(cwd, path.join(cwd, ".xiu", "test-runs"));
  const agent = new Agent(
    { provider: "openai", providerId: "openai", model: "test", cwd, autoApprove: false, language: "en-US" },
    { async complete() {
      calls++;
      if (calls === 1) return {
        text: "I will do both steps.",
        toolCalls: [{ id: "plan-1", name: "update_task_plan", input: {
          goal: "Complete both steps", steps: [
            { id: "a", title: "First required work", status: "in_progress" },
            { id: "b", title: "Second required work", status: "pending" },
          ],
        } }], raw: {},
      };
      if (calls > 3) throw new Error("unfinished plan must stop after one reminder");
      return { text: "Done.", toolCalls: [], raw: {} };
    } }, createPlanTools(manager), async () => false,
    { onCompletionGate: (gate) => gates.push(gate), onTaskComplete: (result) => { completed = result.outcome; } },
    undefined, undefined, manager, undefined, undefined, journal,
  );
  await agent.run("Complete both steps");
  assert.equal(calls, 3);
  assert.equal(gates.length, 1);
  assert.equal(agent.status().outcome, "failed");
  assert.equal(agent.status().failureReason, "plan_incomplete");
  assert.equal(agent.status().diagnostics?.outcome, "failed");
  assert.equal(completed, "failed");
  assert.equal((await journal.latest())?.status, "failed");
  assert.deepEqual(manager.snapshot()?.steps.map((step) => step.status), ["in_progress", "pending"]);
});

for (const mode of [false, true]) {
  test(`a ${mode ? "planning-only" : "blocked execution"} plan terminates without forcing blocked work`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-blocked-"));
    const manager = new TaskPlanManager(undefined, mode);
    manager.update("Finish the request", [{ id: "one", title: "Wait for approval", status: "blocked", note: "User approval is required" }]);
    let calls = 0;
    const agent = new Agent(
      { provider: "openai", model: "test", cwd, autoApprove: false },
      { async complete() { calls++; return { text: "Waiting for approval.", toolCalls: [], raw: {} }; } },
      createPlanTools(manager), async () => false, {}, undefined, undefined, manager,
    );
    assert.equal(await agent.run("Handle the request"), "Waiting for approval.");
    assert.equal(calls, 1);
    assert.equal(agent.status().outcome, mode ? "completed" : "failed");
    assert.equal(agent.status().failureReason, mode ? undefined : "plan_incomplete");
    assert.equal(manager.snapshot()?.steps[0]?.status, "blocked");
  });
}

test("planning-only pending steps do not require executing the plan", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-only-"));
  const manager = new TaskPlanManager(undefined, true);
  manager.update("Design the change", [{ id: "one", title: "Implement later", status: "pending" }]);
  let calls = 0;
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, autoApprove: false },
    { async complete() { calls++; return { text: "Here is the plan.", toolCalls: [], raw: {} }; } },
    createPlanTools(manager), async () => false, {}, undefined, undefined, manager,
  );
  await agent.run("Only make a plan");
  assert.equal(calls, 1);
  assert.equal(agent.status().outcome, "completed");
  assert.equal(manager.snapshot()?.steps[0]?.status, "pending");
});

test("the plan reminder allows a completed update to finish successfully", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-reminder-complete-"));
  const manager = new TaskPlanManager();
  manager.update("Inspect", [{ id: "one", title: "Inspect the request", status: "in_progress" }]);
  let calls = 0;
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, autoApprove: false },
    { async complete(_system, messages) {
      calls++;
      if (calls === 2) {
        assert.match(messages.at(-1)?.content ?? "", /Plan gate/);
        return { text: "Updating the completed plan.", toolCalls: [{ id: "plan-done", name: "update_task_plan", input: {
          goal: "Inspect", steps: [{ id: "one", title: "Inspect the request", status: "completed" }],
        } }], raw: {} };
      }
      return { text: "Inspected.", toolCalls: [], raw: {} };
    } }, createPlanTools(manager), async () => false, {}, undefined, undefined, manager,
  );
  await agent.run("Inspect the request");
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "completed");
});

for (const stop of ["cancel", "turn-limit"] as const) {
  test(`the plan reminder preserves ${stop} termination`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-stop-"));
    const manager = new TaskPlanManager();
    manager.update("Inspect", [{ id: "one", title: "Unfinished work", status: "pending" }]);
    let calls = 0;
    let completions = 0;
    const agent = new Agent(
      { provider: "openai", model: "test", cwd, autoApprove: false, ...(stop === "turn-limit" ? { maxTurns: 1 } : {}) },
      { async complete() { calls++; return { text: "Done.", toolCalls: [], raw: {} }; } },
      createPlanTools(manager), async () => false,
      { onCompletionGate: () => { if (stop === "cancel") agent.cancel(); }, onTaskComplete: () => { completions++; } },
      undefined, undefined, manager,
    );
    await assert.rejects(agent.run("Inspect"), stop === "cancel" ? /Task cancelled/ : /1-turn limit/);
    assert.equal(calls, 1);
    assert.equal(completions, 0);
    assert.equal(agent.status().outcome, stop === "cancel" ? "cancelled" : "failed");
    assert.equal(manager.snapshot()?.steps[0]?.status, "pending");
  });
}

test("passing verification cannot override an unfinished plan", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-verified-incomplete-"));
  await fs.writeFile(path.join(cwd, "artifact.txt"), "verified artifact");
  const manager = new TaskPlanManager();
  manager.update("Finish two outcomes", [
    { id: "artifact", title: "Verify artifact", status: "completed" },
    { id: "remaining", title: "Finish remaining work", status: "pending" },
  ]);
  let calls = 0;
  let verified = false;
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, autoApprove: false },
    { async complete() {
      if (++calls === 1) return { text: "Verifying.", toolCalls: [{ id: "verify", name: "verify_output", input: {
        path: "artifact.txt", required_substrings: ["verified artifact"],
      } }], raw: {} };
      return { text: "Done.", toolCalls: [], raw: {} };
    } }, [...builtinTools, ...createPlanTools(manager)], async () => false,
    { onTaskComplete: (summary) => { verified = summary.verified; } }, undefined, undefined, manager,
  );
  await agent.run("Finish both outcomes");
  assert.equal(verified, true);
  assert.equal(calls, 3);
  assert.equal(agent.status().outcome, "failed");
  assert.equal(agent.status().failureReason, "plan_incomplete");
  assert.equal(await agent.getVerificationEvidence(), undefined);
});
