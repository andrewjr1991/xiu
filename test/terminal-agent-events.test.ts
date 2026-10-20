import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvents } from "../src/agent.js";
import type { WorkspaceChangeNotice } from "../src/change-summary.js";
import { compactTerminalDescription, createTerminalAgentEvents, type TerminalAgentEventsContext, type TerminalTaskView } from "../src/terminal-agent-events.js";

type Summary = Parameters<NonNullable<AgentEvents["onTaskComplete"]>>[0];

function harness(options: { maxTurns?: number; language?: "zh-CN" | "en-US" } = {}) {
  const lines: string[] = [];
  const writes: string[] = [];
  const phases: string[] = [];
  const calls: string[] = [];
  const detached: WorkspaceChangeNotice[] = [];
  let view: TerminalTaskView | undefined;
  const fakeView: TerminalTaskView = {
    clearDraftPreview: () => { calls.push("view:clearDraft"); },
    setTurn: (turn, maximum) => { calls.push(`view:turn:${turn}/${maximum ?? "-"}`); },
    activity: (text) => { calls.push(`view:activity:${text}`); },
    setDraftPreview: (text, received) => { calls.push(`view:draft:${text}:${received}`); },
    narrate: (text) => text.length > 3 ? text.slice(0, 24) : undefined,
    beginTool: (name, description, changesWorkspace, verification) => { calls.push(`view:tool:${name}:${description}:${changesWorkspace}:${verification}`); },
    markVerificationPassed: () => { calls.push("view:verified"); },
    recordImportantAction: (action) => { calls.push(`view:important:${action}`); },
    setPlan: (plan) => { calls.push(`view:plan:${plan?.steps.length ?? 0}`); },
    recordWorkspaceChange: (change) => { calls.push(`view:change:${change.description}`); },
    markFinishing: () => { calls.push("view:finishing"); },
    setCompletion: (message, success) => { calls.push(`view:completion:${success}:${message}`); },
  };
  const context: TerminalAgentEventsContext = {
    activities: {
      start: (kind, title, description) => { calls.push(`activity:start:${kind}:${title}:${description}`); return `act-${title}`; },
      progress: (id, message) => { calls.push(`activity:progress:${id}:${message}`); },
      finish: (id, _detail, failed) => { calls.push(`activity:finish:${id}:${failed}`); },
    },
    config: { maxTurns: options.maxTurns },
    language: () => options.language ?? "en-US",
    runningTaskView: () => view,
    emitLine: (value = "") => { lines.push(value); },
    emitWrite: (value) => { writes.push(value); },
    redact: (value) => value.replaceAll("sk-live-secret-1234567890", "[redacted]"),
    startPhase: (value) => { phases.push(value); },
    stopPhase: () => { phases.push("<stop>"); },
    onDetachedWorkspaceChange: (change) => { detached.push(change); },
  };
  const presenter = createTerminalAgentEvents(context);
  return { events: presenter.events, reset: presenter.reset, lines, writes, phases, calls, detached, attachView: () => { view = fakeView; }, detachView: () => { view = undefined; } };
}

const change: WorkspaceChangeNotice = {
  tool: "write_file", paths: ["src/a.ts"], description: "write src/a.ts with token sk-live-secret-1234567890",
  files: [{ path: "src/a.ts", kind: "modified", additions: 1, deletions: 2, bytesBefore: 10, bytesAfter: 12, hunk: "@@ -1 +1 @@", preview: ["-old sk-live-secret-1234567890", "+new"] } as WorkspaceChangeNotice["files"][number]],
};

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    turns: 3, toolCalls: 4, changed: true, verified: true, outcome: "completed", durationMs: 1500,
    diagnostics: { model: { failures: 1, inputTokens: 1_000, outputTokens: 200 }, tools: { failures: 0 } } as unknown as Summary["diagnostics"],
    ...overrides,
  } as Summary;
}

