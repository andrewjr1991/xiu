import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { Agent, type AgentEvents } from "../src/agent.js";
import { builtinTools, executeTool, executeToolResult, looksLikeVerification } from "../src/tools.js";
import type { AssistantTurn, ConversationMessage, ModelProvider, ToolCall } from "../src/types.js";

// The outer runner sets this marker for its own child workers. Product subprocesses
// must run their tests normally instead of silently skipping a recursive test run.
const outerTestContext = process.env.NODE_TEST_CONTEXT;
before(() => { delete process.env.NODE_TEST_CONTEXT; });
after(() => {
  if (outerTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = outerTestContext;
});

const done = (): AssistantTurn => ({ text: "Done.", toolCalls: [], raw: {}, finishReason: "stop" });
const action = (name: string, input: Record<string, unknown>, id = name): AssistantTurn => ({
  text: `Perform ${name}.`, toolCalls: [{ id, name, input }], raw: {}, finishReason: "tool_calls",
});
const check = (file: string) => action("run_process", { program: "node", args: ["--test", file] }, `test-${file}`);

class ScriptedProvider implements ModelProvider {
  calls = 0;
  seen: ConversationMessage[][] = [];
  constructor(private readonly steps: AssistantTurn[] | ((call: number) => AssistantTurn)) {}
  async complete(_system: string, messages: ConversationMessage[]): Promise<AssistantTurn> {
    this.seen.push(messages.map((message) => ({ ...message })));
    this.calls++;
    return typeof this.steps === "function" ? this.steps(this.calls) : this.steps[this.calls - 1] ?? done();
  }
}

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-p1-runtime-"));
  await fs.writeFile(path.join(root, "calc.mjs"), "export function add(a, b) { return a - b; }\n");
  await fs.writeFile(path.join(root, "calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./calc.mjs";',
    'test("adds two numbers", () => assert.equal(add(2, 3), 5));',
  ].join("\n"));
  await fs.writeFile(path.join(root, "other.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("independent check", () => assert.equal(2 + 2, 4));',
  ].join("\n"));
  return root;
}

function createAgent(cwd: string, provider: ScriptedProvider, events: AgentEvents = {}, maxTurns = 12): Agent {
  return new Agent({ provider: "openai", model: "offline-test", cwd, maxTurns, autoApprove: true, language: "en-US" }, provider, builtinTools, async () => true, events);
}

const fix = () => action("replace_text", { path: "calc.mjs", old_text: "return a - b", new_text: "return a + b" });

test("P1 real product tools read a buggy module, edit it, and run its Node tests before completion", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([action("read_file", { path: "calc.mjs" }), fix(), check("calc.test.mjs"), done()]);
  const executed: string[] = [];
  const outputs: string[] = [];
  let summary: Parameters<NonNullable<AgentEvents["onTaskComplete"]>>[0] | undefined;
  const agent = createAgent(cwd, provider, {
    onToolStart: (name) => executed.push(name), onToolEnd: (_name, output) => outputs.push(output),
    onTaskComplete: (value) => { summary = value; },
  });
  await agent.run("Fix add in calc.mjs and verify calc.test.mjs.");
  assert.deepEqual(executed, ["read_file", "replace_text", "run_process"]);
  assert.match(await fs.readFile(path.join(cwd, "calc.mjs"), "utf8"), /return a \+ b/);
  assert.match(outputs[0]!, /return a - b/);
  assert.match(outputs[2]!, /^Exit code: 0/);
  assert.match(outputs[2]!, /adds two numbers/);
  assert.equal(agent.status().outcome, "completed");
  assert.equal(summary?.verified, true);
  assert.equal(summary?.changed, true);
});

test("P1 a different passing check cannot erase a failed required check", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([
    action("write_file", { path: "notes.md", content: "The checks must both pass.\n" }),
    check("calc.test.mjs"), check("other.test.mjs"), done(), done(),
  ]);
  let summary: Parameters<NonNullable<AgentEvents["onTaskComplete"]>>[0] | undefined;
  const outputs: string[] = [];
  const agent = createAgent(cwd, provider, {
    onTaskComplete: (value) => { summary = value; },
    onToolEnd: (name, output) => { if (name === "run_process") outputs.push(output); },
  });
  await agent.run("Document the required checks and run both calc.test.mjs and other.test.mjs.");
  assert.match(outputs[0]!, /^Exit code: 1/);
  assert.match(outputs[1]!, /^Exit code: 0/);
  assert.notEqual(agent.status().outcome, "completed");
  assert.equal(summary?.verified, false);
  assert.equal(summary?.failureReason, "verification_failed");
  assert.match(agent.status().completionIssues?.join("\n") ?? "", /测试命令：执行未通过/);
  assert.doesNotMatch(agent.status().completionIssues?.join("\n") ?? "", /calc.test|other.test/);
});

