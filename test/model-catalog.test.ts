import assert from "node:assert/strict";
import test from "node:test";
import { selectableCapabilityModels, selectableModels } from "../src/model-catalog.js";

test("model catalog keeps current and chat models while filtering non-chat endpoints", () => {
  const models = selectableModels("openai", "custom-chat", [
    { id: "gpt-api-model", source: "api" },
    { id: "text-embedding-3-large", source: "api" },
    { id: "image-generator", source: "api" },
    { id: "video-model", source: "api" },
  ]);
  assert.equal(models[0]?.id, "custom-chat");
  assert.ok(models.some((model) => model.id === "gpt-api-model"));
  assert.ok(models.some((model) => model.id === "gpt-5"));
  assert.ok(!models.some((model) => model.id.includes("embedding")));
  assert.ok(!models.some((model) => model.id.includes("image")));
  assert.ok(!models.some((model) => model.id.includes("video")));
});

test("model catalog de-duplicates provider and built-in model ids", () => {
  const models = selectableModels("agnes", "agnes-2.5-flash", [
    { id: "agnes-2.5-flash", name: "Live Agnes", source: "api" },
  ]);
  assert.equal(models.filter((model) => model.id === "agnes-2.5-flash").length, 1);
  assert.equal(models[0]?.source, "current");
});

test("model catalog localizes the current-model description", () => {
  const models = selectableModels("agnes", "agnes-2.5-flash", [], "zh-CN");
  assert.equal(models[0]?.description, "当前会话模型");
});

test("model catalog classifies discovered media models without mixing them into chat", () => {
  const discovered = [
    { id: "vendor-chat", source: "api" as const },
    { id: "vendor-image-pro", source: "api" as const },
    { id: "vendor-sora-video", source: "api" as const },
    { id: "vendor-tts-1", source: "api" as const },
    { id: "opaque-model", source: "api" as const, capabilities: ["audio"] },
  ];
  assert.deepEqual(selectableCapabilityModels("image", undefined, discovered).map((model) => model.id), ["vendor-image-pro"]);
  assert.deepEqual(selectableCapabilityModels("video", undefined, discovered).map((model) => model.id), ["vendor-sora-video"]);
  assert.deepEqual(selectableCapabilityModels("audio", undefined, discovered).map((model) => model.id), ["opaque-model", "vendor-tts-1"]);
  assert.equal(selectableModels("openai-compatible", "vendor-chat", discovered).some((model) => model.id === "vendor-tts-1"), false);
});
