import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { collectIntegrationEvidence, createMultiAgentTools, MultiAgentCoordinator, requireCompletedSubagent, selectSubagentTools, validateTaskGraph, type SubagentExecutor, type SubagentRun } from "../src/multi-agent.js";
import type { AgentTool } from "../src/types.js";
import { Agent } from "../src/agent.js";
import { builtinTools } from "../src/tools.js";
import { createWorkspaceAgentHost } from "../src/runtime/workspace-agent-host.js";

const stats = { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, activeMs: 10 };
const execFileAsync = promisify(execFile);

test("a tester's prose-only PASS is never executed verification evidence", async () => {
  const createdAt = new Date().toISOString();
  const run = {
    id: "unverified", goal: "unverified", status: "completed", createdAt, updatedAt: createdAt, concurrency: 1,
    tasks: [
      { id: "impl", title: "impl", instructions: "impl", role: "implementer", mode: "worktree", dependencies: [], status: "completed", createdAt },
      { id: "test", title: "test", instructions: "test", role: "tester", mode: "shared_readonly", dependencies: ["impl"], status: "completed", createdAt, result: "No tools were run.\nVERDICT: PASS" },
    ],
  } as SubagentRun;
  assert.deepEqual((await collectIntegrationEvidence(run, "impl")).testers, []);
});

