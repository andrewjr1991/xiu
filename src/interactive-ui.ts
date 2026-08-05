import readline from "node:readline";
import chalk from "chalk";

export interface SlashCommand {
  name: string;
  description: string;
}

export interface SelectOption<T> {
  label: string;
  description?: string;
  value: T;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function terminalDisplayWidth(value: string): number {
  return [...stripAnsi(value)].reduce((width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
}

function takeDisplayWidth(value: string, width: number, fromEnd = false): string {
  const characters = [...value];
  if (fromEnd) characters.reverse();
  const selected: string[] = [];
  let used = 0;
  for (const character of characters) {
    const next = /[^\u0000-\u00ff]/.test(character) ? 2 : 1;
    if (used + next > width) break;
    selected.push(character);
    used += next;
  }
  if (fromEnd) selected.reverse();
  return selected.join("");
}

function truncateDisplay(value: string, width: number, keepEnd = false): string {
  if (terminalDisplayWidth(value) <= width) return value;
  if (width <= 3) return takeDisplayWidth(value, width, keepEnd);
  return keepEnd
    ? `...${takeDisplayWidth(value, width - 3, true)}`
    : `${takeDisplayWidth(value, width - 3)}...`;
}

export function matchingCommands(input: string, commands: SlashCommand[]): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const normalized = input.toLowerCase();
  return commands.filter((command) => {
    const name = command.name.toLowerCase();
    return name.startsWith(normalized) || normalized.startsWith(`${name} `) || name.includes(normalized.slice(1));
  }).sort((a, b) => {
    const aExact = a.name.toLowerCase() === normalized ? 0 : a.name.toLowerCase().startsWith(normalized) ? 1 : 2;
    const bExact = b.name.toLowerCase() === normalized ? 0 : b.name.toLowerCase().startsWith(normalized) ? 1 : 2;
    return aExact - bExact || a.name.length - b.name.length || a.name.localeCompare(b.name);
  });
}

export function resolveCommandInput(input: string, matches: SlashCommand[], selected: number): string {
  const command = matches[selected];
  if (!command) return input;
  const normalized = input.toLowerCase();
  const name = command.name.toLowerCase();
  return name.startsWith(normalized) ? command.name : input;
}

export function interactiveFrameLines(
  prompt: string,
  value: string,
  matches: SlashCommand[],
  selected: number,
  footer?: string,
  columns = process.stdout.columns || 100,
): string[] {
  const lineWidth = Math.max(19, columns - 1);
  const promptWidth = terminalDisplayWidth(prompt);
  const visibleValue = truncateDisplay(value, Math.max(1, lineWidth - promptWidth), true);
  const lines = [`${chalk.cyan(prompt)}${visibleValue}`];
  for (const [index, command] of matches.entries()) {
    const pointer = index === selected ? chalk.green(">") : " ";
    const nameWidth = Math.min(19, Math.max(8, Math.floor((lineWidth - 2) * 0.35)));
    const plainName = truncateDisplay(command.name, nameWidth);
    const paddedName = `${plainName}${" ".repeat(Math.max(0, nameWidth - terminalDisplayWidth(plainName)))}`;
    const name = index === selected ? chalk.green(paddedName) : paddedName;
    const descriptionWidth = Math.max(0, lineWidth - 3 - nameWidth);
    lines.push(`${pointer} ${name} ${chalk.dim(truncateDisplay(command.description, descriptionWidth))}`.trimEnd());
  }
  if (footer) {
    lines.push(chalk.dim("-".repeat(Math.max(20, Math.min(columns, 120)))));
    lines.push(footer);
  }
  return lines;
}

export function terminalOptionFrameLines<T>(
  title: string,
  options: SelectOption<T>[],
  selected: number,
  visibleCount = 10,
  columns = process.stdout.columns || 100,
): string[] {
  const lineWidth = Math.max(19, columns - 1);
  const start = Math.min(Math.max(0, selected - visibleCount + 1), Math.max(0, options.length - visibleCount));
  const visible = options.slice(start, start + visibleCount);
  const lines = [chalk.bold(truncateDisplay(title, lineWidth))];
  for (const [offset, option] of visible.entries()) {
    const index = start + offset;
    const pointer = index === selected ? chalk.green(">") : " ";
    const available = lineWidth - 2;
    if (!option.description) {
      const label = truncateDisplay(option.label, available);
      lines.push(`${pointer} ${index === selected ? chalk.green(label) : label}`);
      continue;
    }
    const labelWidth = Math.min(terminalDisplayWidth(option.label), Math.max(12, Math.floor(available * 0.42)));
    const plainLabel = truncateDisplay(option.label, labelWidth);
    const label = index === selected ? chalk.green(plainLabel) : plainLabel;
    const descriptionWidth = Math.max(0, available - terminalDisplayWidth(plainLabel) - 2);
    const description = truncateDisplay(option.description, descriptionWidth);
    lines.push(`${pointer} ${label}  ${chalk.dim(description)}`.trimEnd());
  }
  lines.push(chalk.dim(truncateDisplay("Up/Down navigate - Enter select - Esc cancel", lineWidth)));
  return lines;
}

function clearRenderedLines(lines: number): void {
  readline.cursorTo(process.stdout, 0);
  for (let index = 0; index < lines; index++) {
    readline.clearLine(process.stdout, 0);
    if (index < lines - 1) readline.moveCursor(process.stdout, 0, 1);
  }
  if (lines > 1) readline.moveCursor(process.stdout, 0, -(lines - 1));
  readline.cursorTo(process.stdout, 0);
}

function beginRawInput(onKeypress: (text: string, key: readline.Key) => void): () => void {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("keypress", onKeypress);
  return () => {
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  };
}

export async function readInteractiveInput(
  prompt: string,
  commands: SlashCommand[],
  inputHistory: string[] = [],
  footer?: string,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await new Promise((resolve) => rl.question(prompt, resolve)); }
    finally { rl.close(); }
  }

