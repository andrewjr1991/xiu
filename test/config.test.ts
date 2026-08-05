import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../src/config.js";

test("Agnes preset selects its compatible endpoint and model", () => {
  const config = resolveConfig({ provider: "agnes" });
  assert.equal(config.provider, "agnes");
  assert.equal(config.model, "agnes-2.5-flash");
  assert.equal(config.baseURL, "https://apihub.agnes-ai.com/v1");
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
});
