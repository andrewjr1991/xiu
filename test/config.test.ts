import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { refreshModelContext } from "../src/context.js";

test("Agnes preset selects its compatible endpoint and model", () => {
  const config = resolveConfig({ provider: "agnes" });
  assert.equal(config.provider, "agnes");
  assert.equal(config.model, "agnes-2.5-flash");
  assert.equal(config.baseURL, "https://apihub.agnes-ai.com/v1");
  assert.equal(config.contextWindow, 512_000);
  assert.equal(config.contextWindowSource, "official");
  assert.equal(config.contextLimit, 409_600);
  assert.equal(config.contextLimitMode, "automatic");
  assert.deepEqual(config.capabilities, {
    text: "agnes-2.5-flash",
    vision: "agnes-2.5-flash",
    image: "agnes-image-2.1-flash",
    video: "agnes-video-v2.0",
  });
});

test("one unified model can serve every capability", () => {
  const config = resolveConfig({ provider: "agnes", unifiedModel: "agnes-omni" });
  assert.equal(config.model, "agnes-omni");
  assert.equal(config.contextWindow, 128_000);
  assert.equal(config.contextWindowSource, "fallback");
  assert.deepEqual(config.capabilities, {
    text: "agnes-omni",
    vision: "agnes-omni",
    image: "agnes-omni",
    video: "agnes-omni",
    unified: "agnes-omni",
  });
});

test("capability-specific models are configurable", () => {
  const config = resolveConfig({
    provider: "agnes",
    visionModel: "vision-x",
    imageModel: "image-x",
    videoModel: "video-x",
  });
  assert.equal(config.capabilities?.vision, "vision-x");
  assert.equal(config.capabilities?.image, "image-x");
  assert.equal(config.capabilities?.video, "video-x");
});

test("OpenAI and Anthropic automatically reuse the text model for vision only", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const config = resolveConfig({ provider, model: `${provider}-model` });
    assert.deepEqual(config.capabilities, {
      text: `${provider}-model`,
      vision: `${provider}-model`,
    });
  }
});

test("unified override does not claim unsupported generation APIs", () => {
  const config = resolveConfig({ provider: "openai", unifiedModel: "omni-model" });
  assert.deepEqual(config.capabilities, {
    text: "omni-model",
    vision: "omni-model",
    unified: "omni-model",
  });
});

test("proxy option is validated and stored", () => {
  const config = resolveConfig({ provider: "agnes", proxy: "http://127.0.0.1:12334" });
  assert.equal(config.proxy, "http://127.0.0.1:12334");
  assert.throws(() => resolveConfig({ provider: "agnes", proxy: "not a URL" }), /valid URL/);
  assert.throws(() => resolveConfig({ provider: "agnes", proxy: "socks5://127.0.0.1:1080" }), /http:\/\//);
});

test("context limit is configurable and validated", () => {
  assert.equal(resolveConfig({ contextLimit: "12000" }).contextLimit, 12000);
  assert.throws(() => resolveConfig({ contextLimit: "3999" }), /at least 4000/);
  assert.throws(() => resolveConfig({ contextWindow: "10000", contextLimit: "9500" }), /must not exceed 90%/);
});

test("context window can be configured when provider metadata is unavailable", () => {
  const config = resolveConfig({ provider: "openai", model: "private-model", contextWindow: "200000" });
  assert.equal(config.contextWindow, 200_000);
  assert.equal(config.contextWindowSource, "configured");
  assert.equal(config.contextLimit, 160_000);
});

test("model changes refresh automatic metadata but preserve explicit window overrides", () => {
  const automatic = resolveConfig({ provider: "agnes" });
  refreshModelContext(automatic, "private-model");
  assert.equal(automatic.contextWindow, 128_000);
  assert.equal(automatic.contextWindowSource, "fallback");
  assert.equal(automatic.contextLimit, 102_400);

  const configured = resolveConfig({ provider: "agnes", contextWindow: "200000" });
  refreshModelContext(configured, "private-model");
  assert.equal(configured.contextWindow, 200_000);
  assert.equal(configured.contextWindowSource, "configured");
  assert.equal(configured.contextLimit, 160_000);
});

test("primary agent has no turn limit unless the user explicitly sets one", () => {
  assert.equal(resolveConfig({ provider: "openai" }).maxTurns, undefined);
  assert.equal(resolveConfig({ provider: "openai", maxTurns: "45" }).maxTurns, 45);
  assert.throws(() => resolveConfig({ provider: "openai", maxTurns: "0" }), /max-turns/);
});

test("multi-agent concurrency is bounded", () => {
  assert.equal(resolveConfig({ provider: "openai", agentConcurrency: "4" }).agentConcurrency, 4);
  assert.throws(() => resolveConfig({ provider: "openai", agentConcurrency: "0" }), /agent-concurrency/);
  assert.throws(() => resolveConfig({ provider: "openai", agentConcurrency: "9" }), /agent-concurrency/);
});

test("local and OpenAI-compatible provider profiles do not overclaim media capabilities", () => {
  const config = resolveConfig({
    provider: "ollama", providerId: "ollama", model: "qwen-coder", baseURL: "http://127.0.0.1:11434/v1",
    providerFeatures: { text: true, tools: true, vision: false, image: false, video: false },
  });
  assert.equal(config.providerId, "ollama");
  assert.equal(config.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(config.capabilities?.vision, "");
  assert.equal(config.providerFeatures?.vision, false);
});