async function gitRepository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-integration-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Xiu Test"], { cwd, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "xiu@example.invalid"], { cwd, windowsHide: true });
  await fs.writeFile(path.join(cwd, ".gitignore"), ".xiu/\n", "utf8");
  await fs.writeFile(path.join(cwd, "base.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd, windowsHide: true });
  return cwd;
}

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

test("agent cancellation and retry require execute approval and are never replayed", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-agent-tool-risk-"));
  const coordinator = new MultiAgentCoordinator(cwd, async () => ({ result: "done", stats }));
  const tools = createMultiAgentTools(coordinator);
  for (const name of ["cancel_agent", "retry_agent"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.risk, "execute");
    assert.equal(tool?.replaySafety, "side-effecting");
    assert.equal(tool?.maxAttempts, 1);
  }
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

test("legacy text verdicts lack patch-bound inspection receipts", async () => {
  const createdAt = new Date().toISOString();
  const run = {
    id: "evidence", goal: "evidence", status: "completed", createdAt, updatedAt: createdAt, concurrency: 3,
    tasks: [
      { id: "impl", title: "impl", instructions: "impl", role: "implementer", mode: "worktree", dependencies: [], status: "completed", createdAt },
      { id: "review", title: "review", instructions: "review", role: "reviewer", mode: "shared_readonly", dependencies: ["impl"], status: "completed", createdAt, result: "VERDICT: PASS" },
      { id: "test", title: "test", instructions: "test", role: "tester", mode: "shared_readonly", dependencies: ["review"], status: "completed", createdAt, result: "VERDICT: PASS" },
    ],
  } as SubagentRun;
  const blocked = await collectIntegrationEvidence(run, "impl");
  assert.deepEqual(blocked.reviewers, []);
  assert.deepEqual(blocked.testers, []);
  assert.equal(blocked.blockers.length, 2);
});

async function verifyArtifacts(cwd: string, inputs: Record<string, unknown>[]) {
  let calls = 0;
  const agent = new Agent({ provider: "openai", providerId: "fixture", model: "fixture", cwd, maxTurns: 4, autoApprove: false }, {
    async complete(_system, _messages, tools) {
      assert.ok(!tools.some((tool) => ["write_file", "run_process", "run_command", "validate_project"].includes(tool.name)));
      return ++calls === 1
        ? { text: "Checking artifacts", toolCalls: inputs.map((input, index) => ({ id: `check-${index}`, name: "verify_output", input })), raw: {} }
        : { text: "Bounded artifact checks complete.\nVERDICT: PASS", toolCalls: [], raw: {} };
    },
  }, selectSubagentTools(builtinTools, "shared_readonly"), async () => { throw new Error("Read-only checks must not request execution approval"); });
  const result = await agent.run("Verify explicitly scoped artifacts without modifying them");
  return { result, stats, verification: await agent.getVerificationEvidence(), outcome: agent.status().outcome };
}

const integrationTasks = [
  { id: "impl", title: "implement", instructions: "implement", role: "implementer" as const },
  { id: "review", title: "review", instructions: "review", role: "reviewer" as const, dependencies: ["impl"] },
  { id: "test", title: "test", instructions: "test", role: "tester" as const, dependencies: ["impl"] },
];

test("reviewer and tester inspect the implementation Worktree before gated integration", async () => {
  const cwd = await gitRepository();
  let implementationCwd = "";
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    if (task.role === "implementer") {
      implementationCwd = context.cwd;
      await fs.writeFile(path.join(context.cwd, "feature.txt"), "implemented\n", "utf8");
      return { result: "Implemented and locally verified.", stats };
    }
    assert.equal(context.cwd, implementationCwd);
    assert.equal(await fs.readFile(path.join(context.cwd, "feature.txt"), "utf8"), "implemented\n");
    if (task.role === "tester") return verifyArtifacts(context.cwd, [{ path: "feature.txt", required_substrings: ["implemented"], forbidden_substrings: ["unfinished"] }]);
    return { result: `${task.role} evidence\nVERDICT: PASS`, stats };
  });
  const run = await coordinator.start("safe merge", [
    { id: "impl", title: "implement", instructions: "implement", role: "implementer" },
    { id: "review", title: "review", instructions: "review", role: "reviewer", dependencies: ["impl"] },
    { id: "test", title: "test", instructions: "test", role: "tester", dependencies: ["impl"] },
  ]);
  assert.equal((await coordinator.wait(run.id, 10_000)).status, "completed");
  const plan = await coordinator.analyzeIntegration(run.id, "impl");
  assert.equal(plan.canIntegrate, true);
  assert.deepEqual(plan.evidence.reviewers, ["review"]);
  assert.deepEqual(plan.evidence.testers, ["test"]);
  await coordinator.integrate(run.id, "impl");
  assert.equal((await fs.readFile(path.join(cwd, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"), "implemented\n");
  assert.equal(coordinator.get(run.id).tasks.find((task) => task.id === "impl")?.integration?.status, "applied");
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


test("integration rejects changed patches, stale receipts, and unrelated artifact checks", async () => {
  const cwd = await gitRepository();
  let implementationCwd = "";
  let target = "base.txt";
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    if (task.role === "implementer") {
      implementationCwd = context.cwd;
      await fs.writeFile(path.join(context.cwd, "feature.txt"), "implemented\n");
      return { result: "implemented", stats };
    }
    if (task.role === "tester") return verifyArtifacts(context.cwd, [{ path: target, required_substrings: [target === "base.txt" ? "base" : "implemented"] }]);
    return { result: "VERDICT: PASS", stats };
  });
  const run = await coordinator.start("fresh evidence", integrationTasks);
  await coordinator.wait(run.id, 10_000);
  assert.equal((await coordinator.analyzeIntegration(run.id, "impl")).canIntegrate, false, "unrelated artifact must not verify patch");
  target = "feature.txt";
  await coordinator.retry(run.id, "test");
  await coordinator.wait(run.id, 10_000);
  assert.equal((await coordinator.analyzeIntegration(run.id, "impl")).canIntegrate, true);
  await fs.writeFile(path.join(implementationCwd, "feature.txt"), "changed after check\n");
  const changed = await coordinator.analyzeIntegration(run.id, "impl");
  assert.equal(changed.canIntegrate, false);
  assert.deepEqual(changed.evidence.reviewers, []);
  assert.deepEqual(changed.evidence.testers, []);
  await assert.rejects(coordinator.integrate(run.id, "impl"), /not applied/);
  await assert.rejects(fs.access(path.join(cwd, "feature.txt")));
});

test("deterministic absence checks permit deletion and fail if the file reappears", async () => {
  const cwd = await gitRepository();
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    if (task.role === "implementer") await fs.unlink(path.join(context.cwd, "base.txt"));
    if (task.role === "tester") return verifyArtifacts(context.cwd, [{ path: "base.txt", exists: false }]);
    return { result: "VERDICT: PASS", stats };
  });
  const run = await coordinator.start("remove obsolete artifact", integrationTasks);
  await coordinator.wait(run.id, 10_000);
  assert.equal((await coordinator.analyzeIntegration(run.id, "impl")).canIntegrate, true);
  await coordinator.integrate(run.id, "impl");
  await assert.rejects(fs.access(path.join(cwd, "base.txt")));
  const worktree = coordinator.get(run.id).tasks[0]!.worktree!.path;
  const validation = await verifyArtifacts(worktree, [{ path: "base.txt", exists: false }]);
  assert.ok(validation.verification);
  await fs.writeFile(path.join(worktree, "base.txt"), "reappeared");
  const reappeared = await verifyArtifacts(worktree, [{ path: "base.txt", exists: false }]);
  assert.equal(reappeared.verification, undefined);
  assert.equal(reappeared.outcome, "failed");
});

test("restored inspection JSON must be re-established by an explicit readonly retry", async () => {
  const cwd = await gitRepository();
  const executor: SubagentExecutor = async (task, context) => {
    if (task.role === "implementer") await fs.writeFile(path.join(context.cwd, "feature.txt"), "implemented");
    if (task.role === "tester") return verifyArtifacts(context.cwd, [{ path: "feature.txt", required_substrings: ["implemented"] }]);
    return { result: "VERDICT: PASS", stats };
  };
  const original = new MultiAgentCoordinator(cwd, executor);
  const run = await original.start("fresh session evidence", integrationTasks);
  await original.wait(run.id, 10_000);
  assert.equal((await original.analyzeIntegration(run.id, "impl")).canIntegrate, true);
  const restored = new MultiAgentCoordinator(cwd, executor);
  await restored.initialize();
  assert.equal((await restored.analyzeIntegration(run.id, "impl")).canIntegrate, false);
  for (const id of ["review", "test"]) { await restored.retry(run.id, id); await restored.wait(run.id, 10_000); }
  assert.equal((await restored.analyzeIntegration(run.id, "impl")).canIntegrate, true);
});


test("UTF-8, whitespace and newline filenames retain patch evidence identity", async () => {
  const cwd = await gitRepository();
  const names = ["中文.txt", " leading and spaced.txt", ...(process.platform === "win32" ? [] : ["trailing.txt ", "line\nbreak.txt"])];
  for (const name of names) await fs.writeFile(path.join(cwd, name), "before");
  await execFileAsync("git", ["add", "--", ...names], { cwd });
  await execFileAsync("git", ["commit", "-m", "path fixtures"], { cwd });
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    if (task.role === "implementer") for (const name of [...names, "新增.txt"]) await fs.writeFile(path.join(context.cwd, name), "after");
    if (task.role === "tester") return verifyArtifacts(context.cwd, [...names, "新增.txt"].map((name) => ({ path: name, required_substrings: ["after"] })));
    return { result: "VERDICT: PASS", stats };
  });
  const run = await coordinator.start("unicode artifact paths", integrationTasks);
  await coordinator.wait(run.id, 10_000);
  const plan = await coordinator.analyzeIntegration(run.id, "impl");
  assert.deepEqual([...plan.analysis.changedFiles].sort(), [...names, "新增.txt"].sort());
  assert.equal(plan.canIntegrate, true, plan.blockers.join("\n"));
});

