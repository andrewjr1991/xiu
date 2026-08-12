import assert from "node:assert/strict";
import test from "node:test";
import { classifyRetryError, retryDecision, retryDelay } from "../src/retry-policy.js";
import { executeTool } from "../src/tools.js";
import type { AgentTool } from "../src/types.js";

test("retry classification keeps deterministic and user-driven failures final", () => {
  assert.equal(classifyRetryError(Object.assign(new Error("bad key"), { status: 401 })), "authentication");
  assert.equal(classifyRetryError(Object.assign(new Error("forbidden"), { status: 403 })), "authorization");
  assert.equal(classifyRetryError(Object.assign(new Error("bad input"), { status: 422 })), "invalid-request");
  assert.equal(classifyRetryError(Object.assign(new Error("cancelled"), { name: "AbortError" })), "cancelled");
  for (const error of [
    Object.assign(new Error("bad key"), { status: 401 }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    Object.assign(new Error("bad input"), { status: 400 }),
    Object.assign(new Error("cancelled"), { name: "AbortError" }),
  ]) {
    assert.equal(retryDecision({ operation: "model", error, attempt: 1, maxAttempts: 3, replaySafety: "safe" }).retry, false);
  }
});

test("retry decision requires both a transient failure and safe replay state", () => {
  const error = Object.assign(new Error("busy"), { status: 503, retryAfterMs: 7 });
  assert.deepEqual(retryDecision({ operation: "mcp", error, attempt: 1, maxAttempts: 3, replaySafety: "safe", commitState: "not-committed" }), {
    category: "server", retry: true, delayMs: 7, reason: "server error on a safely replayable mcp operation",
  });
  assert.equal(retryDecision({ operation: "mcp", error, attempt: 1, maxAttempts: 3, replaySafety: "side-effecting", commitState: "unknown" }).retry, false);
  assert.equal(retryDecision({ operation: "model", error, attempt: 1, maxAttempts: 3, replaySafety: "safe", outputEmitted: true }).retry, false);
  assert.equal(retryDecision({ operation: "tool", error, attempt: 3, maxAttempts: 3, replaySafety: "safe" }).retry, false);
});

test("safe read tools retry transient errors within a bounded budget", async () => {
  let calls = 0;
  const progress: string[] = [];
  const tool: AgentTool = {
    name: "mcp__test__read",
    description: "read",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    replaySafety: "safe",
    maxAttempts: 3,
    describe: () => "read remote state",
    async execute() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("temporary"), { status: 503, retryAfterMs: 0 });
      return "ok";
    },
  };
  const result = await executeTool(tool, {}, { cwd: process.cwd(), approve: async () => true, reportProgress: (message) => progress.push(message) });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(progress.length, 2);
});

test("side-effecting tools never replay an uncertain submission", async () => {
  let calls = 0;
  const tool: AgentTool = {
    name: "remote_write",
    description: "write",
    inputSchema: { type: "object", properties: {} },
    risk: "write",
    describe: () => "write remote state",
    async execute() {
      calls += 1;
      throw Object.assign(new Error("connection reset after submit"), { code: "ECONNRESET" });
    },
  };
  const result = await executeTool(tool, {}, { cwd: process.cwd(), approve: async () => true });
  assert.match(result, /connection reset/);
  assert.equal(calls, 1);
});

test("safe tools do not retry authentication, invalid arguments, or cancellation", async () => {
  for (const error of [
    Object.assign(new Error("unauthorized"), { status: 401 }),
    Object.assign(new Error("invalid arguments"), { status: 400 }),
    Object.assign(new Error("cancelled"), { name: "AbortError" }),
  ]) {
    let calls = 0;
    const tool: AgentTool = {
      name: "safe_read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      describe: () => "read",
      async execute() { calls += 1; throw error; },
    };
    const result = await executeTool(tool, {}, { cwd: process.cwd(), approve: async () => true });
    assert.match(result, /Tool error/);
    assert.equal(calls, 1);
  }
});

test("retry delay can be cancelled without waiting for the timer", async () => {
  const controller = new AbortController();
  const waiting = retryDelay(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: Error) => error.name === "AbortError");
});