test("P1 an edit after a passing check expires verification until a fresh check runs", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([
    fix(), check("calc.test.mjs"),
    action("replace_text", { path: "calc.mjs", old_text: "return a + b", new_text: "return a * b" }, "regress"),
    done(), done(),
  ]);
  let verified: boolean | undefined;
  const agent = createAgent(cwd, provider, { onTaskComplete: (summary) => { verified = summary.verified; } });
  await agent.run("Modify the calculator and report only current verification evidence.");
  assert.notEqual(agent.status().outcome, "completed");
  assert.equal(verified, false);
  assert.match(await fs.readFile(path.join(cwd, "calc.mjs"), "utf8"), /return a \* b/);
  assert.ok(provider.seen.some((messages) => messages.some((message) => /Completion gate/.test(message.content))));
});

for (const reason of ["length", "content_filter", "unknown"] as const) {
  for (const withTool of [false, true]) {
    test(`P1 ${reason} model ending cannot claim completion${withTool ? " or execute a partial write" : ""}`, async () => {
      const cwd = await fixture();
      const tools: ToolCall[] = withTool ? [{ id: "partial-write", name: "write_file", input: { path: "partial.txt", content: "should not exist" } }] : [];
      const provider = new ScriptedProvider(() => ({ text: "Done. All changes are complete.", toolCalls: tools, raw: {}, finishReason: reason }));
      let executions = 0;
      let verified: boolean | undefined;
      const agent = createAgent(cwd, provider, { onToolStart: () => { executions++; }, onTaskComplete: (summary) => { verified = summary.verified; } }, 3);
      await agent.run("Finish the task only from complete model output.");
      assert.notEqual(agent.status().outcome, "completed");
      assert.notEqual(verified, true);
      assert.equal(executions, 0);
      await assert.rejects(fs.access(path.join(cwd, "partial.txt")));
    });
  }
}

for (const mode of ["missing-path", "replace-mismatch"] as const) {
  test(`P1 repeated ${mode} errors stop despite changing tool arguments`, async () => {
    const cwd = await fixture();
    const provider = new ScriptedProvider((call) => mode === "missing-path"
      ? action("read_file", { path: `missing-${call}.mjs` }, `missing-${call}`)
      : action("replace_text", { path: "calc.mjs", old_text: `absent-${call}`, new_text: "never applied" }, `mismatch-${call}`));
    const failures: string[] = [];
    const agent = createAgent(cwd, provider, { onToolEnd: (_name, result) => failures.push(result) }, 12);
    await assert.rejects(agent.run("Locate the module using actual evidence and repair its implementation."), /without making progress|loop|repeated/i);
    assert.ok(provider.calls >= 5, "allow bounded recovery attempts before stopping");
    assert.ok(provider.calls < 12, "repeated semantic failures should stop before the max-turn fallback");
    assert.equal(agent.status().outcome, "failed");
    assert.ok(failures.some((value) => /ENOENT|not found|occurrence|match/i.test(value)));
    assert.equal(await fs.readFile(path.join(cwd, "calc.mjs"), "utf8"), "export function add(a, b) { return a - b; }\n");
  });
}