test("a one-shot run streams to stdout, tracks tool activities and verification, and hands workspace changes to the CLI", () => {
  const h = harness();
  const e = h.events;
  e.onModelStart!(1);
  assert.deepEqual(h.lines, [], "no turn banner without an interactive view");
  assert.deepEqual(h.phases, ["Thinking"]);
  e.onDraftPreview!("draft", 12);
  assert.equal(h.phases.at(-1), "Receiving response · 12 characters");
  e.onTextDelta!("hel");
  e.onTextDelta!("lo");
  e.onTextStreamEnd!();
  assert.deepEqual(h.writes, ["hel", "lo", "\n\n"]);
  assert.equal(h.phases.at(-1), "<stop>");
  e.onText!("final answer");
  assert.equal(h.lines.at(-1), "final answer\n");
  e.onAssistantTurn!("narration that is long enough", true);
  assert.equal(h.lines.length, 1, "tool-bound narration is only shown inside the interactive view");

  e.onToolStart!("run_process", "run   npm test\n  in src", { changesWorkspace: false, verification: false, risk: "execute" });
  assert.ok(h.calls.includes("activity:start:tool:run_process:run   npm test\n  in src"), "the activity log keeps the full description; only the terminal line is compacted");
  assert.match(h.lines.at(-1) ?? "", /> run_process.*run npm test in src/);
  assert.equal(h.phases.at(-1), "Running run_process");
  e.onToolProgress!("run_process", "still running");
  assert.ok(h.calls.includes("activity:progress:act-run_process:still running"), h.calls.join(","));
  e.onToolEnd!("run_process", "Exit code: 1\nnpm ERR! sk-live-secret-1234567890 failed");
  assert.ok(h.calls.includes("activity:finish:act-run_process:true"), "a non-zero exit is a failure even without structured details");
  assert.match(h.lines.at(-1) ?? "", /Exit code: 1 npm ERR! \[redacted\] failed/);
  assert.doesNotMatch(h.lines.join("\n"), /sk-live-secret/);

  e.onToolStart!("validate_project", "run the project checks", { changesWorkspace: false, verification: true, risk: "execute" });
  e.onToolEnd!("validate_project", "All checks passed", { result: { status: "success" } as never, verification: true });
  assert.ok(h.calls.includes("activity:finish:act-validate_project:false"), h.calls.join(","));
  e.onModelStart!(2);
  assert.equal(h.phases.at(-1), "Verification passed; preparing the final result");
  e.onCompletionGate!("verify first");
  assert.equal(h.lines.at(-1), "Verification required before completion.\n");
  e.onModelStart!(3);
  assert.equal(h.phases.at(-1), "Thinking");

  e.onWorkspaceChange!(change);
  assert.equal(h.detached.length, 1, "without a view the CLI prints and keeps the change");
  e.onTaskComplete!(summary());
  assert.equal(h.lines.at(-1), "✓ Done (1 recoverable failure(s) during execution) · 1.5s · 3 model turn(s) · 4 tool call(s) · 1,200 tokens · 1 failure(s) · verified");
  e.onTaskComplete!(summary({ outcome: "unverified", verified: false, diagnostics: undefined }));
  assert.equal(h.lines.at(-1), "! Stopped unverified · 1.5s · 3 model turn(s) · 4 tool call(s) · verification noted");
  e.onTaskComplete!(summary({ outcome: "failed", changed: false, diagnostics: undefined }));
  assert.equal(h.lines.at(-1), "! Task incomplete · 1.5s · 3 model turn(s) · 4 tool call(s) · no changes");
});

