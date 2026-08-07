import chalk from "chalk";
import type { AgentConfig } from "./config.js";
import { localize, type UiLanguage } from "./i18n.js";

const LOGO = [
  "__  __  _       ",
  "\\ \\/ / (_) _   _ ",
  " \\  /  | || | | |",
  " /  \\  | || |_| |",
  "/_/\\_\\ |_| \\__,_|",
];

function authState(config: AgentConfig): string {
  const configured = config.provider === "agnes"
    ? Boolean(process.env.AGNES_API_KEY)
    : config.provider === "anthropic"
      ? Boolean(process.env.ANTHROPIC_API_KEY)
      : Boolean(process.env.OPENAI_API_KEY);
  return configured ? "configured" : "missing API key";
}

function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) ? 2 : 1;
}

function textWidth(value: string): number {
  return [...value].reduce((total, character) => total + characterWidth(character), 0);
}

function takeWidth(value: string, width: number, fromEnd = false): string {
  const characters = [...value];
  if (fromEnd) characters.reverse();
  const selected: string[] = [];
  let used = 0;
  for (const character of characters) {
    const next = characterWidth(character);
    if (used + next > width) break;
    selected.push(character);
    used += next;
  }
  if (fromEnd) selected.reverse();
  return selected.join("");
}

function fit(value: string, width: number): string {
  if (textWidth(value) <= width) return value;
  if (width < 8) return takeWidth(value, width);
  const left = Math.ceil((width - 3) / 2);
  return `${takeWidth(value, left)}...${takeWidth(value, width - 3 - left, true)}`;
}

function box(title: string, rows: string[], width: number, closeRight = true): string[] {
  const innerWidth = width - 2;
  const titleRule = Math.max(1, width - textWidth(title) - 5);
  const row = (value: string): string => closeRight
    ? `|${padVisible(fit(` ${value}`, innerWidth), innerWidth)}|`
    : `| ${fit(value, innerWidth - 1)}`;
  return [
    `+- ${title} ${"-".repeat(titleRule)}${closeRight ? "+" : ""}`,
    ...rows.map(row),
    `+${"-".repeat(innerWidth)}${closeRight ? "+" : ""}`,
  ];
}

function useClosedWelcomePanel(): boolean {
  // Legacy Windows Console Host can advance mixed CJK text differently from
  // wcwidth-style calculations. An open panel avoids a visibly jagged right
  // edge without taking over the terminal or sacrificing the compact layout.
  return process.platform !== "win32" || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
}

function visibleLength(value: string): number {
  return textWidth(value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""));
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function printSideBySide(left: string[], right: string[], leftWidth: number, gap = 3): void {
  const height = Math.max(left.length, right.length);
  for (let index = 0; index < height; index += 1) {
    const leftLine = left[index] ?? "";
    const rightLine = right[index] ?? "";
    console.log(`${padVisible(leftLine, leftWidth)}${" ".repeat(gap)}${rightLine}`.trimEnd());
  }
}