test("P1 native tool results preserve status and exit code while legacy executeTool stays a string", async () => {
  const cwd = await fixture();
  const run = builtinTools.find((tool) => tool.name === "run_process")!;
  const context = { cwd, approve: async () => true };
  const legacy = await executeTool(run, { program: "node", args: ["--version"] }, context);
  assert.equal(typeof legacy, "string");
  assert.match(legacy, /^Exit code: 0/);
  const success = await executeToolResult(run, { program: "node", args: ["--version"] }, context);
  assert.equal(success.status, "success");
  assert.equal(success.exitCode, 0);
  const failure = await executeToolResult(run, { program: "node", args: ["-e", "process.exit(17)"] }, context);
  assert.equal(failure.status, "failure");
  assert.equal(failure.exitCode, 17);
  const write = builtinTools.find((tool) => tool.name === "write_file")!;
  const denied = await executeToolResult(write, { path: "denied.txt", content: "no" }, { cwd, approve: async () => false });
  assert.equal(denied.status, "denied");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeToolResult(write, { path: "cancelled.txt", content: "no" }, { ...context, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(fs.access(path.join(cwd, "denied.txt")));
  await assert.rejects(fs.access(path.join(cwd, "cancelled.txt")));
});

test("P1 echo, version and help output never become verification evidence", async () => {
  const cwd = await fixture();
  for (const command of ["echo test", "tsc --version", "tsc --help", "node --version", "node --help", "npm test -- --listTests"]) {
    assert.equal(looksLikeVerification(command), false, command);
  }
  const provider = new ScriptedProvider([
    action("write_file", { path: "answer.txt", content: "unchecked" }),
    action("run_process", { program: "node", args: ["-e", "console.log('test passed')"] }, "echo"),
    action("run_process", { program: "node", args: ["--version"] }, "version"),
    action("run_process", { program: "node", args: ["--help"] }, "help"),
    done(), done(),
  ]);
  let verified: boolean | undefined;
  const agent = createAgent(cwd, provider, { onTaskComplete: (summary) => { verified = summary.verified; } });
  await agent.run("Write answer.txt and distinguish information from actual validation.");
  assert.notEqual(agent.status().outcome, "completed");
  assert.equal(verified, false);
});

test("P1 external edits after a passed check invalidate final verification", async () => {
  const cwd = await fixture();
  const scripted = new ScriptedProvider([fix(), check("calc.test.mjs"), done(), done()]);
  const originalComplete = scripted.complete.bind(scripted);
  scripted.complete = async (system, messages) => {
    if (scripted.calls === 2) {
      // Simulates the user's editor or another process while the model is replying.
      await fs.writeFile(path.join(cwd, "calc.mjs"), "export function add(a, b) { return 999; }\n");
    }
    return originalComplete(system, messages);
  };
  let verified: boolean | undefined;
  const checks: string[] = [];
  const agent = createAgent(cwd, scripted, {
    onToolEnd: (name, output) => { if (name === "run_process") checks.push(output); },
    onTaskComplete: (summary) => { verified = summary.verified; },
  });
  await agent.run("Fix and validate the calculator.");
  assert.match(checks[0]!, /^Exit code: 0/);
  assert.match(checks[0]!, /adds two numbers/);
  assert.notEqual(agent.status().outcome, "completed");
  assert.equal(verified, false);
  assert.ok(scripted.seen.some((messages) => messages.some((message) => /Completion gate/.test(message.content))));
});

test("P1 repairing a failed check and rerunning that same check can complete", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([check("calc.test.mjs"), fix(), check("calc.test.mjs"), done()]);
  const checks: string[] = [];
  let verified: boolean | undefined;
  const agent = createAgent(cwd, provider, {
    onToolEnd: (name, output) => { if (name === "run_process") checks.push(output); },
    onTaskComplete: (summary) => { verified = summary.verified; },
  });
  await agent.run("Run the calculator test, fix its failure and verify the repair.");
  assert.match(checks[0]!, /^Exit code: 1/);
  assert.match(checks[1]!, /^Exit code: 0/);
  assert.match(checks[1]!, /adds two numbers/);
  assert.equal(agent.status().outcome, "completed");
  assert.equal(verified, true);
});

test("P1 a stronger artifact verification replaces its stale predecessor after a read-only inline process", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([
    action("write_file", { path: "report.html", content: "<html>Alice Bob</html>\n" }),
    action("verify_output", { path: "report.html", required_substrings: ["Alice"] }, "first-verify"),
    action("run_process", { program: "node", args: ["-e", "console.log('inspected')"] }, "inspect"),
    action("verify_output", { path: "report.html", required_substrings: ["Alice", "Bob"], forbidden_substrings: ["TBD"] }, "final-verify"),
    done(),
  ]);
  let summary: Parameters<NonNullable<AgentEvents["onTaskComplete"]>>[0] | undefined;
  const agent = createAgent(cwd, provider, { onTaskComplete: (value) => { summary = value; } });
  await agent.run("Create and deterministically verify report.html.");
  assert.equal(agent.status().outcome, "completed");
  assert.equal(summary?.verified, true);
  assert.equal(summary?.outcome, "completed");
});

