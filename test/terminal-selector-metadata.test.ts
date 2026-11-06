import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { stripTerminalControls, plainTerminalSummary } from "../src/terminal-summary.js";
import { terminalDisplayWidth, terminalOptionFrameLines } from "../src/interactive-ui.js";

test("selector metadata removes terminal commands and embedded control lines without changing option identities", () => {
  const value = { id: "original\u001b[2J-id" };
  const options = [{ label: "模型\u001b]52;c;clipboard-canary\u0007\r\n选项", description: "详情\u001b[2J\t更多\u0008内容", value }];
  const before = structuredClone(options);
  const lines = terminalOptionFrameLines("渠道\u001b]0;title-canary\u0007", options, 0, 10, 100, "zh-CN");
  const plain = lines.map(stripVTControlCharacters);
  assert.ok(lines.every((line) => !/\u001b\]|\u001b\[2J/.test(line)), "external metadata must not emit OSC/clear-screen commands");
  assert.ok(plain.every((line) => !/[\u0000-\u001f\u007f-\u009f]/.test(line)), "one frame entry must occupy one logical line");
  assert.equal(plain.length, 3);
  assert.match(plain[1]!, /模型 选项/);
  assert.match(plain[1]!, /详情 更多 内容/);
  assert.deepEqual(options, before);
  assert.equal(options[0]!.value, value);
});

test("selector strips a whole multiline OSC before preserving the caller's title lines", () => {
  const lines = terminalOptionFrameLines("MCP\u001b]0;hidden\npayload\u0007\nScope: read", [{ label: "确认", value: true }], 0);
  assert.equal(lines.length, 4);
  assert.match(stripVTControlCharacters(lines[0]!), /^MCP$/);
  assert.match(stripVTControlCharacters(lines[1]!), /^Scope: read$/);
  assert.doesNotMatch(lines.join("\n"), /hidden|payload|\u001b\]/);
});

test("selector preserves visible hyperlink labels and bounded Unicode rows", () => {
  for (const columns of [44, 100, 260]) {
    const lines = terminalOptionFrameLines("选择模型", [{ label: "\u001b]8;;https://hidden.invalid/\u0007中文模型\u001b]8;;\u0007", description: "\u001b[31m普通说明\u001b[0m", value: "model" }], 0, 10, columns, "zh-CN");
    assert.ok(lines.every((line) => !/\u001b\]|\u001b\[31m/.test(line)));
    assert.match(stripVTControlCharacters(lines[1]!), /中文模型/);
    assert.ok(lines.every((line) => terminalDisplayWidth(line) <= Math.min(columns - 4, 88)));
  }
});


test("OSC sanitization supports C1 and ST terminators while preserving ordinary heading newlines", () => {
  assert.equal(stripTerminalControls("前\u009dtitle\npayload\u009c后\n下一行"), "前后\n下一行");
  assert.equal(stripTerminalControls("前\u001b]title\npayload\u001b\\后"), "前后");
  assert.equal(plainTerminalSummary("\u001b]8;;https://hidden.invalid/\u001b\\标签\u001b]8;;\u001b\\"), "标签");
});

test("unfinished OSC payload is omitted without changing ordinary plain text", () => {
  assert.equal(stripTerminalControls("visible\u001b]52;unfinished\npayload"), "visible");
  assert.equal(stripTerminalControls("visible\u009dunfinished"), "visible");
  assert.equal(stripTerminalControls("中文 🙂\nplain"), "中文 🙂\nplain");
});

test("adjacent ST-terminated OSC strings retain each visible segment", () => {
  const piece = "\u001b]0;payload\u001b\\文";
  assert.equal(stripTerminalControls(piece.repeat(10000)), "文".repeat(10000));
});
