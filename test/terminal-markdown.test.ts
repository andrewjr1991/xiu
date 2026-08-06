import assert from "node:assert/strict";
import test from "node:test";
import { renderTerminalMarkdown } from "../src/terminal-markdown.js";
import { terminalDisplayWidth } from "../src/interactive-ui.js";

const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

test("terminal markdown removes structural markers and preserves content", () => {
  const rendered = stripAnsi(renderTerminalMarkdown("## 结果\n\n**文件：** `snake.html`\n\n- 已创建\n- 已验证"));
  assert.match(rendered, /结果/);
  assert.match(rendered, /文件： snake\.html/);
  assert.match(rendered, /• 已创建/);
  assert.doesNotMatch(rendered, /\*\*|`|^##/m);
});

test("terminal markdown renders code fences and tables without raw delimiters", () => {
  const rendered = stripAnsi(renderTerminalMarkdown("| 文件 | 状态 |\n| --- | --- |\n| a.ts | 完成 |\n\n```ts\nconst ok = true;\n```"));
  assert.match(rendered, /文件.*│.*状态/);
  assert.match(rendered, /a\.ts.*完成/);
  assert.match(rendered, /const ok = true/);
  assert.doesNotMatch(rendered, /\| ---|```/);
});

test("Chinese markdown tables respect narrow terminal width", () => {
  const originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 40 });
  try {
    const rendered = renderTerminalMarkdown("| 文件名称 | 验证状态 | 说明 |\n| --- | --- | --- |\n| 特别长的中文文件名称.html | 已经验证通过 | 这是很长的说明文字 | ");
    for (const line of rendered.split("\n")) assert.ok(terminalDisplayWidth(line) <= 37, line);
  } finally {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
});
