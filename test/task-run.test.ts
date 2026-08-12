import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Agent } from "../src/agent.js";
import { recoveryContinuation, safeTaskPreview, TaskRunJournal, taskOperationSignature, taskToolSideEffect } from "../src/task-run.js";
import type { AgentTool, ModelProvider } from "../src/types.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-task-run-"));
  const workspace = path.join(root, "workspace");
  const journalRoot = path.join(root, "journal");
  await fs.mkdir(workspace);
  return { root, workspace, journalRoot, journal: new TaskRunJournal(workspace, journalRoot) };
}

test("persists bounded recovery evidence without full paths or secrets", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const secret = "secret-value-123";
  const record = await item.journal.begin({
    sessionId: "session-1",
    task: `Edit ${path.join(item.workspace, "src", "app.ts")} api_key=${secret}`,
    providerId: "provider",
    model: "model",
  });
  const operation = await item.journal.beginOperation({ kind: "model", name: "turn 1", sideEffect: "none" });
  await item.journal.finishOperation(operation, "succeeded", `assistant response recorded token=${secret}`);
  await item.journal.recoveryPoint("assistant", `persisted ${path.join(item.workspace, "private.txt")}`, operation);

  const signature = taskOperationSignature("sensitive_tool", { path: path.join(item.workspace, "private.txt"), token: secret });
  await item.journal.beginOperation({ kind: "tool", name: "sensitive_tool", signature, risk: "write", sideEffect: "external" });

  const file = path.join(item.journalRoot, item.journal.workspaceId, `${record.runId}.json`);
  const content = await fs.readFile(file, "utf8");
  assert.doesNotMatch(content, new RegExp(secret));
  assert.doesNotMatch(content, new RegExp(item.workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(content, /\[workspace\]/);

  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.match(content, new RegExp(signature));
  assert.doesNotMatch(signature, /private|secret/i);
});

test("classifies an interrupted side-effect operation as unknown and forbidden", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await item.journal.begin({ sessionId: "session-2", task: "deploy", providerId: "p", model: "m" });
  await item.journal.beginOperation({ kind: "tool", name: "remote_write", signature: "abc", risk: "write", sideEffect: "external" });

  const interrupted = await new TaskRunJournal(item.workspace, item.journalRoot).interrupted();
  assert.ok(interrupted);
  assert.equal(interrupted.interruptedOperations[0]?.status, "unknown");
  assert.equal(interrupted.pendingSideEffects[0]?.replay, "forbidden");
  assert.match(recoveryContinuation(interrupted, "en-US"), /must not be replayed automatically/);
});

test("requires explicit abandon or resume before another task", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const first = await item.journal.begin({ sessionId: "session-3", task: "first", providerId: "p", model: "m" });
  const next = new TaskRunJournal(item.workspace, item.journalRoot);
  await assert.rejects(() => next.begin({ sessionId: "session-4", task: "second", providerId: "p", model: "m" }), /explicit resume or abandon/);
  await next.abandon(first.runId);
  const second = await next.begin({ sessionId: "session-4", task: "second", providerId: "p", model: "m" });
  assert.equal(second.status, "running");
});

test("refuses a concurrent task owned by another live process", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const record = await item.journal.begin({ sessionId: "session-live", task: "live", providerId: "p", model: "m" });
  const file = path.join(item.journalRoot, item.journal.workspaceId, `${record.runId}.json`);
  record.ownerPid = process.ppid;
  await fs.writeFile(file, `${JSON.stringify(record)}\n`);
  const next = new TaskRunJournal(item.workspace, item.journalRoot);
  await assert.rejects(
    () => next.begin({ sessionId: "session-other", task: "other", providerId: "p", model: "m" }),
    /Another Xiu process/,
  );
});

