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
  assert.equal(localizeToolDescription("list_media_operations", "list media operations", "zh-CN"), "查看媒体生成与恢复任务");
  assert.equal(localizeToolDescription("resume_media_operation", "resume media request abcdef12 into output.mp4 without creating a new generation", "zh-CN"), "恢复媒体请求 abcdef12，保存到 output.mp4（不创建新生成任务）");
});

test("English mode leaves tool descriptions unchanged", () => {
  assert.equal(localizeToolDescription("verify_output", "verify generated output snake.html", "en-US"), "verify generated output snake.html");
});

test("Chinese mode localizes media progress", () => {
  assert.equal(localizeToolProgress("Generating image with image-model", "zh-CN"), "正在使用以下模型生成图片：image-model");
  assert.equal(localizeToolProgress("Submitting potentially billable image request req-1 to image-model", "zh-CN"), "正在提交可能产生费用的图片请求 req-1，模型：image-model");
  assert.equal(localizeToolProgress("Resuming download for image request req-1", "zh-CN"), "正在继续下载图片请求：req-1");
  assert.equal(localizeToolProgress("Resuming download for video request req-2", "zh-CN"), "正在继续下载视频请求：req-2");
  assert.equal(localizeToolProgress("Submitting potentially billable video request req-2 to video-model", "zh-CN"), "正在提交可能产生费用的视频请求 req-2，模型：video-model");
  assert.equal(localizeToolProgress("Resuming video request req-2 (task video-1)", "zh-CN"), "正在恢复视频请求：req-2 (task video-1)");
  assert.equal(localizeToolProgress("Video video-1: status service busy; retrying poll in 30s", "zh-CN"), "视频任务 video-1：状态服务繁忙，30 秒后重试查询");
});
