import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { acceptCandidate, beginRawInput, consumeTerminalMouseInput, deleteEditorBackward, deleteEditorForward, editorFrameLines, historyCandidates, insertEditorText, interactiveFrameLines, isTerminalCancel, matchingCommands, moveEditorCursor, pathCandidates, resolveCommandInput, terminalDisplayWidth, terminalMouseEvent, terminalOptionFrameLines, type SlashCommand, type TerminalMouseInputState } from "../src/interactive-ui.js";
import { formatRunningInputFooter, RunningTaskView } from "../src/task-queue.js";

const commands: SlashCommand[] = [
  { name: "/resume", description: "resume" },
  { name: "/history", description: "history" },
  { name: "/history sessions", description: "sessions" },
  { name: "/status", description: "status" },
  { name: "/paste", description: "paste attachment" },
];

test("raw input hand-off keeps stdin flowing between consecutive prompts", () => {
  const input = new PassThrough() as PassThrough & {
    setRawMode: (enabled: boolean) => void;
    isRaw: boolean;
  };
  let pauseCalls = 0;
  const originalPause = input.pause.bind(input);
  input.pause = () => {
    pauseCalls += 1;
    return originalPause();
  };
  input.isRaw = false;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };

  let firstKeys = 0;
  const releaseFirst = beginRawInput(() => { firstKeys += 1; }, input as unknown as NodeJS.ReadStream);
  input.emit("keypress", "a", { name: "a" });
  releaseFirst();

  let secondKeys = 0;
  const releaseSecond = beginRawInput(() => { secondKeys += 1; }, input as unknown as NodeJS.ReadStream);
  input.emit("keypress", "b", { name: "b" });
  releaseSecond();

  assert.equal(firstKeys, 1);
  assert.equal(secondKeys, 1);
  assert.equal(pauseCalls, 0);
  assert.equal(input.isRaw, false);
});

test("Ctrl+C cancellation recognizes parsed keys and raw Windows control bytes", () => {
  assert.equal(isTerminalCancel("", { name: "c", ctrl: true }), true);
  assert.equal(isTerminalCancel("\u0003", { sequence: "\u0003" }), true);
  assert.equal(isTerminalCancel("c", { name: "c" }), false);
});

test("terminal mouse reports recognize right click without treating release as another paste", () => {
  assert.deepEqual(terminalMouseEvent("", { sequence: "\x1b[<2;40;12M" }), { button: "right", pressed: true });
  assert.deepEqual(terminalMouseEvent("", { sequence: "\x1b[<2;40;12m" }), { button: "release", pressed: false });
  assert.deepEqual(terminalMouseEvent("", { sequence: "\x1b[M\"HD" }), { button: "right", pressed: true });
  assert.equal(terminalMouseEvent("a", { name: "a", sequence: "a" }), undefined);
});

test("fragmented Node keypress mouse reports never leak coordinates into editor text", () => {
  const input = new PassThrough() as PassThrough & { setRawMode: (enabled: boolean) => void };
  input.setRawMode = () => {};
  let state: TerminalMouseInputState = { sequence: "", startedAt: 0 };
  const mouseEvents: Array<{ button: string; pressed: boolean }> = [];
  let leakedText = "";
  const cleanup = beginRawInput((text, key) => {
    const result = consumeTerminalMouseInput(state, text, key);
    state = result.state;
    if (result.event) mouseEvents.push(result.event);
    else if (!result.consumed) leakedText += text ?? "";
  }, input as unknown as NodeJS.ReadStream);

  input.write("\x1b[<2;51;21M");
  input.write("\x1b[<2;51;21m");
  cleanup();

  assert.equal(leakedText, "");
  assert.deepEqual(mouseEvents, [
    { button: "right", pressed: true },
    { button: "release", pressed: false },
  ]);
  assert.equal(state.sequence, "");
});

test("raw input enables mouse reporting only for the prompt lifetime and restores it", () => {
  const input = new PassThrough() as PassThrough & { setRawMode: (enabled: boolean) => void };
  const output = new PassThrough();
  input.setRawMode = () => {};
  let terminalWrites = "";
  output.on("data", (chunk) => { terminalWrites += chunk.toString(); });
  const cleanup = beginRawInput(() => {}, input as unknown as NodeJS.ReadStream, {
    enableMouse: true,
    output: output as unknown as NodeJS.WriteStream,
  });
  assert.equal(terminalWrites, "\x1b[?1000h\x1b[?1006h");
  cleanup();
  assert.equal(terminalWrites, "\x1b[?1000h\x1b[?1006h\x1b[?1006l\x1b[?1000l");
});

test("terminal width treats box drawing as single-width and CJK as double-width", () => {
  assert.equal(terminalDisplayWidth("┌─┬─┐"), 5);
  assert.equal(terminalDisplayWidth("中文"), 4);
  assert.equal(terminalDisplayWidth("e\u0301"), 1);
});

test("slash command matching opens for slash and filters as the user types", () => {
  assert.equal(matchingCommands("/", commands).length, 5);
  assert.deepEqual(matchingCommands("/res", commands).map((item) => item.name), ["/resume"]);
  assert.deepEqual(matchingCommands("/sta", commands).map((item) => item.name), ["/status"]);
  assert.deepEqual(matchingCommands("/pas", commands).map((item) => item.name), ["/paste"]);
});

test("exact command is ranked before its longer subcommand", () => {
  assert.deepEqual(matchingCommands("/history", commands).map((item) => item.name), ["/history", "/history sessions"]);
  assert.deepEqual(matchingCommands("/history s", commands).map((item) => item.name), ["/history sessions", "/history"]);
});

