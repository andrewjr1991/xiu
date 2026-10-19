import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReportCommand } from "../src/commands/report-commands.js";
import { collectExecutionReportInputs } from "../src/execution-report-query.js";
import type { ExecutionReport } from "../src/execution-report.js";
import { SecurityAuditLog } from "../src/security-audit.js";
import { TASK_RUN_SCHEMA_VERSION, TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

/**
 * The execution report's file changes, receipts and task chain come from the run's session log.
 * When that log is missing, unreadable or holds no turn for the run, the report must say so: an
 * empty "file changes" section would read as "the task changed nothing". Before, the query
 * swallowed every session-log failure and the report showed "none recorded".
 */

interface Fixture { root: string; cwd: string; journal: TaskRunJournal; audit: SecurityAuditLog; out: string[]; err: string[] }

async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-report-session-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const journal = new TaskRunJournal(cwd, path.join(root, "task-runs"));
  const record: TaskRunRecord = {
    version: TASK_RUN_SCHEMA_VERSION,
    runId: "3f2a9c1e-0000-4000-8000-000000000001",
    workspaceId: journal.workspaceId,
    sessionId: "session-1",
    taskPreview: "update the README",
    providerId: "provider",
    model: "model",
    status: "completed",
    startedAt: "2026-10-19T01:00:00.000Z",
    updatedAt: "2026-10-19T01:00:10.000Z",
    finishedAt: "2026-10-19T01:00:10.000Z",
    ownerPid: 1,
    ownerInstance: "instance",
    operations: [
      { id: "tool", kind: "tool", name: "write_file", risk: "write", sideEffect: "workspace", replay: "verify-first", status: "succeeded", startedAt: "2026-10-19T01:00:02.000Z", finishedAt: "2026-10-19T01:00:03.000Z" },
      { id: "verify", kind: "verification", name: "npm test", sideEffect: "process", replay: "forbidden", status: "succeeded", startedAt: "2026-10-19T01:00:03.000Z", finishedAt: "2026-10-19T01:00:10.000Z", evidence: "12 tests passed" },
    ],
    recoveryPoints: [],
    events: [],
  };
  await fs.mkdir(path.join(root, "task-runs", journal.workspaceId), { recursive: true });
  await fs.writeFile(path.join(root, "task-runs", journal.workspaceId, `${record.runId}.json`), JSON.stringify(record));
  return { root, cwd, journal, audit: new SecurityAuditLog(path.join(root, "security-audit.jsonl"), cwd), out: [], err: [] };
}

function sessionFile(f: Fixture): string {
  return path.join(f.cwd, ".xiu", "sessions", "session-1.jsonl");
}

async function report(f: Fixture, format: "markdown" | "json" | "html", language: "zh-CN" | "en-US" = "en-US"): Promise<string> {
  f.out.length = 0;
  const code = await runReportCommand(format === "markdown" ? [] : [format], {
    cwd: f.cwd, language, yes: false, stdout: (text) => f.out.push(text), stderr: (text) => f.err.push(text),
    sources: { taskRunJournal: f.journal, securityAudit: f.audit }, isTrusted: async () => true,
  });
  assert.equal(code, 0, "a degraded session log never fails the report");
  return f.out.join("");
}

