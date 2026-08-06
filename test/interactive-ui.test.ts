import assert from "node:assert/strict";
import test from "node:test";
import { acceptCandidate, deleteEditorBackward, deleteEditorForward, editorFrameLines, historyCandidates, insertEditorText, interactiveFrameLines, matchingCommands, moveEditorCursor, pathCandidates, resolveCommandInput, terminalDisplayWidth, terminalOptionFrameLines, type SlashCommand } from "../src/interactive-ui.js";

const commands: SlashCommand[] = [
  { name: "/resume", description: "resume" },
  { name: "/history", description: "history" },
  { name: "/history sessions", description: "sessions" },
  { name: "/status", description: "status" },
];

test("slash command matching opens for slash and filters as the user types", () => {
  assert.equal(matchingCommands("/", commands).length, 4);
  assert.deepEqual(matchingCommands("/res", commands).map((item) => item.name), ["/resume"]);
  assert.deepEqual(matchingCommands("/sta", commands).map((item) => item.name), ["/status"]);
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