test("P1 a read-only inline process preserves current artifact verification", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([
    action("write_file", { path: "report.html", content: "<html>Alice Bob</html>\n" }),
    action("verify_output", { path: "report.html", required_substrings: ["Alice", "Bob"], forbidden_substrings: ["TBD"] }),
    action("run_process", { program: "node", args: ["-e", "require('node:fs').readFileSync('report.html', 'utf8')"] }, "inspect"),
    done(),
  ]);
  let summary: Parameters<NonNullable<AgentEvents["onTaskComplete"]>>[0] | undefined;
  const agent = createAgent(cwd, provider, { onTaskComplete: (value) => { summary = value; } });
  await agent.run("Create, inspect, and deterministically verify report.html.");
  assert.equal(agent.status().outcome, "completed");
  assert.equal(summary?.verified, true);
  assert.equal(provider.calls, 4, "a read-only inspection must not trigger another completion-gate turn");
});

test("P1 Chinese Agent streams only redacted draft previews and persists its final answer once", async () => {
  const cwd = await fixture();
  const secret = "p1-SecretCanary-9xk734-Z";
  const finalText = "检查完成，未修改任何文件。";
  let streams = 0;
  const provider: ModelProvider = {
    async complete() { throw new Error("Chinese preview should use the provider's streaming path"); },
    async stream(_system, _messages, _tools, emit) {
      streams++;
      emit("正在檢查專案。\n");
      emit(`DraftOnlyMarker api_key: ${secret.slice(0, 10)}`);
      emit(`${secret.slice(10)}\n`);
      emit("此草稿不是最终答复。");
      return { text: finalText, toolCalls: [], raw: {}, finishReason: "stop" };
    },
  };
  const previews: string[] = [];
  const visible: string[] = [];
  const lifecycle: string[] = [];
  let livePreview = "";
  let ends = 0;
  const agent = new Agent({ provider: "openai", model: "offline-test", apiKey: secret, cwd, maxTurns: 3, autoApprove: true, language: "zh-CN" }, provider, builtinTools, async () => true, {
    onDraftPreview: (text, receivedChars) => {
      assert.ok(receivedChars > 0);
      previews.push(text);
      livePreview = text;
      lifecycle.push("draft");
    },
    onTextDelta: () => assert.fail("draft mode must not emit raw text chunks"),
    onModelEnd: () => { ends++; livePreview = ""; lifecycle.push("end"); },
    onText: (text) => { visible.push(text); lifecycle.push("final"); },
  });
  assert.equal(await agent.run("说明当前检查状态，不修改文件。"), finalText);
  assert.equal(streams, 1);
  assert.equal(ends, 1);
  assert.equal(livePreview, "");
  assert.deepEqual(visible, [finalText]);
  assert.deepEqual(lifecycle.slice(-2), ["end", "final"]);
  assert.match(previews.join("\n"), /正在检查/);
  assert.match(previews.join("\n"), /REDACTED/);
  assert.doesNotMatch(previews.join("\n"), /p1-Secret|9xk734-Z/);
  const sessions = await fs.readdir(path.join(cwd, ".xiu", "sessions"));
  const log = (await Promise.all(sessions.map((file) => fs.readFile(path.join(cwd, ".xiu", "sessions", file), "utf8")))).join("\n");
  assert.doesNotMatch(log, /DraftOnlyMarker|p1-SecretCanary|9xk734-Z|此草稿不是最终答复/);
  const assistantRecords = log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; text?: string });
  assert.equal(assistantRecords.filter((record) => record.type === "assistant" && record.text === finalText).length, 1);
});

test("P1 a failed streaming request still ends the preview and never replays visible output", async () => {
  const cwd = await fixture();
  let calls = 0;
  let ended = 0;
  let livePreview = "";
  const provider: ModelProvider = {
    async complete() { throw new Error("unexpected non-streaming request"); },
    async stream(_system, _messages, _tools, emit) {
      calls++;
      emit("已经读取部分回复。\n");
      throw new Error("ECONNRESET after visible output");
    },
  };
  const agent = new Agent({ provider: "openai", model: "offline-test", cwd, maxTurns: 3, autoApprove: true, language: "zh-CN" }, provider, builtinTools, async () => true, {
    onDraftPreview: (value) => { livePreview = value; },
    onModelEnd: () => { ended++; livePreview = ""; },
  });
  await assert.rejects(agent.run("回答项目问题。"), /ECONNRESET/);
  assert.equal(calls, 1);
  assert.equal(ended, 1);
  assert.equal(livePreview, "");
});

