import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { TaskPlanManager } from "../src/plan.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { builtinTools, executeToolResult } from "../src/tools.js";
import { captureVerificationStamp } from "../src/verification.js";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { canAutomaticallyApprove } from "../src/runtime/workspace-agent-host.js";
import { TaskRunJournal } from "../src/task-run.js";
import type { AssistantTurn, ModelProvider, ToolContext } from "../src/types.js";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-full-access-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  return { root, cwd, external: path.join(root, "outside.txt") };
}
const tool = (name: string) => builtinTools.find((item) => item.name === name)!;

test("full access file tools are host-scoped and revert to confinement without the grant", async (t) => {
  const { cwd, external } = await fixture(t);
  const context: ToolContext = { cwd, accessMode: "full", approve: async () => true };
  assert.equal((await executeToolResult(tool("write_file"), { path: external, content: "external-canary" }, context)).status, "success");
  assert.match((await executeToolResult(tool("read_file"), { path: external }, context)).output, /external-canary/);
  assert.equal((await executeToolResult(tool("replace_text"), { path: external, old_text: "external-canary", new_text: "replaced" }, context)).status, "success");
  assert.equal(await fs.readFile(external, "utf8"), "replaced");
  assert.equal((await executeToolResult(tool("read_file"), { path: external, accessMode: "full" }, { cwd, approve: async () => true })).status, "failure");
  for (const accessMode of [undefined, "workspace"] as const) {
    assert.equal((await executeToolResult(tool("read_file"), { path: external }, { ...context, accessMode })).status, "failure");
    assert.equal((await executeToolResult(tool("write_file"), { path: external, content: "must-not-write" }, { ...context, accessMode })).status, "failure");
  }
  assert.equal(await fs.readFile(external, "utf8"), "replaced");
});

test("full access executes an absolute local executable; ordinary mode rejects it", async (t) => {
  const { cwd } = await fixture(t);
  const input = { program: process.execPath, args: ["-e", "console.log('local-diagnostic-canary')"] };
  const context: ToolContext = { cwd, accessMode: "full", approve: async () => true };
  const result = await executeToolResult(tool("run_process"), input, context);
  assert.equal(result.status, "success");
  assert.match(result.output, /local-diagnostic-canary/);
  assert.equal((await executeToolResult(tool("run_process"), input, { ...context, accessMode: "workspace" })).status, "failure");
});

test("external verification retains only a digest and detects subsequent changes", async (t) => {
  const { cwd, external } = await fixture(t);
  await fs.writeFile(external, "before");
  await assert.rejects(() => captureVerificationStamp(cwd, [external]), /outside|escapes/);
  const before = await captureVerificationStamp(cwd, [external], "full");
  assert.match(before, /^[a-f0-9]{64}$/);
  await fs.writeFile(external, "after");
  assert.notEqual(await captureVerificationStamp(cwd, [external], "full"), before);
});

test("computer diagnosis is supported and prompt permissions reflect the trusted mode", async (t) => {
  const { cwd } = await fixture(t);
  const normal = await buildSystemPrompt(cwd, undefined, "zh-CN", false);
  const full = await buildSystemPrompt(cwd, undefined, "zh-CN", false, "full");
  assert.match(normal, /software troubleshooting and local system diagnosis/);
  assert.match(normal, /Do not access paths outside it/);
  assert.match(full, /including dangerous actions, are automatically approved/);
  assert.match(full, /Plan mode remains read-only/);
  assert.doesNotMatch(full, /Do not access paths outside it|dangerous commands always require/);
});

test("main-process full access confirmation is required, cancellable, once per opening and nonpersistent", async (t) => {
  const { cwd, root } = await fixture(t);
  const modes: string[] = [];
  const controller = new DesktopTaskController(() => undefined, async (workspace) => ({
    runtime: new XiuRuntime(), provider: { id: "test", label: "Test", model: "test" },
    journal: new TaskRunJournal(workspace), setApprovalMode: (mode) => { modes.push(mode); },
  }));
  await assert.rejects(() => controller.setApprovalMode(cwd, { mode: "full" }), /首次确认/);
  await assert.rejects(() => controller.setApprovalMode(cwd, { mode: "full" }, async () => { throw new Error("dialog unavailable"); }), /dialog unavailable/);
  assert.equal((await controller.connect(cwd)).approvalMode, "ask");
  await assert.rejects(() => controller.setApprovalMode(cwd, { mode: "full", confirmed: true } as never), /首次确认/);
  assert.equal((await controller.setApprovalMode(cwd, { mode: "full" }, async () => false)).approvalMode, "ask");
  assert.equal((await controller.setApprovalMode(cwd, { mode: "full" }, async () => true)).approvalMode, "full");
  await controller.setApprovalMode(cwd, { mode: "ask" });
  assert.equal((await controller.setApprovalMode(cwd, { mode: "full" })).approvalMode, "full");
  controller.detach();
  assert.equal((await controller.connect(cwd)).approvalMode, "ask");
  await assert.rejects(() => controller.setApprovalMode(cwd, { mode: "full" }), /首次确认/);
  const next = path.join(root, "next"); await fs.mkdir(next);
  assert.equal((await controller.connect(next)).approvalMode, "ask");
  assert.ok(modes.includes("full"));
  await controller.shutdown();
});

