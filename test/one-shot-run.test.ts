import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, AgentRunOutcome } from "../src/agent.js";
import type { JsonEventStream } from "../src/json-event-stream.js";
import { runOneShotTask, type OneShotRunContext } from "../src/one-shot-run.js";
import type { SessionReplayTurn } from "../src/session.js";

const plain = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

type Status = ReturnType<Agent["status"]>;

function harness(options: {
  outcome?: AgentRunOutcome;
  failureReason?: Status["failureReason"];
  completionIssues?: string[];
  json?: boolean;
  run?: (onStarted: () => void) => Promise<unknown>;
  recordError?: Error;
  pendingQuestion?: string;
  language?: "zh-CN" | "en-US";
} = {}) {
  const errors: string[] = [];
  const lines: string[] = [];
  const replays: SessionReplayTurn[] = [];
  const started: unknown[] = [];
  const results: Array<Record<string, unknown>> = [];
  let clock = 1_000;
  const status = (): Status => ({
    model: "gpt-x", messages: 2, contextLimit: 1, contextWindow: 1, contextWindowSource: "x", contextLimitMode: "x", planMode: false,
    stats: { modelCalls: 3, toolCalls: 4, inputTokens: 100, outputTokens: 50, estimatedTokens: 150, compactions: 0, activeMs: 10 },
    outcome: options.outcome ?? "completed",
    failureReason: options.failureReason,
    completionIssues: options.completionIssues,
    turn: 1, pendingSteering: 0,
    diagnostics: { version: 1, task: "t", startedAt: "s", updatedAt: "u", outcome: "completed" } as Status["diagnostics"],
  });
  const jsonStream: Pick<JsonEventStream, "started" | "result"> | undefined = options.json ? {
    started: (payload) => { started.push(payload); },
    result: (payload) => { results.push(payload); return payload.outcome === "completed" ? 0 : payload.outcome === "unverified" ? 2 : payload.outcome === "waiting_user" ? 3 : 1; },
  } : undefined;
  const context: OneShotRunContext = {
    task: "write the notes",
    language: options.language ?? "en-US",
    agent: {
      status,
      recordReplayTurn: async (turn) => { if (options.recordError) throw options.recordError; replays.push(turn); },
    },
    jsonStream,
    started: { version: "0.0.0", provider: "openai", model: "gpt-x", workspace: "/workspace", language: options.language ?? "en-US" },
    run: options.run ?? (async (onStarted) => { onStarted(); return "ok"; }),
    changes: () => [{ description: "notes.txt", files: [] } as never],
    pendingQuestion: () => options.pendingQuestion,
    redact: (value) => value.replace("sk-secret", "[redacted]"),
    emitLine: (value) => { lines.push(plain(value)); },
    io: { error: (line) => { errors.push(plain(line)); }, now: () => { clock += 500; return clock; } },
  };
  return { context, errors, lines, replays, started, results };
}

test("a completed run exits 0 and saves the turn to the session history", async () => {
  const h = harness();
  assert.equal(await runOneShotTask(h.context), 0);
  assert.equal(h.replays.length, 1);
  assert.deepEqual(h.replays[0], {
    task: "write the notes", inputKind: "task", supplements: [], changes: [{ description: "notes.txt", files: [] }], receipts: [],
    completion: { message: "completed", success: true }, diagnostics: h.context.agent.status().diagnostics, exact: true,
  });
  assert.deepEqual([h.errors, h.lines, h.started, h.results], [[], [], [], []]);
});

test("the exit code follows the outcome without --json: 2 unverified, 3 waiting for an answer, 1 failed", async () => {
  assert.equal(await runOneShotTask(harness({ outcome: "unverified" }).context), 2);
  assert.equal(await runOneShotTask(harness({ outcome: "waiting_user" }).context), 3);
  const failed = harness({ outcome: "failed" });
  assert.equal(await runOneShotTask(failed.context), 1);
  assert.deepEqual(failed.replays[0]?.completion, { message: "failed", success: false });
});

test("--json writes session.started first and a result line with outcome, stats, question and duration", async () => {
  const h = harness({ json: true, outcome: "waiting_user", pendingQuestion: "Which file?", completionIssues: [] });
  assert.equal(await runOneShotTask(h.context), 3);
  assert.deepEqual(h.started, [{ version: "0.0.0", provider: "openai", model: "gpt-x", workspace: "/workspace", language: "en-US" }]);
  assert.deepEqual(h.results, [{
    outcome: "waiting_user", failureReason: undefined, completionIssues: undefined, pendingQuestion: "Which file?",
    stats: { modelCalls: 3, toolCalls: 4, inputTokens: 100, outputTokens: 50, estimatedTokens: 150 }, durationMs: 500,
  }]);
  const issues = harness({ json: true, outcome: "unverified", failureReason: "verification_failed", completionIssues: ["no check ran"] });
  assert.equal(await runOneShotTask(issues.context), 2);
  assert.equal(issues.results[0]?.failureReason, "verification_failed");
  assert.deepEqual(issues.results[0]?.completionIssues, ["no check ran"]);
});

test("a failure before the task started is rethrown for main() to explain, and nothing is saved", async () => {
  const h = harness({ run: async () => { throw new Error("provider down"); } });
  await assert.rejects(runOneShotTask(h.context), /provider down/);
  assert.deepEqual([h.replays, h.errors], [[], []]);
});

test("a failure after the task started reports 'Task stopped', redacts the message and exits by the outcome", async () => {
  const h = harness({ outcome: "cancelled", run: async (onStarted) => { onStarted(); throw new Error("stopped with sk-secret"); } });
  assert.equal(await runOneShotTask(h.context), 1);
  assert.deepEqual(h.errors, ["Task stopped: stopped with [redacted]\n"]);
  assert.equal(h.replays.length, 1, "the started run is still saved to the history");
});

test("with --json a failure becomes the result line: not_started before the task began, the outcome after", async () => {
  const before = harness({ json: true, run: async () => { throw new Error("provider down"); } });
  assert.equal(await runOneShotTask(before.context), 1);
  assert.deepEqual(before.results, [{ outcome: "not_started", error: "provider down", durationMs: 500 }]);
  assert.deepEqual(before.replays, []);
  const after = harness({ json: true, outcome: "cancelled", run: async (onStarted) => { onStarted(); throw new Error("sk-secret leaked"); } });
  assert.equal(await runOneShotTask(after.context), 1);
  assert.deepEqual(after.results, [{ outcome: "cancelled", error: "[redacted] leaked", durationMs: 500 }]);
  assert.equal(after.replays.length, 1);
});

test("a session-history save failure is reported in one line and never changes the exit code", async () => {
  const h = harness({ recordError: new Error("disk full") });
  assert.equal(await runOneShotTask(h.context), 0);
  assert.deepEqual(h.lines, ["Could not save this turn to the session history: disk full. The task result is unaffected, but /resume will not show this turn."]);
});

test("Chinese wording is used when the session language is zh-CN", async () => {
  const h = harness({ language: "zh-CN", outcome: "cancelled", recordError: new Error("磁盘已满"), run: async (onStarted) => { onStarted(); throw new Error("已取消"); } });
  assert.equal(await runOneShotTask(h.context), 1);
  assert.deepEqual(h.errors, ["任务已停止: 已取消\n"]);
  assert.deepEqual(h.lines, ["未能保存本轮会话记录：磁盘已满。任务结果不受影响，但 /resume 不会看到这一轮。"]);
});