test("P1 a check cannot verify code that changes while the check is running", async () => {
  const cwd = await fixture();
  await fs.writeFile(path.join(cwd, "mutating.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import fs from "node:fs/promises";',
    'import { add } from "./calc.mjs";',
    'test("assert then overwrite", async () => {',
    '  assert.equal(add(2, 3), 5);',
    '  await fs.writeFile(new URL("./calc.mjs", import.meta.url), "export function add() { return 999; }\\n");',
    '});',
  ].join("\n"));
  const provider = new ScriptedProvider([fix(), check("mutating.test.mjs"), done(), done()]);
  let verified: boolean | undefined;
  const outputs: string[] = [];
  const agent = createAgent(cwd, provider, {
    onToolEnd: (name, value) => { if (name === "run_process") outputs.push(value); },
    onTaskComplete: (summary) => { verified = summary.verified; },
  });
  await agent.run("Fix the calculator and verify its current implementation.");
  assert.match(outputs[0]!, /^Exit code: 0/);
  assert.match(outputs[0]!, /assert then overwrite/);
  assert.match(await fs.readFile(path.join(cwd, "calc.mjs"), "utf8"), /999/);
  assert.equal(verified, false);
  assert.notEqual(agent.status().outcome, "completed");
});

test("P1 ignored explicit artifacts cannot retain stale verify_output evidence", async () => {
  const cwd = await fixture();
  await fs.writeFile(path.join(cwd, ".gitignore"), "artifact.txt\n");
  await fs.writeFile(path.join(cwd, "artifact.txt"), "expected content\n");
  const provider = new ScriptedProvider([action("verify_output", { path: "artifact.txt", required_substrings: ["expected content"] }), done(), done()]);
  const complete = provider.complete.bind(provider);
  provider.complete = async (system, messages) => {
    if (provider.calls === 1) await fs.writeFile(path.join(cwd, "artifact.txt"), "external corrupted content\n");
    return complete(system, messages);
  };
  let verified: boolean | undefined;
  const agent = createAgent(cwd, provider, { onTaskComplete: (summary) => { verified = summary.verified; } });
  await agent.run("Verify the generated artifact and report its current state.");
  assert.equal(verified, false);
  assert.notEqual(agent.status().outcome, "completed");
});

test("P1 a longer timeout retry replaces the same failed check rather than permanently blocking completion", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([
    action("run_process", { program: "node", args: ["--test", "calc.test.mjs"], timeout_ms: 1000 }, "first-test"),
    fix(),
    action("run_process", { program: "node", args: ["--test", "calc.test.mjs"], timeout_ms: 5000 }, "retry-test"),
    done(),
  ]);
  let verified: boolean | undefined;
  const outputs: string[] = [];
  const agent = createAgent(cwd, provider, {
    onToolEnd: (name, output) => { if (name === "run_process") outputs.push(output); },
    onTaskComplete: (summary) => { verified = summary.verified; },
  });
  await agent.run("Run the calculator test, fix it, and retry with a longer deadline.");
  assert.match(outputs[0]!, /^Exit code: 1/);
  assert.match(outputs[1]!, /^Exit code: 0/);
  assert.equal(verified, true);
  assert.equal(agent.status().outcome, "completed");
});

test("P1 the one-shot final-text event excludes an answer rejected by the completion gate", async () => {
  const cwd = await fixture();
  const provider = new ScriptedProvider([
    action("write_file", { path: "unchecked.txt", content: "draft" }),
    { text: "RejectedEarlyDoneMarker", toolCalls: [], raw: {}, finishReason: "stop" },
    { text: "Final limitation: the file has not been verified.", toolCalls: [], raw: {}, finishReason: "stop" },
  ]);
  const visible: string[] = [];
  const agent = createAgent(cwd, provider, { onText: (text) => visible.push(text) });
  const result = await agent.run("Write unchecked.txt and state validation limits honestly.");
  assert.equal(result, "Final limitation: the file has not been verified.");
  assert.doesNotMatch(visible.join("\n"), /RejectedEarlyDoneMarker/);
  assert.equal(visible.filter((text) => text === result).length, 1);
  assert.notEqual(agent.status().outcome, "completed");
});
