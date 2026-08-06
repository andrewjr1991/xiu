import assert from "node:assert/strict";
import test from "node:test";
import { localizeToolDescription, localizeToolProgress } from "../src/tool-display.js";

test("Chinese mode localizes built-in activity descriptions but preserves paths and commands", () => {
  assert.equal(localizeToolDescription("verify_output", "verify generated output snake.html", "zh-CN"), "验证生成结果 snake.html");
  assert.equal(localizeToolDescription("read_file", "read src/app.ts", "zh-CN"), "读取 src/app.ts");
  assert.equal(localizeToolDescription("run_command", "run: npm test", "zh-CN"), "运行：npm test");
});

test("English mode leaves tool descriptions unchanged", () => {
  assert.equal(localizeToolDescription("verify_output", "verify generated output snake.html", "en-US"), "verify generated output snake.html");
});

test("Chinese mode localizes media progress", () => {
  assert.equal(localizeToolProgress("Generating image with image-model", "zh-CN"), "正在使用以下模型生成图片：image-model");
});