test("both hosts reject every non-completed child outcome and block its dependents", async () => {
  for (const outcome of ["failed", "unverified", "paused", "cancelled", "running", "idle"]) assert.throws(() => requireCompletedSubagent({ outcome, failureReason: "plan_incomplete" }), /Subagent outcome/);
  assert.doesNotThrow(() => requireCompletedSubagent({ outcome: "completed" }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-child-outcome-"));
  let descendants = 0;
  const coordinator = new MultiAgentCoordinator(cwd, async (task) => {
    if (task.id === "parent") requireCompletedSubagent({ outcome: "failed", failureReason: "plan_incomplete" });
    descendants++;
    return { result: "done", stats };
  });
  const run = await coordinator.start("incomplete plan", [
    { id: "parent", title: "Parent", instructions: "inspect", role: "explorer" },
    { id: "dependent", title: "Dependent", instructions: "inspect", role: "reviewer", dependencies: ["parent"] },
  ]);
  const done = await coordinator.wait(run.id, 2000);
  assert.deepEqual(done.tasks.map((task) => task.status), ["failed", "blocked"]);
  assert.equal(descendants, 0);
});

test("fresh patch identity cannot hide a stale ignored-artifact receipt", async () => {
  const cwd = await gitRepository();
  await fs.appendFile(path.join(cwd, ".gitignore"), "ignored.txt\n");
  await execFileAsync("git", ["add", ".gitignore"], { cwd });
  await execFileAsync("git", ["commit", "-m", "ignored artifact fixture"], { cwd });
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    if (task.role === "implementer") {
      await fs.writeFile(path.join(context.cwd, "feature.txt"), "implemented");
      await fs.writeFile(path.join(context.cwd, "ignored.txt"), "initial");
    }
    if (task.role === "tester") {
      const checked = await verifyArtifacts(context.cwd, [{ path: "feature.txt", required_substrings: ["implemented"] }, { path: "ignored.txt", required_substrings: ["initial"] }]);
      assert.ok(checked.verification);
      await fs.writeFile(path.join(context.cwd, "ignored.txt"), "changed after evidence");
      return checked;
    }
    return { result: "VERDICT: PASS", stats };
  });
  const run = await coordinator.start("fresh ignored evidence", integrationTasks);
  await coordinator.wait(run.id, 10_000);
  const plan = await coordinator.analyzeIntegration(run.id, "impl");
  assert.deepEqual(plan.evidence.reviewers, ["review"]);
  assert.deepEqual(plan.evidence.testers, []);
  assert.equal(plan.canIntegrate, false);
});


