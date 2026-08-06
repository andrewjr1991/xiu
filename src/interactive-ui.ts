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

export interface InteractiveInputOptions {
  paths?: string[];
  initialValue?: string;
  onChange?: (value: string) => void;
}

export interface EditorState {
  value: string;
  cursor: number;
}

export interface InputCandidate {
  kind: "command" | "path" | "history";
  label: string;
  description: string;
  replacement: string;
  replaceStart: number;
  replaceEnd: number;
}

export interface EditorFrame {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
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

function characters(value: string): string[] { return [...value]; }

export function insertEditorText(state: EditorState, text: string): EditorState {
  const value = characters(state.value);
  value.splice(state.cursor, 0, ...characters(text));
  return { value: value.join(""), cursor: state.cursor + characters(text).length };
}

export function deleteEditorBackward(state: EditorState): EditorState {
  if (state.cursor <= 0) return state;
  const value = characters(state.value);
  value.splice(state.cursor - 1, 1);
  return { value: value.join(""), cursor: state.cursor - 1 };
}

export function deleteEditorForward(state: EditorState): EditorState {
  const value = characters(state.value);
  if (state.cursor >= value.length) return state;
  value.splice(state.cursor, 1);
  return { value: value.join(""), cursor: state.cursor };
}

export function moveEditorCursor(state: EditorState, direction: "left" | "right" | "home" | "end", byWord = false): EditorState {
  const value = characters(state.value);
  if (direction === "home" || direction === "end") {
    const before = value.slice(0, state.cursor).join("");
    const lineStart = before.lastIndexOf("\n") + 1;
    const after = value.slice(state.cursor).join("");
    const nextBreak = after.indexOf("\n");
    return { ...state, cursor: direction === "home" ? characters(before.slice(0, lineStart)).length : state.cursor + characters(nextBreak < 0 ? after : after.slice(0, nextBreak)).length };
  }
  let cursor = Math.max(0, Math.min(value.length, state.cursor + (direction === "left" ? -1 : 1)));
  if (byWord) {
    const step = direction === "left" ? -1 : 1;
    while (cursor > 0 && cursor < value.length && /\s/.test(value[direction === "left" ? cursor - 1 : cursor] ?? "")) cursor += step;
    while (cursor > 0 && cursor < value.length && !/\s/.test(value[direction === "left" ? cursor - 1 : cursor] ?? "")) cursor += step;
    cursor = Math.max(0, Math.min(value.length, cursor));
  }
  return { ...state, cursor };
}

function activePathReference(state: EditorState): { start: number; end: number; query: string } | undefined {
  const value = characters(state.value);
  let start = state.cursor - 1;
  while (start >= 0 && !/\s/.test(value[start] ?? "")) start--;
  start++;
  if (value[start] !== "@") return undefined;
  let end = state.cursor;
  while (end < value.length && !/\s/.test(value[end] ?? "")) end++;
  return { start, end, query: value.slice(start + 1, state.cursor).join("").replace(/\\/g, "/").toLowerCase() };
}

export function pathCandidates(state: EditorState, paths: string[], limit = 8): InputCandidate[] {
  const reference = activePathReference(state);
  if (!reference) return [];
  return paths.filter((file) => !reference.query || file.toLowerCase().includes(reference.query))
    .sort((a, b) => {
      const ap = a.toLowerCase().startsWith(reference.query) ? 0 : 1;
      const bp = b.toLowerCase().startsWith(reference.query) ? 0 : 1;
      return ap - bp || a.length - b.length || a.localeCompare(b);
    }).slice(0, limit).map((file) => ({ kind: "path", label: `@${file}`, description: "project file", replacement: `@${file}`, replaceStart: reference.start, replaceEnd: reference.end }));
}

export function acceptCandidate(state: EditorState, candidate: InputCandidate): EditorState {
  const value = characters(state.value);
  const replacement = characters(candidate.replacement);
  value.splice(candidate.replaceStart, candidate.replaceEnd - candidate.replaceStart, ...replacement);
  return { value: value.join(""), cursor: candidate.replaceStart + replacement.length };
}

export function historyCandidates(query: string, history: string[], limit = 8): InputCandidate[] {
  const normalized = query.toLowerCase();
  return [...new Set([...history].reverse())].filter((item) => !normalized || item.toLowerCase().includes(normalized)).slice(0, limit)
    .map((item) => ({ kind: "history", label: item.replace(/\s+/g, " "), description: "history", replacement: item, replaceStart: 0, replaceEnd: Number.MAX_SAFE_INTEGER }));
}

function editorInputLines(prompt: string, state: EditorState, columns: number): { lines: string[]; cursorRow: number; cursorColumn: number } {
  const width = Math.max(20, columns - 1);
  const promptWidth = terminalDisplayWidth(prompt);
  const continuation = "  ";
  const value = characters(state.value);
  const plainLines: string[] = [prompt];
  let row = 0;
  let column = promptWidth;
  let cursorRow = 0;
  let cursorColumn = column;
  for (let index = 0; index <= value.length; index++) {
    if (index === state.cursor) { cursorRow = row; cursorColumn = column; }
    if (index === value.length) break;
    const character = value[index]!;
    if (character === "\n") {
      plainLines.push(continuation);
      row++;
      column = terminalDisplayWidth(continuation);
      continue;
    }
    const charWidth = terminalDisplayWidth(character);
    if (column + charWidth > width) {
      plainLines.push(continuation);
      row++;
      column = terminalDisplayWidth(continuation);
    }
    plainLines[row] += character;
    column += charWidth;
  }
  return { lines: plainLines.map((line, index) => index === 0 ? `${chalk.cyan(prompt)}${line.slice(prompt.length)}` : line), cursorRow, cursorColumn };
}

export function editorFrameLines(
  prompt: string,
  state: EditorState,
  candidates: InputCandidate[],
  selected: number,
  footer?: string,
  columns = process.stdout.columns || 100,
  searchQuery?: string,
): EditorFrame {
  const input = editorInputLines(prompt, state, columns);
  const lineWidth = Math.max(19, columns - 1);
  const lines = [...input.lines];
  if (searchQuery !== undefined) lines.push(chalk.dim(`(reverse-i-search) ${truncateDisplay(searchQuery, Math.max(1, lineWidth - 19))}`));
  for (const [index, candidate] of candidates.entries()) {
    const pointer = index === selected ? chalk.green(">") : " ";
    const label = truncateDisplay(candidate.label.replace(/\s+/g, " "), Math.max(8, Math.floor(lineWidth * 0.65)));
    lines.push(`${pointer} ${index === selected ? chalk.green(label) : label} ${chalk.dim(candidate.description)}`.trimEnd());
  }
  if (footer) {
    lines.push(chalk.dim("-".repeat(Math.max(19, Math.min(lineWidth, 120)))));
    lines.push(footer);
  }
  return { lines, cursorRow: input.cursorRow, cursorColumn: input.cursorColumn };
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

function clearRenderedFrame(lines: number, cursorRow: number): void {
  if (cursorRow > 0) readline.moveCursor(process.stdout, 0, -cursorRow);
  clearRenderedLines(lines);
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
  options: InteractiveInputOptions = {},
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await new Promise((resolve) => rl.question(prompt, resolve)); }
    finally { rl.close(); }
  }

