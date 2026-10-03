import assert from "node:assert/strict";
import test from "node:test";
import { watchModelRequest } from "../src/model-request-watchdog.js";

test("first response and complete response can take longer than stream idle allowance", async () => {
  for (const completeMs of [undefined, 100]) {
    assert.equal(await watchModelRequest(new AbortController().signal, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50)); return "done";
    }, { firstResponseMs: 100, streamIdleMs: 15, completeMs }), "done");
  }
});

test("after initial progress only the stream idle deadline applies", async () => {
  await assert.rejects(watchModelRequest(new AbortController().signal, async (_, progress) => {
    progress(); return new Promise(() => undefined);
  }, { firstResponseMs: 100, streamIdleMs: 20 }), (error: unknown) => {
    assert.equal((error as { phase: string }).phase, "stream-idle"); return true;
  });
});

test("non-streaming timeout is labelled complete, not silence", async () => {
  await assert.rejects(watchModelRequest(new AbortController().signal, async () => new Promise(() => undefined),
    { firstResponseMs: 100, streamIdleMs: 5, completeMs: 20 }), (error: unknown) => {
    assert.equal((error as { phase: string }).phase, "complete"); return true;
  });
});

test("silent provider is interrupted even if it ignores abort", async () => {
  let signal!: AbortSignal;
  await assert.rejects(watchModelRequest(new AbortController().signal, async (child) => {
    signal = child;
    return new Promise(() => undefined);
  }, 20), /No model data/);
  assert.equal(signal.aborted, true);
});

test("streamed tool arguments keep a long request alive", async () => {
  const result = await watchModelRequest(new AbortController().signal, async (_, progress) => {
    const interval = setInterval(progress, 5);
    try { await new Promise((resolve) => setTimeout(resolve, 80)); return "complete"; }
    finally { clearInterval(interval); }
  }, 30);
  assert.equal(result, "complete");
});

test("stop cancels a hung request promptly and does not restart it", async () => {
  const parent = new AbortController();
  let calls = 0;
  const result = watchModelRequest(parent.signal, async () => { calls++; return new Promise(() => undefined); });
  parent.abort(new Error("user stop"));
  await assert.rejects(result, /user stop/);
  assert.equal(calls, 1);
});