test("atomically grants only one concurrent starter for a workspace", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const first = new TaskRunJournal(item.workspace, item.journalRoot);
  const second = new TaskRunJournal(item.workspace, item.journalRoot);
  const results = await Promise.allSettled([
    first.begin({ sessionId: "race-1", task: "first", providerId: "p", model: "m" }),
    second.begin({ sessionId: "race-2", task: "second", providerId: "p", model: "m" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("confirmed recovery supersedes the interrupted record", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const first = await item.journal.begin({ sessionId: "session-5", task: "first", providerId: "p", model: "m" });
  const next = new TaskRunJournal(item.workspace, item.journalRoot);
  const resumed = await next.begin({ sessionId: "session-5", task: "continue", providerId: "p", model: "m", resumedFrom: first.runId });
  assert.equal(resumed.resumedFrom, first.runId);
  assert.equal((await next.read(first.runId))?.status, "abandoned");
});

test("rejects corrupt and unknown-version journals", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const directory = path.join(item.journalRoot, item.journal.workspaceId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "bad.json"), JSON.stringify({ version: 99, runId: "bad" }));
  await assert.rejects(() => item.journal.read("bad"), /Unsupported or corrupt/);
});

test("a budget pause remains explicitly recoverable", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const record = await item.journal.begin({ sessionId: "budget", task: "bounded task", providerId: "p", model: "m" });
  await item.journal.pause("task budget exhausted: tokens");
  assert.equal((await item.journal.read(record.runId))?.status, "paused");
  const recoverable = await new TaskRunJournal(item.workspace, item.journalRoot).interrupted();
  assert.equal(recoverable?.runId, record.runId);
  assert.match(recoverable?.recoveryPoints.at(-1)?.evidence ?? "", /budget exhausted/);
});

test("a paused run blocks a new task until it is explicitly recovered or abandoned", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const record = await item.journal.begin({ sessionId: "paused", task: "bounded task", providerId: "p", model: "m" });
  await item.journal.pause("task budget exhausted: tokens");
  const next = new TaskRunJournal(item.workspace, item.journalRoot);
  await assert.rejects(
    () => next.begin({ sessionId: "new", task: "unrelated task", providerId: "p", model: "m" }),
    /explicit resume or abandon decision/,
  );
  const resumed = await next.begin({ sessionId: "paused", task: "continue", providerId: "p", model: "m", resumedFrom: record.runId });
  assert.equal(resumed.resumedFrom, record.runId);
});

test("marks terminal operations and no longer reports an interrupted run", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await item.journal.begin({ sessionId: "session-6", task: "finish", providerId: "p", model: "m" });
  const operation = await item.journal.beginOperation({ kind: "verification", name: "npm test", sideEffect: "process" });
  await item.journal.finishOperation(operation, "succeeded", "tests passed");
  await item.journal.complete("completed");
  assert.equal(await item.journal.interrupted(), undefined);
});

test("side-effect classification preserves the no-replay boundary", () => {
  assert.equal(taskToolSideEffect("read", false), "none");
  assert.equal(taskToolSideEffect("write", true), "workspace");
  assert.equal(taskToolSideEffect("execute", false), "process");
  assert.equal(taskToolSideEffect("write", false), "external");
  assert.equal(taskToolSideEffect("dangerous", false), "unknown");
});

test("task previews are bounded", () => {
  const value = safeTaskPreview("x".repeat(500), process.cwd());
  assert.equal(value.length, 200);
});

test("agent recovery never replays the exact unknown side-effect operation", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const input = { path: "result.txt", content: "created once" };
  await item.journal.begin({ sessionId: "session-7", task: "create a result", providerId: "p", model: "m" });
  await item.journal.beginOperation({
    kind: "tool",
    name: "write_once",
    signature: taskOperationSignature("write_once", input),
    risk: "write",
    sideEffect: "workspace",
  });
  const next = new TaskRunJournal(item.workspace, item.journalRoot);
  const interrupted = await next.interrupted();
  assert.ok(interrupted);
  let executions = 0;
  const tool: AgentTool = {
    name: "write_once",
    description: "write once",
    parameters: { type: "object", properties: {} },
    risk: "write",
    changesWorkspace: true,
    describe: () => "write result",
    execute: async () => { executions++; return "written"; },
  };
  let turn = 0;
  const provider: ModelProvider = {
    complete: async () => turn++ === 0
      ? { text: "", toolCalls: [{ id: "call-1", name: "write_once", input }] }
      : { text: "Stopped after verifying the interrupted operation.", toolCalls: [] },
  };
  const agent = new Agent(
    { provider: "openai", providerId: "p", model: "m", cwd: item.workspace, autoApprove: true },
    provider,
    [tool],
    async () => true,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    next,
  );
  agent.setRecoverySource(interrupted);
  await agent.run(recoveryContinuation(interrupted));
  assert.equal(executions, 0);
  assert.equal((await next.read(interrupted.runId))?.status, "abandoned");
});