test("Enter completes a selected subcommand but preserves arguments after a full command", () => {
  const withInstall = [...commands, { name: "/skills", description: "skills" }, { name: "/skills install", description: "install" }];
  const partial = matchingCommands("/skills i", withInstall);
  assert.equal(resolveCommandInput("/skills i", partial, 0), "/skills install");
  const withArgument = matchingCommands("/skills install C:\\skill", withInstall);
  assert.equal(resolveCommandInput("/skills install C:\\skill", withArgument, 0), "/skills install C:\\skill");
});

test("interactive footer stays below the input and command suggestions", () => {
  const matches = matchingCommands("/sta", commands);
  const lines = interactiveFrameLines("xiu> ", "/sta", matches, 0, "Auto | model | ctx 0%", 80);
  assert.match(lines[0] ?? "", /xiu> \/sta/);
  assert.match(lines[1] ?? "", /> \/status/);
  assert.match(lines.at(-2) ?? "", /^-/);
  assert.equal(lines.at(-1), "Auto | model | ctx 0%");
});

test("terminal selector clips long skill descriptions so Esc can clear every physical line", () => {
  const lines = terminalOptionFrameLines("Installed skills", [{
    label: "dispatching-parallel-agents",
    description: "Use when facing two or more independent tasks that can be worked on without shared state or sequential dependencies".repeat(3),
    value: "skill",
  }], 0, 10, 60);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => terminalDisplayWidth(line) <= 59));
  assert.match(lines[1] ?? "", /\.\.\./);
});

test("interactive input and command palette stay within terminal width", () => {
  const lines = interactiveFrameLines("xiu> ", "这是一个非常长的中文输入".repeat(8), commands, 0, undefined, 50);
  assert.ok(lines.every((line) => terminalDisplayWidth(line) <= 49));
});

test("multiline editor moves and deletes Chinese and emoji by Unicode character", () => {
  let state = { value: "你好🙂\nworld", cursor: 3 };
  state = moveEditorCursor(state, "left");
  assert.equal(state.cursor, 2);
  state = deleteEditorBackward(state);
  assert.equal(state.value, "你🙂\nworld");
  state = insertEditorText(state, "好");
  assert.equal(state.value, "你好🙂\nworld");
  state = moveEditorCursor(state, "end");
  assert.equal(state.cursor, 3);
  state = deleteEditorForward(state);
  assert.equal(state.value, "你好🙂world");
});

test("editor frame wraps multiline Chinese input and returns a valid cursor position", () => {
  const state = { value: `第一行🙂\n${"很长的中文".repeat(8)}`, cursor: 6 };
  const frame = editorFrameLines("xiu> ", state, [], 0, "Auto | model", 30);
  assert.ok(frame.lines.length > 3);
  assert.ok(frame.lines.every((line) => terminalDisplayWidth(line) <= 29));
  assert.ok(frame.cursorRow >= 1);
  assert.ok(frame.cursorColumn >= 2 && frame.cursorColumn <= 29);
});

test("editor frame counts and clips every physical line in a multiline running footer", () => {
  const frame = editorFrameLines("xiu[working]> ", { value: "继续修复", cursor: 4 }, [], 0, "Working: Running a very long verification command | 2 queued\nAuto | model | D:\\long\\workspace", 36);
  assert.equal(frame.lines.length, 4);
  assert.ok(frame.lines.every((line) => terminalDisplayWidth(line) <= 35));
  assert.match(frame.lines.at(-2) ?? "", /\.\.\./);
  assert.match(frame.lines.at(-1) ?? "", /Auto/);
});

test("persistent task progress remains bounded in a narrow terminal", () => {
  const view = new RunningTaskView();
  view.setPlan({
    goal: "Improve progress visibility",
    updatedAt: new Date().toISOString(),
    steps: [
      { id: "inspect", title: "Inspect the current terminal rendering implementation", status: "completed" },
      { id: "implement", title: "Implement a persistent progress summary", status: "in_progress" },
      { id: "verify", title: "Verify narrow terminal rendering", status: "pending" },
    ],
  });
  view.recordWorkspaceChange({ tool: "apply_patch", paths: ["src/interactive-ui.ts"], description: "patch UI" });
  const footer = formatRunningInputFooter(view, 0, 0, "Auto | model");
  const frame = editorFrameLines("xiu[working]> ", { value: "", cursor: 0 }, [], 0, footer, 38);
  assert.ok(frame.lines.every((line) => terminalDisplayWidth(line) <= 37));
  assert.ok(frame.lines.some((line) => /Plan: 1\/3/.test(line)));
  assert.ok(frame.lines.some((line) => /Now: Implement/.test(line)));
});

test("path completion replaces only the active @ reference", () => {
  const state = { value: "检查 @src/int 然后测试", cursor: [..."检查 @src/int"].length };
  const candidates = pathCandidates(state, ["src/agent.ts", "src/interactive-ui.ts", "test/interactive-ui.test.ts"]);
  assert.equal(candidates[0]?.label, "@src/interactive-ui.ts");
  assert.equal(acceptCandidate(state, candidates[0]!).value, "检查 @src/interactive-ui.ts 然后测试");
});

test("history search is newest-first and de-duplicates entries", () => {
  const matches = historyCandidates("fix", ["fix login", "build", "fix login", "fix tests"]);
  assert.deepEqual(matches.map((item) => item.replacement), ["fix tests", "fix login"]);
});
