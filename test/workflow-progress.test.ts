import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { applyRuntimeEvent, type XiuRuntimeSnapshot } from "../src/runtime/protocol.js";
import { createPlanTools, TaskPlanManager } from "../src/plan.js";
import { TaskRunJournal } from "../src/task-run.js";
import type { ModelProvider } from "../src/types.js";

test("an explicit blocking question pauses before plan gates and releases the journal without success", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-question-"));
  await fs.mkdir(path.join(cwd, ".xiu", "sessions"), { recursive: true });
  const journal = new TaskRunJournal(cwd, path.join(cwd, "isolated-task-runs"));
  let calls = 0;
  const plan = new TaskPlanManager({ goal: "build", steps: [{ id: "one", title: "choose", status: "in_progress" }], updatedAt: new Date().toISOString() });
  const provider: ModelProvider = { async complete() { calls++; return { text: "Need a decision.\nUSER_INPUT_REQUIRED: Which platform?", toolCalls: [], raw: {} }; } };
  const agent = new Agent({ provider: "openai", providerId: "fixture", model: "fixture", cwd, language: "en-US", autoApprove: false }, provider, createPlanTools(plan), async () => false, {}, undefined, undefined, plan, undefined, undefined, journal);
  await agent.run("Build a program");
  assert.equal(calls, 1); assert.equal(agent.status().outcome, "waiting_user");
  assert.equal((await journal.recent())[0]?.status, "waiting_user");
  assert.equal((await journal.lockStatus()).active, false);
  assert.equal(plan.snapshot()?.steps[0]?.status, "in_progress");
});

test("runtime question is replayable, stale answers rejected, original goal retained without restoring permissions", async () => {
  const runtime = new XiuRuntime();
  const tasks: string[] = [];
  runtime.attachDriver({ run: async task => { tasks.push(task); return tasks.length === 1 ? "Context.\nUSER_INPUT_REQUIRED: Which platform?" : "done"; }, cancel: () => false, steer: () => false, status: () => ({ outcome: tasks.length === 1 ? "waiting_user" : "completed" }) });
  await runtime.createTask("Build original program");
  const snapshot = runtime.snapshot(), question = snapshot.task!.pendingQuestion!;
  assert.equal(snapshot.task?.state, "waiting_user"); assert.equal(snapshot.task?.result, "Context.");
  let replay: XiuRuntimeSnapshot = { schemaVersion: 1, sequence: 0, generatedAt: "" };
  for (const event of runtime.connect(0).events) replay = applyRuntimeEvent(replay, event);
  assert.deepEqual(replay.task?.pendingQuestion, question);
  await assert.rejects(runtime.createTask("Windows", { taskId: snapshot.task!.id, questionId: "stale" }), /stale/);
  assert.equal(tasks.length, 1);
  await runtime.createTask("Windows", { taskId: snapshot.task!.id, questionId: question.id });
  assert.match(tasks[1]!, /Build original program/); assert.match(tasks[1]!, /Windows/);
  assert.equal(runtime.snapshot().task?.pendingQuestion, undefined);
});

test("long-running stale plans receive a bounded freshness reminder without invented completion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plan-freshness-"));
  const plan = new TaskPlanManager();
  let calls = 0, freshness = false;
  const provider: ModelProvider = { async complete(_system, messages) {
    calls++;
    freshness ||= messages.some(message => message.content.includes("Visible plan freshness check"));
    if (calls === 1) return { text: "", raw: {}, toolCalls: [{ id: "plan", name: "update_task_plan", input: { goal: "work", steps: [{ id: "one", title: "inspect", status: "in_progress" }] } }] };
    if (calls <= 7) return { text: "", raw: {}, toolCalls: [{ id: `read-${calls}`, name: "fixture_read", input: { number: calls } }] };
    return { text: "USER_INPUT_REQUIRED: Continue?", raw: {}, toolCalls: [] };
  } };
  const agent = new Agent({ provider: "openai", model: "fixture", cwd, language: "en-US", autoApprove: false }, provider,
    [...createPlanTools(plan), { name: "fixture_read", description: "read", risk: "read", inputSchema: {}, describe: () => "read", execute: async () => "observed" }], async () => false, {}, undefined, undefined, plan);
  await agent.run("inspect"); assert.equal(freshness, true);
  assert.equal(plan.snapshot()?.steps[0]?.status, "in_progress");
});
