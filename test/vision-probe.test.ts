import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { createVisionChallenge, verifyVisionChallenge, visionProbePrompt } from "../src/vision-probe.js";
import { VisionProbeController } from "../apps/desktop/main/vision-probe-controller.js";
import { resolveConfig } from "../src/config.js";

test("PNG challenge has six random digits, actual pixels and no answer metadata", () => {
  const challenge = createVisionChallenge();
  assert.match(challenge.code, /^\d{6}$/);
  const png = Buffer.from(challenge.image.split(",")[1]!, "base64");
  assert.equal(png.readUInt32BE(16), 320); assert.equal(png.readUInt32BE(20), 100);
  const length = png.readUInt32BE(33);
  const pixels = inflateSync(png.subarray(41, 41 + length));
  assert.equal(pixels.length, 96100);
  assert.ok(pixels.includes(20));
  assert.ok(!visionProbePrompt.includes(challenge.code));
  // Decode independently from the drawn pixels, not the response evaluator.
  const glyphs = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001010010010", "111101111101111", "111101111001111"];
  let decoded = "";
  for (let i = 0; i < 6; i++) {
    let glyph = "";
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) glyph += pixels[(30 + y * 10) * 961 + 1 + (25 + i * 48 + x * 10) * 3] === 20 ? "1" : "0";
    decoded += glyphs.indexOf(glyph);
  }
  assert.equal(decoded, challenge.code);
});
test("vision verification does not confuse wrong, malformed and passed responses", () => {
  assert.equal(verifyVisionChallenge('{"code":"012345"}', "012345"), "passed");
  assert.equal(verifyVisionChallenge('```json\n{"code":"012345"}\n```', "012345"), "passed");
  assert.equal(verifyVisionChallenge('{"code":"012346"}', "012345"), "failed");
  for (const answer of ['{"code":12345}', "I cannot see images", '{"code":"123"}', "x".repeat(4097)]) assert.equal(verifyVisionChallenge(answer, "012345"), "unknown");
});
const config = () => resolveConfig({ provider: "openai-compatible", model: "fixture", baseURL: "https://fixture.invalid/v1" });
test("cancelled confirmation sends zero requests and validates no grant", async () => {
  let calls = 0;
  const result = await new VisionProbeController().run(config(), async () => false, async () => {}, async () => { calls++; return ""; });
  assert.equal(result.status, "cancelled"); assert.equal(calls, 0);
});
test("request errors remain unknown without retries or error leakage", async () => {
  let calls = 0;
  const result = await new VisionProbeController().run(config(), async () => true, async () => {}, async () => { calls++; throw new Error("secret-canary"); });
  assert.equal(result.status, "unknown"); assert.equal(calls, 1); assert.ok(!result.message.includes("secret-canary"));
});
test("changed context prevents network request", async () => {
  let calls = 0;
  await assert.rejects(new VisionProbeController().run(config(), async () => true, async () => { throw new Error("changed"); }, async () => { calls++; return ""; }), /changed/);
  assert.equal(calls, 0);
});
test("timeout is bounded even when backend ignores cancellation", async () => {
  const result = await new VisionProbeController().run(config(), async () => true, async () => {}, () => new Promise(() => {}), 5);
  assert.equal(result.status, "unknown"); assert.match(result.message, /超时/);
});
test("stop cancels in-flight request, rejects overlap, ignores late response", async () => {
  const controller = new VisionProbeController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = controller.run(config(), async () => true, async () => {}, () => { started(); return new Promise(() => {}); });
  await ready;
  await assert.rejects(controller.run(config(), async () => true, async () => {}), /已有/);
  controller.cancel(); assert.equal((await pending).status, "cancelled");
});

test("batch confirms exact list once, tests each model serially and retains individual outcomes", async () => {
  const controller = new VisionProbeController(); let confirmations = 0; let active = 0; let maxActive = 0;
  const configs = ["one", "two", "three"].map(model => ({ ...config(), model, capabilities: { text: model, vision: model } }));
  const requested: string[] = [];
  const result = await controller.runBatch(configs, async route => { confirmations++; assert.match(route, /共 3 个/); for (const model of ["one", "two", "three"]) assert.ok(route.includes(model)); return true; }, async () => {}, async current => {
    requested.push(current.model); maxActive = Math.max(maxActive, ++active); await Promise.resolve(); active--;
    if (current.model === "two") throw new Error("secret-canary"); return '{"code":"wrong"}';
  });
  assert.equal(confirmations, 1); assert.equal(maxActive, 1); assert.deepEqual(requested, ["one", "two", "three"]);
  assert.deepEqual(result.results.map(row => row.model), requested); assert.equal(result.results[1]?.status, "unknown");
  assert.ok(!JSON.stringify(result).includes("secret-canary")); assert.equal(controller.snapshot().current, undefined);
  assert.equal(controller.snapshot().results.length, 0, "finished batch must not leak into the next progress poll");
});
test("batch cancellation stops remaining requests, preserving completed rows", async () => {
  const controller = new VisionProbeController(); let calls = 0;
  const configs = ["one", "two", "three"].map(model => ({ ...config(), model, capabilities: { text: model, vision: model } }));
  const result = await controller.runBatch(configs, async () => true, async () => {}, async current => {
    calls++; if (current.model === "two") controller.cancel(); return "{}";
  });
  assert.equal(calls, 2); assert.equal(result.status, "cancelled"); assert.equal(result.results.length, 2); assert.equal(result.results[1]?.status, "cancelled");
});
test("declined batch and invalid lists cannot invoke models", async () => {
  const controller = new VisionProbeController(); let calls = 0;
  const result = await controller.runBatch([config()], async () => false, async () => {}, async () => { calls++; return "{}"; });
  assert.equal(result.status, "cancelled"); assert.equal(calls, 0);
  for (const configs of [[], [config(), config()], Array.from({length: 201}, (_, index) => ({ ...config(), model: String(index) }))]) await assert.rejects(controller.runBatch(configs, async () => true, async () => {}));
});
test("context change between batch models stops before further billing", async () => {
  let calls = 0; const controller = new VisionProbeController();
  await assert.rejects(controller.runBatch(["one", "two"].map(model => ({ ...config(), model, capabilities: { text: model, vision: model } })), async () => true, async () => { if (calls === 1) throw new Error("changed"); }, async () => { calls++; return "{}"; }));
  assert.equal(calls, 1);
});
test("synchronous backend construction failures remain inconclusive and allow the next candidate", async () => {
  const controller = new VisionProbeController(); let calls = 0;
  const result = await controller.runBatch(["one", "two"].map(model => ({ ...config(), model, capabilities: { text: model, vision: model } })), async () => true, async () => {}, () => { calls++; throw new Error("credential-canary"); });
  assert.equal(calls, 2); assert.equal(result.results.length, 2); assert.ok(result.results.every(row => row.status === "unknown")); assert.ok(!JSON.stringify(result).includes("credential-canary"));
});