export function renderWelcome(config: AgentConfig, version: string, skillCount = 0): void {
  console.log();
  const language = config.language ?? "en-US";
  const columns = process.stdout.columns || 100;
  const width = Math.max(30, Math.min(118, columns - 3));
  const tips = [
    localize(language, "1. 输入 / 打开命令面板", "1. Type / to open the command palette"),
    localize(language, "2. 使用 @路径 或 Ctrl+V 引用文件和图片", "2. Use @path or Ctrl+V to attach files and images"),
    localize(language, "3. 使用 /plan on 进行只读调查", "3. Use /plan on to investigate safely"),
    localize(language, "4. 使用 /skills 浏览已安装工作流", "4. Use /skills to browse installed workflows"),
  ];
  const session = [
    localize(language, "当前会话", "Session"),
    `${localize(language, "模型", "Model")}      ${config.provider}/${config.model}`,
    `${localize(language, "上下文", "Context")}    ${Math.round((config.contextWindow ?? 128_000) / 1000)}K · ${localize(language, "压缩点", "compact at")} ${Math.round((config.contextLimit ?? 102_400) / 1000)}K`,
    `${localize(language, "认证", "Auth")}      ${authState(config) === "configured" ? localize(language, "已配置", "configured") : localize(language, "缺少 API Key", "missing API key")}`,
    `${localize(language, "审批", "Approval")}      ${config.autoApprove ? localize(language, "自动，危险操作除外", "automatic except dangerous") : localize(language, "按风险询问", "risk-based prompts")}`,
    `${localize(language, "技能", "Skills")}      ${skillCount} ${localize(language, "个已安装", "installed")}`,
  ];

  const brand = [
    ...LOGO.map((line) => chalk.cyan.bold(line)),
    `${chalk.bold(`Xiu ${version}`)} ${chalk.dim(localize(language, "- 构建 · 修复 · 验证", "- Build. Fix. Verify."))}`,
    chalk.dim(localize(language, "修代码，也修工程。", "Build code. Fix systems.")),
    chalk.dim(fit(config.cwd, 38)),
  ];
  const panelRows = [...tips, "", ...session];
  const closePanelRight = useClosedWelcomePanel();

  if (width >= 86) {
    const gap = 3;
    const leftWidth = Math.max(30, Math.min(38, Math.floor(width * 0.32)));
    const panelWidth = width - leftWidth - gap;
    printSideBySide(brand, box(localize(language, "快速开始", "Quick start"), panelRows, panelWidth, closePanelRight), leftWidth, gap);
  } else {
    for (const line of brand) console.log(line);
    console.log();
    for (const line of box(localize(language, "快速开始", "Quick start"), panelRows, width, closePanelRight)) console.log(line);
  }

  console.log(chalk.green(localize(language, "提示", "Tips")));
  console.log(chalk.dim(localize(language, "  /help 命令  |  /status 状态  |  /compact 压缩  |  /exit 退出", "  /help commands  |  /status stats  |  /compact context  |  /exit quit")));
  console.log(chalk.dim(localize(language, "  添加 AGENTS.md 或 XIU.md，告诉 Xiu 项目规范。\n", "  Add AGENTS.md or XIU.md to teach Xiu your project conventions.\n")));
}

export function formatPromptDashboard(input: {
  model: string;
  contextTokens: number;
  contextLimit: number;
  skills: number;
  cwd: string;
  planMode: boolean;
  mcpTools?: number;
  agents?: number;
  backgroundTasks?: number;
  phase?: string;
  language?: UiLanguage;
}): string {
  const language = input.language ?? "en-US";
  const columns = process.stdout.columns || 100;
  const ratio = Math.min(1, input.contextTokens / Math.max(1, input.contextLimit));
  const filled = Math.round(ratio * 12);
  const bar = `${"#".repeat(filled)}${"-".repeat(12 - filled)}`;
  const percent = `${Math.round(ratio * 100)}%`;
  const mcp = input.mcpTools ? ` | ${input.mcpTools} mcp` : "";
  const agents = input.agents ? ` | ${input.agents} agents` : "";
  const background = input.backgroundTasks ? ` | ${input.backgroundTasks} bg` : "";
  const phase = input.phase ? ` | ${input.phase}` : "";
  const left = `${input.planMode ? localize(language, "规划", "Plan") : localize(language, "自动", "Auto")} | ${input.model} | ${localize(language, "上下文", "ctx")} [${bar}] ${percent} | ${input.skills} ${localize(language, "技能", "skills")}${mcp}${agents}${background}${phase}`;
  const fittedLeft = fit(left, Math.max(20, Math.floor(columns * 0.72)));
  const available = Math.max(8, columns - textWidth(fittedLeft) - 3);
  return chalk.dim(`${fittedLeft} | ${fit(input.cwd, available)}`);
}

export function renderPromptDashboard(input: Parameters<typeof formatPromptDashboard>[0]): void {
  console.log(formatPromptDashboard(input));
}