  return await new Promise<string>((resolve) => {
    let state: EditorState = { value: options.initialValue ?? "", cursor: characters(options.initialValue ?? "").length };
    let selected = 0;
    let historyIndex = inputHistory.length;
    let renderedLines = 1;
    let cursorRow = 0;
    let dismissed = false;
    let searchQuery: string | undefined;

    const suggestions = (): InputCandidate[] => {
      if (dismissed) return [];
      if (searchQuery !== undefined) return historyCandidates(searchQuery, inputHistory);
      const paths = pathCandidates(state, options.paths ?? []);
      if (paths.length || activePathReference(state)) return paths;
      return matchingCommands(state.value, commands).slice(0, 8).map((command) => ({
        kind: "command" as const, label: command.name, description: command.description, replacement: command.name,
        replaceStart: 0, replaceEnd: characters(state.value).length,
      }));
    };
    const render = (): void => {
      clearRenderedFrame(renderedLines, cursorRow);
      const frame = editorFrameLines(prompt, state, suggestions(), selected, footer, process.stdout.columns || 100, searchQuery);
      process.stdout.write(frame.lines.join("\n"));
      renderedLines = frame.lines.length;
      const lastRow = frame.lines.length - 1;
      if (lastRow > frame.cursorRow) readline.moveCursor(process.stdout, 0, -(lastRow - frame.cursorRow));
      readline.cursorTo(process.stdout, frame.cursorColumn);
      cursorRow = frame.cursorRow;
    };

    const changed = (): void => { options.onChange?.(state.value); };
    const finish = (result: string, submitted = true): void => {
      clearRenderedFrame(renderedLines, cursorRow);
      cleanup();
      process.stdout.off("resize", render);
      if (submitted) options.onChange?.("");
      process.stdout.write(`${chalk.cyan(prompt)}${result}\n`);
      resolve(result);
    };

    const onKeypress = (text: string, key: readline.Key): void => {
      const matches = suggestions();
      if (key.ctrl && key.name === "c") return finish("", false);
      if (key.ctrl && key.name === "d") return finish("/exit");
      if (key.ctrl && key.name === "r") {
        searchQuery = searchQuery ?? "";
        dismissed = false;
        selected = 0;
        render();
        return;
      }
      if (key.ctrl && (key.name === "j" || key.name === "linefeed")) {
        state = insertEditorText(state, "\n");
        dismissed = false;
        changed();
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (searchQuery !== undefined) {
          if (matches[selected]) state = acceptCandidate(state, matches[selected]);
          searchQuery = undefined;
          dismissed = true;
          changed();
          render();
          return;
        }
        const commandMatches = matchingCommands(state.value, commands).slice(0, 8);
        return finish(resolveCommandInput(state.value, commandMatches, selected));
      }
      if (key.name === "tab" && matches.length) {
        state = acceptCandidate(state, matches[selected]!);
        searchQuery = undefined;
        dismissed = true;
        selected = 0;
        changed();
      } else if (key.name === "up") {
        if (matches.length) selected = (selected - 1 + matches.length) % matches.length;
        else if (inputHistory.length) {
          historyIndex = Math.max(0, historyIndex - 1);
          const value = inputHistory[historyIndex] ?? "";
          state = { value, cursor: characters(value).length };
          changed();
        }
      } else if (key.name === "down") {
        if (matches.length) selected = (selected + 1) % matches.length;
        else if (inputHistory.length) {
          historyIndex = Math.min(inputHistory.length, historyIndex + 1);
          const value = historyIndex === inputHistory.length ? "" : inputHistory[historyIndex] ?? "";
          state = { value, cursor: characters(value).length };
          changed();
        }
      } else if (key.name === "backspace") {
        if (searchQuery !== undefined) searchQuery = characters(searchQuery).slice(0, -1).join("");
        else { state = deleteEditorBackward(state); changed(); }
        dismissed = false;
        selected = 0;
      } else if (key.name === "delete") {
        state = deleteEditorForward(state);
        changed();
      } else if (key.name === "left" || key.name === "right") {
        state = moveEditorCursor(state, key.name, Boolean(key.ctrl));
      } else if (key.name === "home" || key.name === "end") {
        state = moveEditorCursor(state, key.name);
      } else if (key.name === "escape") {
        if (searchQuery !== undefined) searchQuery = undefined;
        dismissed = true;
        selected = 0;
      } else if (!key.ctrl && !key.meta && text && !/[\r\n]/.test(text)) {
        if (searchQuery !== undefined) searchQuery += text;
        else { state = insertEditorText(state, text); changed(); }
        dismissed = false;
        selected = 0;
      }
      render();
    };

    const cleanup = beginRawInput(onKeypress);
    process.stdout.on("resize", render);
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
