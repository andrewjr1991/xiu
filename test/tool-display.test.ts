import assert from "node:assert/strict";
import test from "node:test";
import { localizeToolDescription, localizeToolProgress } from "../src/tool-display.js";

test("Chinese mode localizes built-in activity descriptions but preserves paths and commands", () => {
  assert.equal(localizeToolDescription("verify_output", "verify generated output snake.html", "zh-CN"), "验证生成结果 snake.html");
  assert.equal(localizeToolDescription("read_file", "read src/app.ts", "zh-CN"), "读取 src/app.ts");
  assert.equal(localizeToolDescription("run_process", "run directly: node script.js", "zh-CN"), "直接运行：node script.js");
  assert.equal(localizeToolDescription("run_command", "run: npm test", "zh-CN"), "运行 PowerShell：npm test");
});

test("structured extraction descriptions are localized", () => {
  assert.equal(localizeToolDescription("extract_html", "extract HTML tr.item from case.html", "zh-CN"), "提取 HTML：tr.item from case.html");
  assert.equal(localizeToolDescription("extract_json", "extract JSON /orders from data.json", "zh-CN"), "提取 JSON：/orders from data.json");
  assert.equal(localizeToolDescription("extract_csv", "extract CSV rows from data.csv", "zh-CN"), "提取表格：data.csv");
});

test("code intelligence descriptions are localized", () => {
  assert.equal(localizeToolDescription("repository_map", "map repository modules under src", "zh-CN"), "查看项目地图：src");
  assert.equal(localizeToolDescription("find_symbol", "find symbol ProjectIndex", "zh-CN"), "查找符号 ProjectIndex");
  assert.equal(localizeToolDescription("find_references", "find references to ProjectIndex", "zh-CN"), "查找引用 ProjectIndex");
  assert.equal(localizeToolDescription("find_callers", "find callers of initialize", "zh-CN"), "查找调用方 initialize");
});

test("English mode leaves tool descriptions unchanged", () => {
  assert.equal(localizeToolDescription("verify_output", "verify generated output snake.html", "en-US"), "verify generated output snake.html");
});

test("Chinese mode localizes media progress", () => {
  assert.equal(localizeToolProgress("Generating image with image-model", "zh-CN"), "正在使用以下模型生成图片：image-model");
});
