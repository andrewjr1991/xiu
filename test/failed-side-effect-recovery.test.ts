import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { recoveryContinuation, taskOperationSignature, TaskRunJournal, type TaskSideEffect } from "../src/task-run.js";
import type { AgentTool } from "../src/types.js";

async function fixture(t: test.TestContext, status: "failed" | "cancelled", effect: TaskSideEffect = "workspace") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-partial-effect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), storage = path.join(root, "runs"), partial = path.join(workspace, "partial.txt");
  await fs.mkdir(workspace);
  const owner = new TaskRunJournal(workspace, storage), input = { path: "partial.txt" };
  const run = await owner.begin({ sessionId: "saved", task: "fixture", providerId: "offline", model: "offline" });
  const operation = await owner.beginOperation({ kind: "tool", name: "once", signature: taskOperationSignature("once", input), risk: effect === "none" ? "read" : "write", sideEffect: effect });
  // A tool can change durable state before reporting failure or cancellation.
  if (effect !== "none") await fs.appendFile(partial, "first effect\n");
  await owner.finishOperation(operation, status, "fixture returned after partial work");
  await owner.pause("fixture interrupted later");
  const next = new TaskRunJournal(workspace, storage), interrupted = await next.interrupted();
  assert.ok(interrupted);
  return { workspace, partial, next, interrupted, input, file: path.join(storage, owner.workspaceId, `${run.runId}.json`) };
}
for (const status of ["failed", "cancelled"] as const) {
  test(`a ${status} side effect remains uncertain and requires recovery acknowledgement`, async t => {
    const f = await fixture(t, status), before = await fs.readFile(f.file, "utf8");
    assert.equal(f.interrupted.operations[0]?.status, status, "stored outcome remains unchanged");
    assert.equal(f.interrupted.pendingSideEffects.length, 1);
    assert.equal(f.interrupted.pendingSideEffects[0]?.status, "unknown", "recovery projection describes uncertain effects");
    assert.match(recoveryContinuation(f.interrupted), /tool:once/);
    const runtime = new XiuRuntime();
    runtime.recordRecovery({ runId: f.interrupted.runId, status: "paused", interruptedOperations: f.interrupted.interruptedOperations.length,
      unknownSideEffects: f.interrupted.pendingSideEffects.length, recommendation: f.interrupted.recommendation });
    assert.throws(() => runtime.assertRecoveryConfirmed(f.interrupted.runId, false));
    assert.doesNotThrow(() => runtime.assertRecoveryConfirmed(f.interrupted.runId, true));
    assert.equal(await fs.readFile(f.file, "utf8"), before);
  });
  for (const effect of ["workspace", "external", "process", "unknown", "none"] as const) {
    test(`recovery does not repeat a ${status} ${effect} operation after possible partial work`, async t => {
      const f = await fixture(t, status, effect);
      let executions = 0, turn = 0;
      const tool: AgentTool = { name: "once", description: "fixture", inputSchema: { type: "object", properties: {} },
        risk: effect === "none" ? "read" : effect === "process" ? "execute" : effect === "unknown" ? "dangerous" : "write",
        changesWorkspace: effect === "workspace", describe: () => "fixture", execute: async () => {
          executions++; if (effect !== "none") await fs.appendFile(f.partial, "duplicate effect\n"); return "fixture result";
        } };
      const agent = new Agent({ config: { cwd: f.workspace, provider: "openai", providerId: "offline", model: "offline", autoApprove: true },
        provider: { async complete() { return turn++ === 0 ? { text: "", toolCalls: [{ id: "repeat", name: "once", input: f.input }], raw: {} }
          : { text: "done", toolCalls: [], raw: {} }; } }, tools: [tool], approve: async () => true, taskRunJournal: f.next });
      agent.setAccessMode("full");
      agent.setRecoverySource(f.interrupted);
      await agent.run(recoveryContinuation(f.interrupted));
      assert.equal(executions, effect === "none" ? 1 : 0);
      if (effect !== "none") assert.equal(await fs.readFile(f.partial, "utf8"), "first effect\n");
    });
  }
}