test("a report whose session log is missing says so instead of showing no file changes", async (t) => {
  const f = await fixture(t);

  const markdown = await report(f, "markdown");
  assert.match(markdown, /^- Sources: session log missing \(session session-\): file changes, receipts and the task chain cannot be listed; the rest comes from the run record and the audit ledger alone$/m);
  assert.match(markdown, /## File changes\n- unavailable \(see Sources\)\n/, "the empty section points at the note instead of claiming nothing changed");
  assert.match(markdown, /## Key actions and evidence\n- write_file\n/, "the run record's own evidence is still reported");
  assert.match(markdown, /succeeded · npm test · 12 tests passed/);

  const chinese = await report(f, "markdown", "zh-CN");
  assert.match(chinese, /^- 来源: 会话日志缺失（会话 session-）：文件变化、操作回执与任务链无法列出，其余内容仅来自运行记录与审计账本$/m);
  assert.match(chinese, /## 文件变化\n- 无法列出（见“来源”）\n/);

  const json = JSON.parse(await report(f, "json")) as ExecutionReport;
  assert.deepEqual(json.sessionLog, { status: "missing", sessionId: "session-1" });
  assert.deepEqual(json.files, []);

  const html = await report(f, "html");
  assert.match(html, /<dt>Sources<\/dt><dd><span class="warn">session log missing \(session session-\)/);
  assert.match(html, /<h2>File changes<\/h2>\n<p class="empty">unavailable \(see Sources\)<\/p>/);
  assert.doesNotMatch(html, /none recorded/);
});

test("an unreadable session log is reported with its error code and no path", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(sessionFile(f), { recursive: true });

  const json = JSON.parse(await report(f, "json")) as ExecutionReport;
  assert.deepEqual(json.sessionLog, { status: "unreadable", sessionId: "session-1", detail: "EISDIR" });
  const markdown = await report(f, "markdown");
  assert.match(markdown, /^- Sources: session log unreadable \(session session-, EISDIR\): /m);
  assert.doesNotMatch(markdown, new RegExp(f.root.replace(/[\\/]/g, "[\\\\/]")), "no file system path leaks into the report");
  assert.match(await report(f, "markdown", "zh-CN"), /^- 来源: 会话日志无法读取（会话 session-，EISDIR）：/m);
});

test("a session log without a turn for the run is distinguished from a missing one", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(sessionFile(f)), { recursive: true });
  await fs.writeFile(sessionFile(f), `${JSON.stringify({ type: "stats", stats: { turns: 0 }, timestamp: "2026-10-19T01:00:00.000Z" })}\n`);

  const inputs = await collectExecutionReportInputs({ cwd: f.cwd, taskRunJournal: f.journal, securityAudit: f.audit });
  assert.deepEqual(inputs?.sessionLog, { status: "turn-missing", sessionId: "session-1" });
  assert.equal(inputs?.turn, undefined);
  assert.match(await report(f, "markdown"), /^- Sources: the session log has no turn for this run \(session session-\): file changes/m);
  assert.match(await report(f, "markdown", "zh-CN"), /^- 来源: 会话日志里没有这次运行的轮次（会话 session-）：/m);
});

test("a report backed by its session log carries no note and lists the turn's file changes", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(sessionFile(f)), { recursive: true });
  const turn = {
    task: "update the README", inputKind: "task", supplements: [], response: "README updated.",
    changes: [{ tool: "write_file", paths: ["README.md"], description: "write_file write README.md", files: [{ path: "README.md", kind: "modified", additions: 3, deletions: 1, bytesBefore: 120, bytesAfter: 180, preview: [] }] }],
    receipts: ["npm test: 12 tests passed"], completion: { message: "done", success: true }, exact: true,
  };
  await fs.writeFile(sessionFile(f), [
    JSON.stringify({ type: "task", task: "update the README", timestamp: "2026-10-19T01:00:00.000Z" }),
    JSON.stringify({ type: "ui_turn", turn, timestamp: "2026-10-19T01:00:10.000Z" }),
  ].map((line) => `${line}\n`).join(""));

  const json = JSON.parse(await report(f, "json")) as ExecutionReport;
  assert.deepEqual(json.sessionLog, { status: "read", sessionId: "session-1" });
  assert.equal(json.files.length, 1);
  const markdown = await report(f, "markdown");
  assert.doesNotMatch(markdown, /^- Sources:/m);
  assert.doesNotMatch(markdown, /unavailable/);
  assert.match(markdown, /modified `README\.md` \+3 -1/);
  assert.doesNotMatch(await report(f, "html"), /<dt>Sources<\/dt>/);
});