  return await new Promise<string>((resolve) => {
    let value = "";
    let selected = 0;
    let historyIndex = inputHistory.length;
    let renderedLines = 1;

    const suggestions = (): SlashCommand[] => matchingCommands(value, commands).slice(0, 8);
    const render = (): void => {
      clearRenderedLines(renderedLines);
      const matches = suggestions();
      const lines = interactiveFrameLines(prompt, value, matches, selected, footer);
      process.stdout.write(lines.join("\n"));
      renderedLines = lines.length;
      if (lines.length > 1) readline.moveCursor(process.stdout, 0, -(lines.length - 1));
      readline.cursorTo(process.stdout, terminalDisplayWidth(lines[0] ?? ""));
    };

    const finish = (result: string): void => {
      clearRenderedLines(renderedLines);
      cleanup();
      process.stdout.write(`${chalk.cyan(prompt)}${result}\n`);
      resolve(result);
    };

    const onKeypress = (text: string, key: readline.Key): void => {
      const matches = suggestions();
      if (key.ctrl && key.name === "c") return finish("");
      if (key.ctrl && key.name === "d") return finish("/exit");
      if (key.name === "return" || key.name === "enter") {
        return finish(resolveCommandInput(value, matches, selected));
      }
      if (key.name === "tab" && matches.length) {
        value = matches[selected]?.name ?? value;
        selected = 0;
      } else if (key.name === "up") {
        if (matches.length) selected = (selected - 1 + matches.length) % matches.length;
        else if (inputHistory.length) {
          historyIndex = Math.max(0, historyIndex - 1);
          value = inputHistory[historyIndex] ?? "";
        }
      } else if (key.name === "down") {
        if (matches.length) selected = (selected + 1) % matches.length;
        else if (inputHistory.length) {
          historyIndex = Math.min(inputHistory.length, historyIndex + 1);
          value = historyIndex === inputHistory.length ? "" : inputHistory[historyIndex] ?? "";
        }
      } else if (key.name === "backspace") {
        value = [...value].slice(0, -1).join("");
        selected = 0;
      } else if (key.name === "escape") {
        value = "";
        selected = 0;
      } else if (!key.ctrl && !key.meta && text && !/[\r\n]/.test(text)) {
        value += text;
        selected = 0;
      }
      render();
    };

    const cleanup = beginRawInput(onKeypress);
    render();
  });
}

export async function selectTerminalOption<T>(title: string, options: SelectOption<T>[]): Promise<T | undefined> {
  if (!options.length) return undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return options[0]?.value;
  return await new Promise<T | undefined>((resolve) => {
    let selected = 0;
    let renderedLines = 1;
    const visibleCount = Math.min(10, options.length);

    const render = (): void => {
      clearRenderedLines(renderedLines);
      const lines = terminalOptionFrameLines(title, options, selected, visibleCount);
      process.stdout.write(lines.join("\n"));
      renderedLines = lines.length;
      readline.moveCursor(process.stdout, 0, -(renderedLines - 1));
      readline.cursorTo(process.stdout, 0);
    };

    const finish = (value?: T): void => {
      clearRenderedLines(renderedLines);
      cleanup();
      resolve(value);
    };

    const onKeypress = (_text: string, key: readline.Key): void => {
      if (key.name === "up") selected = (selected - 1 + options.length) % options.length;
      else if (key.name === "down") selected = (selected + 1) % options.length;
      else if (key.name === "return" || key.name === "enter") return finish(options[selected]?.value);
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish();
      render();
    };
    const cleanup = beginRawInput(onKeypress);
    render();
  });
}
