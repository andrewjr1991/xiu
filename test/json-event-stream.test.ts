import assert from "node:assert/strict";
import test from "node:test";
import { createJsonEventStream, formatJsonLine, ONE_SHOT_EXIT_CODES, oneShotExitCode, redirectHumanOutputToStderr } from "../src/json-event-stream.js";
import type { RuntimeEvent } from "../src/runtime/protocol.js";

const event = (type: RuntimeEvent["type"], payload: Record<string, unknown>, sequence = 1): RuntimeEvent => ({
  schemaVersion: 1, eventId: `event-${sequence}`, taskId: "task-1", sequence, timestamp: "2026-10-19T00:00:00.000Z", type, payload,
} as RuntimeEvent);

test("JSON stream writes exactly one parseable line per event with newlines escaped", () => {
  const lines: string[] = [];
  const stream = createJsonEventStream((text) => lines.push(text), () => new Date("2026-10-19T00:00:00.000Z"));
  stream.started({ version: "0.20.13", provider: "fake", model: "fake-model", workspace: "/tmp/ws", language: "en-US" });
  stream.event(event("assistant.message", { text: "line one\nline two\r\n end", hasToolCalls: false }));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(line.endsWith("\n"));
    assert.equal(line.slice(0, -1).includes("\n"), false, "a JSON line never contains a raw newline");
    JSON.parse(line);
  }
  const parsed = JSON.parse(lines[1]!) as RuntimeEvent<"assistant.message">;
  assert.equal(parsed.type, "assistant.message");
  assert.equal(parsed.payload.text, "line one\nline two\r\n end");
});

test("the result line is written once, carries the exit code and redacts secrets", () => {
  const lines: string[] = [];
  const stream = createJsonEventStream((text) => lines.push(text), () => new Date(0), (value) => value.replace("sk-secret-value", "[REDACTED]"));
  assert.equal(stream.finished, false);
  const code = stream.result({ outcome: "unverified", failureReason: "verification_failed", completionIssues: ["tests did not run"], error: "key sk-secret-value leaked", stats: { modelCalls: 2, toolCalls: 1, inputTokens: 10, outputTokens: 5, estimatedTokens: 15 }, durationMs: 1200 });
  assert.equal(code, ONE_SHOT_EXIT_CODES.unverified);
  assert.equal(stream.finished, true);
  assert.equal(stream.result({ outcome: "completed" }), ONE_SHOT_EXIT_CODES.completed, "a late result still reports its code");
  stream.event(event("task.state", { state: "completed" }, 9));
  assert.equal(lines.length, 1, "nothing is written after the result line");
  const result = JSON.parse(lines[0]!);
  assert.equal(result.type, "result");
  assert.equal(result.payload.success, false);
  assert.equal(result.payload.exitCode, 2);
  assert.equal(result.payload.error, "key [REDACTED] leaked");
  assert.deepEqual(result.payload.completionIssues, ["tests did not run"]);
  assert.equal(result.payload.stats.toolCalls, 1);
});

test("one-shot exit codes distinguish success, unverified, open questions and failures", () => {
  assert.equal(oneShotExitCode("completed"), 0);
  assert.equal(oneShotExitCode("unverified"), 2);
  assert.equal(oneShotExitCode("waiting_user"), 3);
  for (const outcome of ["failed", "cancelled", "paused", "not_started", "idle", "running"] as const) assert.equal(oneShotExitCode(outcome), 1, outcome);
  assert.equal(formatJsonLine({ schemaVersion: 1, type: "result", timestamp: "t", payload: { outcome: "completed", success: true, exitCode: 0 } }).trim(), '{"schemaVersion":1,"type":"result","timestamp":"t","payload":{"outcome":"completed","success":true,"exitCode":0}}');
});

test("redirecting human output keeps stdout for the stream and restores the console afterwards", () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const fakeStdout = { write: (chunk: string | Uint8Array) => { stdoutChunks.push(String(chunk)); return true; } } as unknown as NodeJS.WriteStream;
  const fakeStderr = { write: (chunk: string | Uint8Array) => { stderrChunks.push(String(chunk)); return true; } } as unknown as NodeJS.WriteStream;
  const originalLog = console.log;
  const originalError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => { consoleErrors.push(args); };
  try {
    const redirected = redirectHumanOutputToStderr(fakeStdout, fakeStderr);
    fakeStdout.write("spinner frame");
    console.log("human text", 42);
    redirected.writeStdout('{"type":"result"}\n');
    assert.deepEqual(stdoutChunks, ['{"type":"result"}\n']);
    assert.deepEqual(stderrChunks, ["spinner frame"]);
    assert.deepEqual(consoleErrors, [["human text", 42]]);
    redirected.restore();
    assert.equal(console.log, originalLog);
    fakeStdout.write("after restore");
    assert.deepEqual(stdoutChunks, ['{"type":"result"}\n', "after restore"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