test("desktop child executor passes real verification receipts without expanding tester tools", async (t) => {
  const cwd = await gitRepository();
  const host = await createWorkspaceAgentHost(cwd, {
    profile: { id: "fixture", name: "Fixture", kind: "openai-compatible", model: "fixture", features: { tools: true, vision: false, image: false, video: false, audio: false } },
    backgroundRoot: path.join(cwd, ".xiu", "background"), journalRoot: path.join(cwd, ".xiu", "journal"),
    provider: { async complete(_system, messages, tools) {
      const context = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
      const completedTools = messages.filter((message) => message.role === "tool").length;
      if (context.includes("Fixture implement")) {
        if (completedTools === 0) return { text: "Writing", toolCalls: [{ id: "write", name: "write_file", input: { path: "feature.txt", content: "implemented" } }], raw: {} };
        if (completedTools === 1) return { text: "Verifying", toolCalls: [{ id: "check", name: "verify_output", input: { path: "feature.txt", required_substrings: ["implemented"] } }], raw: {} };
      } else {
        assert.ok(!tools.some((tool) => ["write_file", "run_process", "run_command", "validate_project"].includes(tool.name)));
        if (context.includes("Fixture test") && completedTools === 0) return { text: "Checking artifact", toolCalls: [{ id: "check", name: "verify_output", input: { path: "feature.txt", required_substrings: ["implemented"] } }], raw: {} };
      }
      return { text: "VERDICT: PASS", toolCalls: [], raw: {} };
    } },
  });
  t.after(() => host.close());
  host.setApprovalMode!("full");
  const run = await host.coordinator!.start("desktop evidence", integrationTasks.map((task) => ({ ...task, title: `Fixture ${task.id === "impl" ? "implement" : task.id}`, maxTurns: 5 })));
  const done = await host.coordinator!.wait(run.id, 10_000);
  assert.equal(done.status, "completed", JSON.stringify(done.tasks.map((task) => ({ id: task.id, error: task.error }))));
  const plan = await host.coordinator!.analyzeIntegration(run.id, "impl");
  assert.equal(plan.canIntegrate, true, plan.blockers.join("\n"));
  assert.ok(done.tasks.find((task) => task.id === "test")?.inspection?.verification);
  await assert.rejects(fs.access(path.join(cwd, "feature.txt")), "a passing analysis must not integrate automatically");
  assert.equal(createMultiAgentTools(host.coordinator!).find((tool) => tool.name === "integrate_agent")!.risk, "dangerous");
});

test("desktop child with an unfinished plan fails and blocks dependent specialists", async (t) => {
  const cwd = await gitRepository();
  const host = await createWorkspaceAgentHost(cwd, {
    profile: { id: "fixture", name: "Fixture", kind: "openai-compatible", model: "fixture", features: { tools: true, vision: false, image: false, video: false, audio: false } },
    backgroundRoot: path.join(cwd, ".xiu", "background"), journalRoot: path.join(cwd, ".xiu", "journal"),
    provider: { async complete(_system, messages) {
      if (!messages.some((message) => message.role === "tool")) return { text: "Plan", toolCalls: [{ id: "plan", name: "update_task_plan", input: { goal: "unfinished", steps: [{ id: "one", title: "Unfinished", status: "pending" }] } }], raw: {} };
      return { text: "VERDICT: PASS", toolCalls: [], raw: {} };
    } },
  });
  t.after(() => host.close());
  host.setApprovalMode!("full");
  const run = await host.coordinator!.start("incomplete child", integrationTasks);
  const done = await host.coordinator!.wait(run.id, 10_000);
  assert.deepEqual(done.tasks.map((task) => task.status), ["failed", "blocked", "blocked"]);
  assert.match(done.tasks[0]!.error!, /plan_incomplete/);
});

test("artifact evidence limit is explicit for patches over 64 files", async () => {
  const cwd = await gitRepository();
  const coordinator = new MultiAgentCoordinator(cwd, async (task, context) => {
    if (task.role === "implementer") for (let index = 0; index < 65; index++) await fs.writeFile(path.join(context.cwd, `artifact-${index}.txt`), "content");
    return { result: "VERDICT: PASS", stats };
  });
  const run = await coordinator.start("bounded scope", integrationTasks);
  await coordinator.wait(run.id, 10_000);
  const plan = await coordinator.analyzeIntegration(run.id, "impl");
  assert.equal(plan.canIntegrate, false);
  assert.match(plan.blockers.join(" "), /at most 64 changed files/);
});