test("dangerous fixture operation is denied normally and automatic only with full policy", async (t) => {
  const { cwd, external } = await fixture(t);
  await fs.writeFile(external, "disposable fixture");
  const requests: string[] = [];
  const dangerous = {
    name: "delete_fixture", description: "Delete this exact disposable test file", risk: "dangerous" as const,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, describe: () => "delete fixture",
    execute: async () => { await fs.unlink(external); return "fixture deleted"; },
  };
  const context: ToolContext = { cwd, approve: async (request) => { requests.push(request.risk); return canAutomaticallyApprove("workspace", request); } };
  assert.equal((await executeToolResult(dangerous, {}, context)).status, "denied");
  assert.equal(await fs.readFile(external, "utf8"), "disposable fixture");
  assert.equal((await executeToolResult(dangerous, {}, { ...context, accessMode: "full", approve: async (request) => canAutomaticallyApprove("full", request) })).status, "success");
  await assert.rejects(() => fs.stat(external), { code: "ENOENT" });
  assert.deepEqual(requests, ["dangerous"]);
});

test("pending full access confirmation blocks task creation and workspace changes", async (t) => {
  const { cwd } = await fixture(t);
  const controller = new DesktopTaskController(() => undefined, async () => ({
    runtime: new XiuRuntime(), provider: { id: "test", label: "Test", model: "test" }, journal: new TaskRunJournal(cwd),
  }));
  let finish!: (value: boolean) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const pending = controller.setApprovalMode(cwd, { mode: "full" }, () => { entered(); return new Promise((resolve) => { finish = resolve; }); });
  await ready;
  assert.equal(controller.canChangeWorkspace(), false);
  await assert.rejects(() => controller.createTask(cwd, "must not start"), /确认/);
  await assert.rejects(() => controller.setApprovalMode(cwd, { mode: "ask" }), /运行期间/);
  await assert.rejects(() => controller.connect(path.join(cwd, "other")), /运行/);
  finish(false);
  assert.equal((await pending).approvalMode, "ask");
  await controller.shutdown();
});

test("real Agent writes externally without workspace checkpoint/Diff; Plan still blocks it", async (t) => {
  const { cwd, external } = await fixture(t);
  for (const planMode of [false, true]) {
    let calls = 0;
    const outputs: string[] = [];
    const changes: string[] = [];
    const notices: string[] = [];
    const provider: ModelProvider = { async complete(): Promise<AssistantTurn> {
      calls++;
      if (calls === 1) return { text: "Inspect local software", toolCalls: [{ id: "external-write", name: "write_file", input: { path: external, content: "outside-source-canary" } }], raw: {} };
      if (calls === 2 && !planMode) return { text: "Verify output", toolCalls: [{ id: "verify", name: "verify_output", input: { path: external, required_substrings: ["outside-source-canary"] } }], raw: {} };
      return { text: "Done", toolCalls: [], raw: {} };
    } };
    const checkpoints = new CheckpointManager(cwd);
    const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: false }, provider, builtinTools, async () => true, {
      onToolEnd: (_name, result) => { outputs.push(result); },
      onWorkspaceChange: (change) => { changes.push(...change.paths); },
      onToolProgress: (_name, message) => { notices.push(message); },
    }, undefined, undefined, new TaskPlanManager(undefined, planMode), checkpoints);
    agent.setAccessMode("full");
    await agent.run("Diagnose local software");
    if (planMode) assert.ok(outputs.some((value) => value.includes("plan mode is read-only")));
    else {
      assert.equal(await fs.readFile(external, "utf8"), "outside-source-canary");
      assert.ok(outputs.some((value) => value.includes("Verification passed")));
      assert.ok(notices.some((value) => value.includes("无法保证撤销")));
    }
    assert.deepEqual(changes, []);
    assert.deepEqual(await checkpoints.list(), []);
  }
});

test("full access preserves workspace checkpoints and refreshes its prompt after downgrade", async (t) => {
  const { cwd } = await fixture(t);
  let calls = 0;
  const prompts: string[] = [];
  const provider: ModelProvider = { async complete(system): Promise<AssistantTurn> {
    prompts.push(system); calls++;
    if (calls === 1) return { text: "Write", toolCalls: [{ id: "inside", name: "write_file", input: { path: "inside.txt", content: "changed" } }], raw: {} };
    if (calls === 2) return { text: "Verify", toolCalls: [{ id: "verify", name: "verify_output", input: { path: "inside.txt", required_substrings: ["changed"] } }], raw: {} };
    return { text: "Done", toolCalls: [], raw: {} };
  } };
  const checkpoints = new CheckpointManager(cwd);
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: false }, provider, builtinTools, async () => true, {}, undefined, undefined, undefined, checkpoints);
  agent.setAccessMode("full");
  await agent.run("Write inside workspace");
  const saved = await checkpoints.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].files[0].path, "inside.txt");
  await checkpoints.restore(saved[0].id);
  await assert.rejects(() => fs.stat(path.join(cwd, "inside.txt")), { code: "ENOENT" });
  agent.setAccessMode("workspace");
  await agent.run("Explain local diagnosis");
  assert.match(prompts[0], /user explicitly enabled full local access/i);
  assert.match(prompts.at(-1)!, /Do not access paths outside it/);
});
