import assert from "node:assert/strict";
import test from "node:test";
import { formatPromptDashboard, renderWelcome } from "../src/welcome.js";
import { terminalDisplayWidth } from "../src/interactive-ui.js";

test("startup screen includes quick start, session details, and skill count", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 40);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Quick start/);
  assert.match(output, /Startup config · live status below/);
  assert.match(output, /40 installed/);
  assert.match(output, /command palette/);
});

test("wide startup screen places branding and quick start on the same row", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 3);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  assert.match(lines[1] ?? "", /__  __.*Quick start/);
  assert.ok(lines.length < 18, `expected compact output, received ${lines.length} lines`);
});

test("narrow startup screen falls back to stacked layout", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 70 });
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 0);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  assert.doesNotMatch(lines[1] ?? "", /Quick start/);
  assert.ok(lines.some((line) => line.includes("Quick start")));
});

test("prompt dashboard remains within a narrow terminal with all status segments", () => {
  const originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 55 });
  try {
    const line = formatPromptDashboard({
      model: "agnes-2.5-flash", contextTokens: 30_000, contextLimit: 409_600, skills: 14,
      cwd: "D:\\QoderWork Project\\a-very-long-project-name", planMode: false, mcpTools: 8,
      agents: 3, backgroundTasks: 2, phase: "in_progress:Implement professional terminal UI",
    });
    assert.ok(terminalDisplayWidth(line) <= 55);
  } finally {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
});

test("prompt dashboard can show the live provider and model together", () => {
  const line = formatPromptDashboard({
    model: "dashscope/deepseek-v4-pro", contextTokens: 0, contextLimit: 800_000, skills: 17,
    cwd: "D:\\project", planMode: false, language: "zh-CN",
  });
  assert.match(line, /dashscope\/deepseek-v4-pro/);
});

test("Chinese startup screen is localized and never reaches the terminal wrap column", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "D:\\中文项目", autoApprove: true, language: "zh-CN" }, "0.8.5", 14);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  const output = lines.join("\n");
  assert.match(output, /快速开始/);
  assert.match(output, /启动时配置 · 实时状态见底栏/);
  assert.match(output, /自动，危险操作除外/);
  for (const line of lines) assert.ok(terminalDisplayWidth(line) <= 117, `line may wrap at terminal edge: ${line}`);
});

test("startup screen advertises right-click attachment paste", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "D:\\project", language: "zh-CN" }, "0.9.1", 2);
  } finally {
    console.log = originalLog;
  }
  assert.match(lines.join("\n"), /右键.*Ctrl\+V/);
});

test("interactive welcome panel positions every mixed-language right border at one absolute column", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  const originalIsTty = process.stdout.isTTY;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "D:\\QoderWork Project\\a-very-long-project-name", autoApprove: true, language: "zh-CN" }, "0.8.7", 14);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTty });
  }
  const titleRow = lines.find((line) => line.includes("快速开始"));
  assert.ok(titleRow?.includes("\x1b[41G┌"), "panel left edge should start at absolute terminal column 41");
  assert.ok(titleRow?.includes("\x1b[43G 快速开始 \x1b[118G"), "title should overlay the complete top rule at fixed columns");
  const sessionRow = lines.find((line) => line.includes("启动时配置"));
  assert.ok(sessionRow?.includes("\x1b[41G├") && sessionRow.includes("\x1b[117G┤\x1b[K") && sessionRow.includes("\x1b[43G 启动时配置 · 实时状态见底栏 \x1b[118G"), "startup divider should pin both corners and clear overflow");
  const contentRows = lines.filter((line) => line.includes("输入 / 打开命令面板") || line.includes("自动，危险操作除外"));
  assert.equal(contentRows.length, 2);
  assert.ok(contentRows.every((line) => line.includes("\x1b[117G│")), "each content row should place its right border at terminal column 117");
});
