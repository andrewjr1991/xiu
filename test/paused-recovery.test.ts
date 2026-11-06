import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { recoveryContinuation, taskOperationSignature, TaskRunJournal, type TaskSideEffect } from "../src/task-run.js";
import type { AgentTool } from "../src/types.js";

async function fixture(t: test.TestContext, sideEffect: TaskSideEffect = "workspace") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-paused-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const journalRoot = path.join(root, "runs"), journal = new TaskRunJournal(workspace, journalRoot);
  const input = { path: "result.txt" }, signature = taskOperationSignature("once", input);
  await journal.begin({ sessionId: "saved", task: "fixture", providerId: "offline", model: "offline" });
  await journal.beginOperation({ kind: "tool", name: "once", signature, risk: sideEffect === "none" ? "read" : "write", sideEffect });
  await journal.pause("fixture pause with unresolved operation");
  const next = new TaskRunJournal(workspace, journalRoot), interrupted = await next.interrupted();
  assert.ok(interrupted);
  return { root, workspace, journalRoot, next, interrupted, input, signature };
}

test("paused records retain already unknown operations in recovery counts and warnings", async (t) => {
  const f = await fixture(t, "external");
  assert.equal(f.interrupted.operations[0]?.status, "unknown");
  assert.equal(f.interrupted.interruptedOperations.length, 1);
  assert.equal(f.interrupted.pendingSideEffects.length, 1);
  assert.equal(f.interrupted.pendingSideEffects[0]?.signature, f.signature);
  assert.equal(f.interrupted.pendingSideEffects[0]?.replay, "forbidden");
  assert.match(recoveryContinuation(f.interrupted, "en-US"), /tool:once \(external, forbidden\)/);
});

test("paused unknown side effects still require the explicit recovery acknowledgement", async (t) => {
  const f = await fixture(t, "external"), runtime = new XiuRuntime();
  runtime.recordRecovery({ runId: f.interrupted.runId, status: "paused", interruptedOperations: f.interrupted.interruptedOperations.length,
    unknownSideEffects: f.interrupted.pendingSideEffects.length, recommendation: f.interrupted.recommendation });
  assert.throws(() => runtime.assertRecoveryConfirmed(f.interrupted.runId, false));
  assert.doesNotThrow(() => runtime.assertRecoveryConfirmed(f.interrupted.runId, true));
});

for (const sideEffect of ["workspace", "external", "process", "unknown", "none"] as const) {
  test(`confirmed recovery of a paused ${sideEffect} operation preserves its replay boundary`, async (t) => {
    const f = await fixture(t, sideEffect);
    let executions = 0, turn = 0;
    const tool: AgentTool = { name: "once", description: "fixture operation", inputSchema: { type: "object", properties: {} },
      risk: sideEffect === "none" ? "read" : sideEffect === "process" ? "execute" : sideEffect === "unknown" ? "dangerous" : "write", changesWorkspace: sideEffect === "workspace", describe: () => "fixture",
      execute: async () => { executions++; return "fixture result"; } };
    const agent = new Agent({ config: { cwd: f.workspace, provider: "openai", providerId: "offline", model: "offline", autoApprove: true },
      provider: { async complete() { return turn++ === 0 ? { text: "", toolCalls: [{ id: "call", name: "once", input: f.input }], raw: {} }
        : { text: "done", toolCalls: [], raw: {} }; } }, tools: [tool], approve: async () => true, taskRunJournal: f.next });
    agent.setRecoverySource(f.interrupted);
    await agent.run(recoveryContinuation(f.interrupted));
    assert.equal(executions, sideEffect === "none" ? 1 : 0);
    assert.equal((await f.next.read(f.interrupted.runId))?.status, "abandoned");
  });
}
