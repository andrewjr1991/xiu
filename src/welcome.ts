import chalk from "chalk";
import type { AgentConfig } from "./config.js";

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

function box(title: string, rows: string[], width: number): string[] {
  const innerWidth = width - 2;
  return [
    `+- ${title} ${"-".repeat(Math.max(1, width - title.length - 5))}+`,
    ...rows.map((row) => `|${fit(` ${row}`, innerWidth).padEnd(innerWidth)}|`),
    `+${"-".repeat(innerWidth)}+`,
  ];
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
  const columns = process.stdout.columns || 100;
  const width = Math.max(30, Math.min(120, columns - 2));
  const tips = [
    "1. Type / to open the command palette",
    "2. Use @path/to/file to point at code",
    "3. Use /plan on to investigate safely",
    "4. Use /skills to browse installed workflows",
  ];
  const session = [
    "Session",
    `Model     ${config.provider}/${config.model}`,
    `Auth      ${authState(config)}`,
    `Approval  ${config.autoApprove ? "automatic except dangerous" : "risk-based prompts"}`,
    `Skills    ${skillCount} installed`,
  ];

  const brand = [
    ...LOGO.map((line) => chalk.cyan.bold(line)),
    `${chalk.bold(`Xiu ${version}`)} ${chalk.dim("- Build. Fix. Verify.")}`,
    chalk.dim("修代码，也修工程。"),
    chalk.dim(fit(config.cwd, 38)),
  ];
  const panelRows = [...tips, "", ...session];

  if (width >= 86) {
    const gap = 3;
    const leftWidth = Math.max(30, Math.min(38, Math.floor(width * 0.32)));
    const panelWidth = width - leftWidth - gap;
    printSideBySide(brand, box("Quick start", panelRows, panelWidth), leftWidth, gap);
  } else {
    for (const line of brand) console.log(line);
    console.log();
    for (const line of box("Quick start", panelRows, width)) console.log(line);
  }

  console.log(chalk.green("Tips"));
  console.log(chalk.dim("  /help commands  |  /status stats  |  /compact context  |  /exit quit"));
  console.log(chalk.dim("  Add AGENTS.md or XIU.md to teach Xiu your project conventions.\n"));
}

export function formatPromptDashboard(input: {
  model: string;
  contextTokens: number;
  contextLimit: number;
  skills: number;
  cwd: string;
  planMode: boolean;
  mcpTools?: number;
}): string {
  const columns = process.stdout.columns || 100;
  const ratio = Math.min(1, input.contextTokens / Math.max(1, input.contextLimit));
  const filled = Math.round(ratio * 12);
  const bar = `${"#".repeat(filled)}${"-".repeat(12 - filled)}`;
  const percent = `${Math.round(ratio * 100)}%`;
  const mcp = input.mcpTools ? ` | ${input.mcpTools} mcp` : "";
  const left = `${input.planMode ? "Plan" : "Auto"} | ${input.model} | ctx [${bar}] ${percent} | ${input.skills} skills${mcp}`;
  const available = Math.max(12, columns - left.length - 3);
  return chalk.dim(`${left} | ${fit(input.cwd, available)}`);
}

export function renderPromptDashboard(input: Parameters<typeof formatPromptDashboard>[0]): void {
  console.log(formatPromptDashboard(input));
}
