import readline from "node:readline";
import chalk from "chalk";
import { localize, type UiLanguage } from "./i18n.js";

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
  onCancel?: () => void;
  onToggleDetails?: () => void;
  onPaste?: () => Promise<{ insertText: string; notice?: string }>;
  enableRightClickPaste?: boolean;
  signal?: AbortSignal;
  refreshMs?: number;
  language?: UiLanguage;
  persistPrompt?: boolean;
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

export interface TerminalMouseEvent {
  button: "left" | "middle" | "right" | "release" | "wheel" | "other";
  pressed: boolean;
}

export interface TerminalMouseInputState {
  sequence: string;
  startedAt: number;
}

export interface TerminalMouseInputResult {
  state: TerminalMouseInputState;
  consumed: boolean;
  event?: TerminalMouseEvent;
}

const ENABLE_TERMINAL_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_TERMINAL_MOUSE = "\x1b[?1006l\x1b[?1000l";

export function terminalMouseEvent(text: string, key: readline.Key): TerminalMouseEvent | undefined {
  const sequence = key.sequence ?? text;
  const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(sequence);
  if (sgr) {
    const code = Number(sgr[1]);
    if (code & 64) return { button: "wheel", pressed: true };
    if (sgr[2] === "m") return { button: "release", pressed: false };
    const button = code & 3;
    return { button: button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "other", pressed: true };
  }
  const x10 = /^\x1b\[M([\s\S])([\s\S])([\s\S])$/.exec(sequence);
  if (x10) {
    const code = (x10[1]?.codePointAt(0) ?? 32) - 32;
    const button = code & 3;
    return { button: button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "release", pressed: button !== 3 };
  }
  return undefined;
}

export function consumeTerminalMouseInput(
  state: TerminalMouseInputState,
  text: string | undefined,
  key: readline.Key,
  now = Date.now(),
): TerminalMouseInputResult {
  const sequence = key.sequence ?? text ?? "";
  let pending = now - state.startedAt <= 250 ? state.sequence : "";

  if (!pending && (sequence === "\x1b[<" || sequence === "\x1b[M")) {
    return { state: { sequence, startedAt: now }, consumed: true };
  }

  if (pending.startsWith("\x1b[<")) {
    const combined = `${pending}${sequence}`;
    if (!/^\x1b\[<[0-9;]*[Mm]?$/.test(combined) || combined.length > 64) {
      return { state: { sequence: "", startedAt: 0 }, consumed: false };
    }
    if (/[Mm]$/.test(combined)) {
      return {
        state: { sequence: "", startedAt: 0 },
        consumed: true,
        event: terminalMouseEvent("", { sequence: combined }),
      };
    }
    return { state: { sequence: combined, startedAt: state.startedAt || now }, consumed: true };
  }

  if (pending.startsWith("\x1b[M")) {
    const combined = `${pending}${sequence}`;
    if (combined.length >= 6) {
      const complete = combined.slice(0, 6);
      return {
        state: { sequence: "", startedAt: 0 },
        consumed: true,
        event: terminalMouseEvent("", { sequence: complete }),
      };
    }
    return { state: { sequence: combined, startedAt: state.startedAt || now }, consumed: true };
  }

  const event = terminalMouseEvent(text ?? "", key);
  return event
    ? { state: { sequence: "", startedAt: 0 }, consumed: true, event }
    : { state: { sequence: "", startedAt: 0 }, consumed: false };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function terminalDisplayWidth(value: string): number {
  return [...stripAnsi(value)].reduce((width, character) => width + terminalCharacterWidth(character), 0);
}

export function terminalCharacterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) return 0;
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1;
}

function takeDisplayWidth(value: string, width: number, fromEnd = false): string {
  const characters = [...value];
  if (fromEnd) characters.reverse();
  const selected: string[] = [];
  let used = 0;
  for (const character of characters) {
    const next = terminalCharacterWidth(character);
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

export function wrapTerminalText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const character of stripAnsi(value)) {
    const characterWidth = terminalCharacterWidth(character);
    if (used > 0 && used + characterWidth > safeWidth) {
      lines.push(current);
      current = "";
      used = 0;
    }
    current += character;
    used += characterWidth;
  }
  lines.push(current);
  return lines;
}

export function terminalKeyName(text: string, key: readline.Key): string | undefined {
  if (key.name) return key.name;
  const sequence = key.sequence ?? text;
  if (sequence === "\x1b[A" || sequence === "\x1bOA") return "up";
  if (sequence === "\x1b[B" || sequence === "\x1bOB") return "down";
  if (sequence === "\r" || sequence === "\n") return "return";
  if (sequence === "\x1b") return "escape";
  return undefined;
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

export function pathCandidates(state: EditorState, paths: string[], limit = 8, language: UiLanguage = "en-US"): InputCandidate[] {
  const reference = activePathReference(state);
  if (!reference) return [];
  return paths.filter((file) => !reference.query || file.toLowerCase().includes(reference.query))
    .sort((a, b) => {
      const ap = a.toLowerCase().startsWith(reference.query) ? 0 : 1;
      const bp = b.toLowerCase().startsWith(reference.query) ? 0 : 1;
      return ap - bp || a.length - b.length || a.localeCompare(b);
    }).slice(0, limit).map((file) => ({ kind: "path", label: `@${file}`, description: localize(language, "项目文件", "project file"), replacement: `@${file}`, replaceStart: reference.start, replaceEnd: reference.end }));
}

export function acceptCandidate(state: EditorState, candidate: InputCandidate): EditorState {
  const value = characters(state.value);
  const replacement = characters(candidate.replacement);
  value.splice(candidate.replaceStart, candidate.replaceEnd - candidate.replaceStart, ...replacement);
  return { value: value.join(""), cursor: candidate.replaceStart + replacement.length };
}

export function historyCandidates(query: string, history: string[], limit = 8, language: UiLanguage = "en-US"): InputCandidate[] {
  const normalized = query.toLowerCase();
  return [...new Set([...history].reverse())].filter((item) => !normalized || item.toLowerCase().includes(normalized)).slice(0, limit)
    .map((item) => ({ kind: "history", label: item.replace(/\s+/g, " "), description: localize(language, "历史记录", "history"), replacement: item, replaceStart: 0, replaceEnd: Number.MAX_SAFE_INTEGER }));
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
    for (const footerLine of footer.split("\n")) {
      for (const wrapped of wrapTerminalText(footerLine, lineWidth)) {
        if (/^\s*√/.test(footerLine)) lines.push(chalk.green(wrapped));
        else if (/^\s*→|^(?:Now|Update|当前|进展)[:：]/.test(footerLine)) lines.push(chalk.cyan(wrapped));
        else if (/^\s*!/.test(footerLine)) lines.push(chalk.red(wrapped));
        else if (/^(?:Changed|变更)[:：]/.test(footerLine)) lines.push(chalk.yellow(wrapped));
        else if (/^(?:Plan|Progress|计划|进度)[:：]/.test(footerLine)) lines.push(chalk.white(wrapped));
        else lines.push(chalk.dim(wrapped));
      }
    }
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
  language: UiLanguage = "en-US",
): string[] {
  // Classic Windows PowerShell can report the console buffer width instead of
  // the visible viewport width. Once a row wraps physically, cursor-up moves by
  // logical rows and the selector title is repainted at the right edge. Keep a
  // deliberately conservative hard ceiling; the selected item's full details
  // are printed after selection, so the menu itself only needs identification.
  const lineWidth = Math.max(19, Math.min(columns - 4, 88));
  const start = Math.min(Math.max(0, selected - visibleCount + 1), Math.max(0, options.length - visibleCount));
  const visible = options.slice(start, start + visibleCount);
  const titleLines = title.split(/\r?\n/).map((line) => chalk.bold(truncateDisplay(line, lineWidth)));
  const lines = titleLines.length ? titleLines : [""];
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
  lines.push(chalk.dim(truncateDisplay(localize(language, "↑/↓ 或数字键选择 · Enter 确认 · Esc 取消", "Up/Down or number keys - Enter select - Esc cancel"), lineWidth)));
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

let nextRawInputGeneration = 0;
let activeRawInputGeneration = 0;

export function beginRawInput(
  onKeypress: (text: string, key: readline.Key) => void,
  input: NodeJS.ReadStream = process.stdin,
  options: { enableMouse?: boolean; output?: NodeJS.WriteStream; onRecover?: () => void } = {},
): () => void {
  const output = options.output ?? process.stdout;
  const generation = ++nextRawInputGeneration;
  activeRawInputGeneration = generation;
  let rawModeTimer: NodeJS.Timeout | undefined;
  const guardedKeypress = (text: string, key: readline.Key): void => {
    if (generation === activeRawInputGeneration) onKeypress(text, key);
  };
  const ensureRawMode = (): void => {
    if (generation !== activeRawInputGeneration) return;
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    if (wasRaw === false) options.onRecover?.();
  };
  readline.emitKeypressEvents(input);
  ensureRawMode();
  if (options.enableMouse) output.write(ENABLE_TERMINAL_MOUSE);
  input.on("keypress", guardedKeypress);
  if (process.platform === "win32" && input.isTTY) {
    // Console modes are shared state on Windows and can be changed by another
    // prompt or process. Reapply raw mode so input never falls back to the
    // line-buffered behavior where nothing appears until Enter is pressed.
    rawModeTimer = setInterval(ensureRawMode, 750);
    rawModeTimer.unref();
  }
  return () => {
    input.off("keypress", guardedKeypress);
    if (rawModeTimer) clearInterval(rawModeTimer);
    if (generation !== activeRawInputGeneration) return;
    activeRawInputGeneration = 0;
    if (options.enableMouse) output.write(DISABLE_TERMINAL_MOUSE);
    input.setRawMode?.(false);
    // Xiu immediately swaps from the running-task editor to the normal editor.
    // Pausing shared stdin during that hand-off can leave Windows ConPTY in a
    // half-resumed state where the first submitted line is not redrawn.
  };
}

export function isTerminalCancel(text: string, key: readline.Key): boolean {
  return text === "\u0003" || key.sequence === "\u0003" || Boolean(key.ctrl && key.name?.toLowerCase() === "c");
}

export async function readInteractiveInput(
  prompt: string,
  commands: SlashCommand[],
  inputHistory: string[] = [],
  footer?: string | (() => string),
  options: InteractiveInputOptions = {},
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await new Promise((resolve) => rl.question(prompt, resolve)); }
    finally { rl.close(); }
  }

  return await new Promise<string>((resolve) => {
    const language = options.language ?? "en-US";
    let state: EditorState = { value: options.initialValue ?? "", cursor: characters(options.initialValue ?? "").length };
    let selected = 0;
    let historyIndex = inputHistory.length;
    let renderedLines = 1;
    let cursorRow = 0;
    let dismissed = false;
    let searchQuery: string | undefined;
    let finished = false;
    let cleanupInput = (): void => {};
    let refreshTimer: NodeJS.Timeout | undefined;
    let pasteNotice = "";
    let pasteInFlight = false;
    let mouseInputState: TerminalMouseInputState = { sequence: "", startedAt: 0 };

    const pasteFromClipboard = (): void => {
      if (pasteInFlight || !options.onPaste) return;
      pasteInFlight = true;
      pasteNotice = localize(language, "正在读取剪贴板……", "Reading clipboard...");
      render();
      void options.onPaste().then((result) => {
        if (finished) return;
        if (result.insertText) {
          state = insertEditorText(state, result.insertText);
          changed();
        }
        pasteNotice = result.notice ?? localize(language, "剪贴板内容已粘贴。", "Clipboard pasted.");
        dismissed = true;
      }).catch((error) => {
        if (!finished) pasteNotice = `${localize(language, "剪贴板粘贴失败", "Clipboard paste failed")}: ${error instanceof Error ? error.message : String(error)}`;
      }).finally(() => {
        pasteInFlight = false;
        if (!finished) render();
      });
    };

    const suggestions = (): InputCandidate[] => {
      if (dismissed) return [];
      if (searchQuery !== undefined) return historyCandidates(searchQuery, inputHistory, 8, language);
      const paths = pathCandidates(state, options.paths ?? [], 8, language);
      if (paths.length || activePathReference(state)) return paths;
      return matchingCommands(state.value, commands).slice(0, 8).map((command) => ({
        kind: "command" as const, label: command.name, description: command.description, replacement: command.name,
        replaceStart: 0, replaceEnd: characters(state.value).length,
      }));
    };
    const render = (): void => {
      clearRenderedFrame(renderedLines, cursorRow);
      const baseFooter = typeof footer === "function" ? footer() : footer;
      const currentFooter = [pasteNotice, baseFooter].filter(Boolean).join("\n");
      const frame = editorFrameLines(prompt, state, suggestions(), selected, currentFooter, process.stdout.columns || 100, searchQuery);
      process.stdout.write(frame.lines.join("\n"));
      renderedLines = frame.lines.length;
      const lastRow = frame.lines.length - 1;
      if (lastRow > frame.cursorRow) readline.moveCursor(process.stdout, 0, -(lastRow - frame.cursorRow));
      readline.cursorTo(process.stdout, frame.cursorColumn);
      cursorRow = frame.cursorRow;
    };

    const changed = (): void => { options.onChange?.(state.value); };
    const finish = (result: string, submitted = true): void => {
      if (finished) return;
      finished = true;
      clearRenderedFrame(renderedLines, cursorRow);
      cleanupInput();
      process.stdout.off("resize", render);
      options.signal?.removeEventListener("abort", abortInput);
      if (refreshTimer) clearInterval(refreshTimer);
      if (submitted) options.onChange?.("");
      if (options.persistPrompt !== false) process.stdout.write(`${chalk.cyan(prompt)}${result}\n`);
      resolve(result);
    };
    const abortInput = (): void => finish("", false);

    const onKeypress = (text: string, key: readline.Key): void => {
      if (finished) return;
      const matches = suggestions();
      const mouseInput = consumeTerminalMouseInput(mouseInputState, text, key);
      mouseInputState = mouseInput.state;
      if (mouseInput.consumed) {
        if (mouseInput.event?.button === "right" && mouseInput.event.pressed) pasteFromClipboard();
        return;
      }
      if (isTerminalCancel(text, key)) {
        options.onCancel?.();
        return finish("", false);
      }
      if (key.ctrl && key.name === "d") return finish("/exit");
      if (key.ctrl && key.name === "r") {
        searchQuery = searchQuery ?? "";
        dismissed = false;
        selected = 0;
        render();
        return;
      }
      if (key.ctrl && key.name === "o") {
        options.onToggleDetails?.();
        render();
        return;
      }
      if (key.ctrl && key.name === "v" && options.onPaste) {
        pasteFromClipboard();
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

    cleanupInput = beginRawInput(onKeypress, process.stdin, {
      // Preserve terminal-native right-click paste unless an explicitly
      // supported enhanced clipboard backend has opted into mouse capture.
      enableMouse: process.platform === "win32" && Boolean(options.onPaste) && options.enableRightClickPaste !== false,
      onRecover: render,
    });
    process.stdout.on("resize", render);
    options.signal?.addEventListener("abort", abortInput, { once: true });
    if (options.refreshMs && options.refreshMs > 0) {
      refreshTimer = setInterval(render, Math.max(100, options.refreshMs));
      refreshTimer.unref();
    }
    render();
    if (options.signal?.aborted) abortInput();
  });
}

export async function selectTerminalOption<T>(title: string, options: SelectOption<T>[], language: UiLanguage = "en-US"): Promise<T | undefined> {
  if (!options.length) return undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return options[0]?.value;
  return await new Promise<T | undefined>((resolve) => {
    let selected = 0;
    let renderedLines = 1;
    const visibleCount = Math.min(10, options.length);
    let mouseInputState: TerminalMouseInputState = { sequence: "", startedAt: 0 };

    const render = (): void => {
      clearRenderedLines(renderedLines);
      const lines = terminalOptionFrameLines(title, options, selected, visibleCount, process.stdout.columns || 100, language);
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
      const mouseInput = consumeTerminalMouseInput(mouseInputState, _text, key);
      mouseInputState = mouseInput.state;
      if (mouseInput.consumed) return;
      const name = terminalKeyName(_text, key);
      const numeric = /^[1-9]$/.test(_text) ? Number(_text) - 1 : -1;
      if (numeric >= 0 && numeric < options.length) return finish(options[numeric]?.value);
      if (name === "up") selected = (selected - 1 + options.length) % options.length;
      else if (name === "down") selected = (selected + 1) % options.length;
      else if (name === "return" || name === "enter") return finish(options[selected]?.value);
      else if (name === "escape" || isTerminalCancel(_text, key)) return finish();
      render();
    };
    const cleanup = beginRawInput(onKeypress, process.stdin, { onRecover: render });
    render();
  });
}