test("an interactive task renders into the running view: turn banner, narration, verification receipts, file changes, plan and completion", () => {
  const h = harness({ maxTurns: 20 });
  h.attachView();
  const e = h.events;
  e.onModelStart!(2);
  assert.ok(h.calls.includes("view:turn:2/20") && h.calls.includes("view:activity:Model turn 2/20 started"), h.calls.join(","));
  assert.equal(h.lines.at(-1), "● Model turn 2/20 started");
  e.onText!("final");
  e.onTextDelta!("x");
  assert.equal(h.lines.length, 1, "interactive text waits for the complete turn");
  assert.deepEqual(h.writes, [], "no raw streaming into the view");
  e.onAssistantTurn!("I will now edit the file carefully", true);
  assert.equal(h.lines.at(-1), "Reasoning summary: I will now edit the file\n");
  e.onAssistantTurn!("no", true);
  assert.equal(h.lines.length, 2, "an empty narration prints nothing");

  e.onToolStart!("edit_file", "edit src/a.ts", { changesWorkspace: true, verification: false, risk: "write" });
  assert.ok(h.calls.includes("view:tool:edit_file:edit src/a.ts:true:false"));
  e.onToolEnd!("edit_file", "Edited src/a.ts", { result: { status: "success" } as never, verification: false });
  assert.ok(!h.calls.some((call) => call.startsWith("view:important:")), "a plain write is not an important action");
  e.onToolStart!("run_process", "run npm test", { changesWorkspace: false, verification: false, risk: "execute" });
  e.onToolEnd!("run_process", "Exit code: 0", { result: { status: "success" } as never, verification: false });
  assert.ok(h.calls.some((call) => call.startsWith("view:important:") && call.includes("run npm test")), "an executed command is recorded as an important action");
  e.onToolStart!("validate_project", "run the project checks", { changesWorkspace: false, verification: true, risk: "execute" });
  e.onToolEnd!("validate_project", "ok", { result: { status: "success" } as never, verification: true });
  assert.ok(h.calls.includes("view:verified") && h.calls.includes("view:important:Verified: run the project checks"), h.calls.join(","));
  e.onModelStart!(3);
  assert.equal(h.phases.at(-1), "Verification passed; preparing the final result");
  h.reset();
  e.onModelStart!(4);
  assert.equal(h.phases.at(-1), "Thinking", "a new task starts without the previous task's verification");

  h.lines.length = 0;
  e.onWorkspaceChange!(change);
  assert.equal(h.detached.length, 0);
  assert.ok(h.calls.includes("view:change:write src/a.ts with token sk-live-secret-1234567890"));
  assert.deepEqual(h.lines, ["△ File change: write src/a.ts with token [redacted]", "  √ Modified src/a.ts +1 -2", "    @@ -1 +1 @@", "    -old [redacted]", "    +new", ""]);

  h.lines.length = 0;
  e.onPlanUpdate!({ goal: "ship", updatedAt: "now", steps: [{ id: "1", title: "step one", status: "completed" }, { id: "2", title: "step two", status: "in_progress" }, { id: "3", title: "step three", status: "pending" }] } as never);
  assert.ok(h.calls.includes("view:plan:3"));
  assert.equal(h.lines.at(-1), "Task plan updated: 1/3; now: step two\nUse /tasks to view the full plan.\n");

  h.lines.length = 0;
  e.onProviderFailover!({ fromProviderId: "a", fromModel: "m1", toProviderId: "b", toModel: "m2", reason: "timeout", skipped: [{ providerId: "c", reason: "no tools" }] });
  assert.match(h.lines[0] ?? "", /^↪ Provider failover: a\/m1 → b\/m2 /);
  assert.equal(h.lines[1], "c: no tools\n");
  assert.equal(h.phases.at(-1), "Continuing with b");
  e.onProviderRoute!({ phase: "verification", fromProviderId: "a", fromModel: "m1", toProviderId: "b", toModel: "m2", reason: "cheaper" });
  assert.equal(h.lines.at(-1), "↪ Stage route (verification): a/m1 → b/m2\ncheaper\n");
  e.onProviderRouteSkipped!({ phase: "planning", providerId: "a", model: "m1", targetProviderId: "b", reason: "no vision" });
  assert.equal(h.lines.at(-1), "Stage route (planning) did not switch to b: no vision\n");

  h.lines.length = 0;
  e.onTaskComplete!(summary({ outcome: "failed" }));
  assert.ok(h.calls.includes("view:finishing"));
  assert.ok(h.calls.some((call) => call.startsWith("view:completion:false:! Task incomplete · 1.5s")), h.calls.join(","));
  assert.deepEqual(h.lines, [], "the view owns the completion line");
  e.onFailure!("model gave up");
  assert.equal(h.lines.at(-1), "model gave up\n");
  assert.ok(h.calls.includes("view:activity:Failure: model gave up"));
});

test("the Chinese wording follows the session language", () => {
  const h = harness({ language: "zh-CN", maxTurns: 5 });
  h.attachView();
  h.events.onModelStart!(1);
  assert.equal(h.lines.at(-1), "● 模型第 1/5 轮开始");
  assert.equal(h.phases.at(-1), "思考中");
  h.events.onTaskComplete!(summary({ diagnostics: undefined }));
  assert.ok(h.calls.some((call) => call === "view:completion:true:✓ 已完成 · 1.5 秒 · 3 轮模型调用 · 4 次工具调用 · 已验证"), h.calls.join(","));
});

test("compactTerminalDescription collapses whitespace and truncates by character, not by byte", () => {
  assert.equal(compactTerminalDescription("  run   npm\n  test "), "run npm test");
  const long = "字".repeat(200);
  const compact = compactTerminalDescription(long);
  assert.equal([...compact].length, 180);
  assert.ok(compact.endsWith("..."));
  assert.equal(compactTerminalDescription("short", 10), "short");
});