test("unwritable journal paths fail before a task can claim recoverability", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const invalidRoot = path.join(item.root, "not-a-directory");
  await fs.writeFile(invalidRoot, "file");
  const journal = new TaskRunJournal(item.workspace, invalidRoot);
  await assert.rejects(
    () => journal.begin({ sessionId: "session-8", task: "unsafe", providerId: "p", model: "m" }),
    /ENOTDIR|EEXIST|not a directory/i,
  );
});

test("forced termination leaves explainable recovery state at critical boundaries", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve("src/task-run.ts")).href;
  const boundaries = [
    { kind: "model", name: "model wait", sideEffect: "none" },
    { kind: "tool", name: "workspace write", sideEffect: "workspace" },
    { kind: "checkpoint", name: "file checkpoint", sideEffect: "none" },
    { kind: "verification", name: "test process", sideEffect: "process" },
  ] as const;

  for (const [index, boundary] of boundaries.entries()) {
    const workspace = path.join(item.root, `forced-${index}`);
    await fs.mkdir(workspace);
    const script = [
      `import { TaskRunJournal } from ${JSON.stringify(moduleUrl)};`,
      `const journal = new TaskRunJournal(${JSON.stringify(workspace)}, ${JSON.stringify(item.journalRoot)});`,
      `await journal.begin({sessionId:${JSON.stringify(`forced-${index}`)},task:"forced stop",providerId:"p",model:"m"});`,
      `await journal.beginOperation(${JSON.stringify(boundary)});`,
      `console.log("READY");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("READY")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== null) reject(new Error(`child exited before forced termination (${code}): ${stderr}`)); });
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
    const interrupted = await new TaskRunJournal(workspace, item.journalRoot).interrupted();
    assert.ok(interrupted, `${boundary.kind} boundary should be recoverable`);
    assert.equal(interrupted.interruptedOperations[0]?.kind, boundary.kind);
    assert.equal(interrupted.interruptedOperations[0]?.status, "unknown");
  }
});

test("forced termination after a file lands preserves an unknown workspace side effect", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve("src/task-run.ts")).href;
  const output = path.join(item.workspace, "landed.txt");
  const script = [
    `import fs from "node:fs/promises";`,
    `import { TaskRunJournal, taskOperationSignature } from ${JSON.stringify(moduleUrl)};`,
    `const journal = new TaskRunJournal(${JSON.stringify(item.workspace)}, ${JSON.stringify(item.journalRoot)});`,
    `await journal.begin({sessionId:"forced-write",task:"write once",providerId:"p",model:"m"});`,
    `await journal.beginOperation({kind:"tool",name:"write_file",signature:taskOperationSignature("write_file",{path:"landed.txt"}),risk:"write",sideEffect:"workspace"});`,
    `await fs.writeFile(${JSON.stringify(output)}, "landed once");`,
    `console.log("READY");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("READY")) resolve(); });
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== null) reject(new Error(`child exited before forced termination (${code}): ${stderr}`)); });
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;

  assert.equal(await fs.readFile(output, "utf8"), "landed once");
  const interrupted = await new TaskRunJournal(item.workspace, item.journalRoot).interrupted();
  assert.ok(interrupted);
  assert.equal(interrupted.pendingSideEffects[0]?.status, "unknown");
  assert.equal(interrupted.pendingSideEffects[0]?.replay, "verify-first");
});

test("workspace identity prevents a moved or different project from claiming recovery state", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  await item.journal.begin({ sessionId: "session-move", task: "move", providerId: "p", model: "m" });
  const other = path.join(item.root, "other-workspace");
  await fs.mkdir(other);
  assert.equal(await new TaskRunJournal(other, item.journalRoot).interrupted(), undefined);
});
