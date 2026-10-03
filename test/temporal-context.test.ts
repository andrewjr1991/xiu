import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTemporalContext } from "../src/prompt.js";
import { Agent } from "../src/agent.js";
import type { ModelProvider } from "../src/types.js";

test("host clock anchors first searches but preserves explicit historical requests", () => {
  const now = new Date(2026, 9, 3, 12);
  const context = buildTemporalContext(now);
  assert.match(context, /2026-10-03/);
  assert.ok(context.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(context, /before the FIRST search/);
  assert.match(context, /Respect explicit historical requests/);
  assert.match(context, /A year in a query does not prove freshness/);
});

test("first and subsequent provider requests receive fresh clock context", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-temporal-context-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let calls = 0;
  const provider: ModelProvider = { async complete(system) {
    calls++;
    assert.match(system, /Trusted host clock: current local date is \d{4}-\d{2}-\d{2}/);
    assert.match(system, /before the FIRST search/);
    return { text: "No sources checked.", toolCalls: [] };
  } };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 1 }, provider, [], async () => true);
  await agent.run("Search for the latest holiday news");
  await agent.run("Research holiday news from 2025");
  assert.equal(calls, 2);
});

test("streaming provider gets the same host clock before its first response", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-temporal-stream-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let streamed = false;
  const provider: ModelProvider = {
    async complete() { throw new Error("expected streaming request"); },
    async stream(system) {
      streamed = true;
      assert.match(system, /Trusted host clock/);
      assert.match(system, /before the FIRST search/);
      return { text: "No sources checked.", toolCalls: [] };
    },
  };
  const agent = new Agent({ provider: "openai", model: "test", cwd, maxTurns: 1 }, provider, [], async () => true, { onTextDelta() {} });
  await agent.run("Search for recent news");
  assert.equal(streamed, true);
});
