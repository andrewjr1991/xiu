import assert from "node:assert/strict";
import test from "node:test";
import { sessionTitle } from "../src/session.js";
import { printSessionList, chooseSession, resolveStartupRecovery } from "../src/commands/session-commands.js";
import { formatRunList } from "../src/commands/report-commands.js";
import { formatRunChangeList } from "../src/commands/diff-commands.js";
import type { InterruptedTaskRun, TaskRunRecord } from "../src/task-run.js";

const escape = "\u001b[2J\u001b]0;changed-title\u0007";
const title = `inspect ${escape}代码\u0000\u0008 safely`;
const plain = "inspect 代码 safely";
const session = { id: `saved${escape}`, file: "/fixture/saved.jsonl", firstTask: title, model: `model${escape}`, createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z", size: 0 };
// The frontend may add its own SGR colors around the already-cleaned text.
const assertPlain = (value: string) => assert.doesNotMatch(value.replace(/\u001b\[[0-9;]*m/g, ""), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|changed-title/);

test("session titles strip terminal commands before truncation and preserve ordinary Unicode", () => {
  assert.equal(sessionTitle(session, "en-US"), plain);
  assert.equal(sessionTitle(session, "en-US", 10), plain.slice(0, 10));
  assert.equal(sessionTitle({ firstTask: escape }, "en-US"), "Untitled session");
});

test("history titles retain hyperlink text while removing OSC link controls", () => {
  const firstTask = "open \u001b]8;;https://example.test\u001b\\文档\u001b]8;;\u001b\\ now";
  assert.equal(sessionTitle({ firstTask }, "en-US"), "open 文档 now");
  assert.match(firstTask, /\u001b/);
});

test("session list columns cannot emit terminal controls from saved IDs or model names", async () => {
  const lines: string[] = [];
  await printSessionList("/fixture", "en-US", { list: async () => ({ sessions: [session], unreadable: [] }), log: (line) => { lines.push(line); } });
  assertPlain(lines.join("\n"));
  assert.match(lines.join("\n"), /inspect 代码 safely/);
});

test("resume choices clean displayed metadata while retaining the exact selection ID", async () => {
  let selectedId: string | undefined;
  await chooseSession("/fixture", "en-US", { list: async () => ({ sessions: [session], unreadable: [] }),
    select: async (_title, options) => {
      assertPlain(options[0]!.label);
      assertPlain(options[0]!.description!);
      return options[0]!.value;
    }, load: async (_cwd, id) => { selectedId = id; return undefined as never; } });
  assert.equal(selectedId, session.id);
});

const run = { runId: "aaaa1111-0000-4000-8000-000000000001", startedAt: "2026-11-06T00:00:00Z", status: "completed", taskPreview: title, operations: [] } as unknown as TaskRunRecord;

test("report run summaries strip terminal controls without changing saved task previews", () => {
  assertPlain(formatRunList([run], "en-US"));
  assert.match(formatRunList([run], "en-US"), /inspect 代码 safely/);
  assert.equal(run.taskPreview, title);
});

test("diff run summaries strip terminal controls in saved task previews", async () => {
  const text = await formatRunChangeList({ cwd: "/fixture", taskRunJournal: { recent: async () => [run], latest: async () => run }, loadHistory: async () => undefined }, "en-US");
  assertPlain(text);
  assert.match(text, /inspect 代码 safely/);
});

test("startup recovery displays plain metadata without rewriting evidence or taking an action", async () => {
  const interrupted = { ...run, pendingSideEffects: [], recoveryPoints: [{ evidence: title }] } as unknown as InterruptedTaskRun;
  const lines: string[] = [];
  const result = await resolveStartupRecovery({ config: { cwd: "/fixture" }, language: "en-US", oneShot: false,
    refuseToStart: () => { throw new Error("unexpected refusal"); },
    taskRunJournal: { interrupted: async () => interrupted, abandon: async () => { throw new Error("unexpected abandon"); } },
    io: { log: (line) => { lines.push(line); }, select: async () => "exit", loadSession: async () => { throw new Error("unexpected restore"); } } });
  assert.deepEqual(result, { action: "exit", failed: false });
  assertPlain(lines.join("\n"));
  assert.equal(interrupted.taskPreview, title);
  assert.equal(interrupted.recoveryPoints[0]!.evidence, title);
});
