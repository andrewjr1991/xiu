import assert from "node:assert/strict";
import test from "node:test";
import { SafeRequestCache } from "../src/request-cache.js";

test("safe request cache joins identical in-flight metadata requests", async () => {
  const cache = new SafeRequestCache(1_000);
  let calls = 0;
  let release!: (value: string) => void;
  const operation = () => {
    calls++;
    return new Promise<string>((resolve) => { release = resolve; });
  };
  const first = cache.run("provider:model-list", operation, false);
  const second = cache.run("provider:model-list", operation, false);
  assert.equal(calls, 1);
  release("models");
  assert.deepEqual(await Promise.all([first, second]), ["models", "models"]);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 1, joins: 1, entries: 0 });
});
test("safe request cache expires completed metadata and never caches failures", async () => {
  let now = 100;
  const cache = new SafeRequestCache(50, 2, () => now);
  let calls = 0;
  const read = () => cache.run("models", async () => ++calls);
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  now = 151;
  assert.equal(await read(), 2);
  await assert.rejects(cache.run("failure", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.run("failure", async () => 3), 3);
  assert.equal(calls, 2);
});
