import assert from "node:assert/strict";
import test from "node:test";
import { formatPromptDashboard, renderWelcome } from "../src/welcome.js";
import { terminalDisplayWidth } from "../src/interactive-ui.js";

test("startup screen includes quick start, session details, and skill count", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 40);
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
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 3);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  assert.match(lines[1] ?? "", /__ {2}__.*Quick start/);
  assert.ok(lines.length < 18, `expected compact output, received ${lines.length} lines`);
});

test("narrow startup screen falls back to stacked layout", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 70 });
  try {
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 0);
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

test("prompt dashboard gives up segments in order instead of cutting the context gauge in a narrow terminal", () => {
  const originalColumns = process.stdout.columns;
  const render = (columns: number, overrides: Partial<Parameters<typeof formatPromptDashboard>[0]> = {}): string => {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    const line = formatPromptDashboard({ model: "fake/fake-model", contextTokens: 30_000, contextLimit: 128_000, skills: 0, cwd: "/tmp/claude-0/-home-claude-xiu/944718f9/scratchpad/probe-ws", planMode: false, mcpTools: 2, ...overrides }).replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(terminalDisplayWidth(line) <= columns - 1, `${columns} columns: ${line}`);
    return line;
  };
  try {
    assert.match(render(120), /^Auto \| fake\/fake-model \| ctx \[###---------\] 23% \| 0 skills \| 2 mcp \| \/tmp/);
    // 80 columns used to show `Auto | fake/fake-model | ct...---] 0% | 0 skills | 2 mcp`: the bar goes first, whole.
    assert.match(render(80), /^Auto \| fake\/fake-model \| ctx 23% \| 0 skills \| 2 mcp \| \/tmp/);
    assert.match(render(80, { language: "zh-CN" }), /^自动 \| fake\/fake-model \| 上下文 23% \| 0 技能 \| 2 mcp \| \/tmp/);
    assert.match(render(70), /^Auto \| fake\/fake-model \| ctx 23% \| 2 mcp \| \/tmp/);
    assert.match(render(55), /^Auto \| fake-model \| ctx 23% \| 2 mcp \| \/tmp/);
    assert.match(render(45), /^Auto \| fake-model \| ctx 23% \| \/tmp/);
    // A plan step is shown whole or not at all, and it is the first segment to go.
    assert.match(render(140, { agents: 3, phase: "pending:Verify" }), /^Auto \| fake\/fake-model \| ctx \[###---------\] 23% \| 0 skills \| 2 mcp \| 3 agents \| pending:Verify \| \/tmp/);
    assert.match(render(100, { agents: 3, phase: "pending:Verify" }), /^Auto \| fake\/fake-model \| ctx \[#-----\] 23% \| 0 skills \| 2 mcp \| 3 agents \| \/tmp/);
    assert.match(render(100, { agents: 3, phase: "in_progress:Implement professional terminal UI" }), /^Auto \| fake\/fake-model \| ctx \[#-----\] 23% \| 0 skills \| 2 mcp \| 3 agents \| \/tmp/);
    assert.match(render(80, { skills: 14, agents: 3, phase: "in_progress:Implement professional terminal UI" }), /^Auto \| fake-model \| ctx 23% \| 2 mcp \| 3 agents \| \/tmp/);
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
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "D:\\中文项目", autoApprove: true, language: "zh-CN" }, "0.8.5", 14);
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
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "D:\\project", autoApprove: false, language: "zh-CN" }, "0.9.1", 2);
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
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "D:\\QoderWork Project\\a-very-long-project-name", autoApprove: true, language: "zh-CN" }, "0.8.7", 14);
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

test("startup-config values line up in one column in English as well as in Chinese", () => {
  for (const language of ["en-US", "zh-CN"] as const) {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => lines.push(values.join(" "));
    try {
      renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "D:\\project", apiKey: "test-key", autoApprove: true, language }, "0.20.13", 3);
    } finally {
      console.log = originalLog;
    }
    const plain = lines.map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""));
    const values = ["agnes/agnes-2.5-flash", "128K", language === "zh-CN" ? "已配置" : "configured", language === "zh-CN" ? "自动，危险操作除外" : "automatic except dangerous", language === "zh-CN" ? "3 个已安装" : "3 installed"];
    const columns = values.map((value) => {
      const line = plain.find((candidate) => candidate.includes(value));
      assert.ok(line, `${language}: a startup-config row shows ${value}`);
      return terminalDisplayWidth(line.slice(0, line.indexOf(value)));
    });
    assert.deepEqual(columns, columns.map(() => columns[0]), `${language}: the values start at the same column (before: "Approval" pushed its value four columns right)\n${plain.join("\n")}`);
  }
});

test("a long workspace path stays inside the brand column instead of running under the panel", () => {
  // 100 columns is also what a pipe gets (no `columns`), so this is the layout in logs and in most terminals.
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 100 });
  try {
    renderWelcome({ provider: "agnes", providerId: "agnes", model: "agnes-2.5-flash", cwd: "/home/someone/work/a-rather-long-project-directory-name", autoApprove: true }, "0.20.13", 0);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  const plain = lines.map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""));
  const panelRows = plain.filter((line) => /[┌├│└]/.test(line));
  assert.equal(panelRows.length, 12, "the panel has twelve rows");
  const borderColumns = [...new Set(panelRows.map((line) => terminalDisplayWidth(line.slice(0, line.search(/[┌├│└]/)))))];
  assert.deepEqual(borderColumns, [borderColumns[0]], `every panel row starts at the same column (before: the path row and the version line pushed their rows' border right)\n${plain.join("\n")}`);
  const pathRow = plain.find((line) => line.includes("/home/so"));
  assert.ok(pathRow, "the path is shown");
  assert.match(pathRow, /\/home\/so.*\.\.\..*-name/, "the path keeps its beginning and its end");
});

test("prompt dashboard stays one column short of the terminal width, like the frame that draws it", () => {
  const originalColumns = process.stdout.columns;
  try {
    for (const columns of [80, 100, 120]) {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
      const line = formatPromptDashboard({ model: "fake/fake-model", contextTokens: 0, contextLimit: 128_000, skills: 0, cwd: "/tmp/claude-0/-home-claude-xiu/944718f9/scratchpad/probe-ws", planMode: false, mcpTools: 2 });
      const plain = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      assert.ok(terminalDisplayWidth(plain) <= columns - 1, `${columns} columns: ${terminalDisplayWidth(plain)} wide (before: exactly ${columns}, so the frame wrapped the path's last character onto its own line)\n${plain}`);
      assert.match(plain, /probe-ws$/, "the shortened path keeps its last characters");
    }
  } finally {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
});
