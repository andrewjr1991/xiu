import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { runReportCommand } from "../src/commands/report-commands.js";
import { buildExecutionReport, formatExecutionReport } from "../src/execution-report.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { SecurityAuditLog } from "../src/security-audit.js";
import { TASK_RUN_SCHEMA_VERSION, TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

/**
 * The desktop's "报告与诊断" panel and the CLI's `xiu report` read the same task run through the
 * same query, so a run reports its file changes, verification and task chain identically on
 * both surfaces. Before, the desktop built its report from the run record alone and showed no
 * file changes for a task that had changed files.
 */

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-report-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, ".xiu", "sessions"), { recursive: true });
  const journal = new TaskRunJournal(workspace, path.join(root, "task-runs"));
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
      { id: "model", kind: "model", name: "turn 1", sideEffect: "none", replay: "safe-after-confirmation", status: "succeeded", startedAt: "2026-10-19T01:00:00.000Z", finishedAt: "2026-10-19T01:00:02.000Z" },
      { id: "tool", kind: "tool", name: "write_file", risk: "write", sideEffect: "workspace", replay: "verify-first", status: "succeeded", startedAt: "2026-10-19T01:00:02.000Z", finishedAt: "2026-10-19T01:00:03.000Z" },
      { id: "verify", kind: "verification", name: "npm test", sideEffect: "process", replay: "forbidden", status: "succeeded", startedAt: "2026-10-19T01:00:03.000Z", finishedAt: "2026-10-19T01:00:10.000Z", evidence: "12 tests passed" },
    ],
    recoveryPoints: [],
    events: [],
  };
  await fs.mkdir(path.join(root, "task-runs", journal.workspaceId), { recursive: true });
  await fs.writeFile(path.join(root, "task-runs", journal.workspaceId, `${record.runId}.json`), JSON.stringify(record));
  const turn = {
    task: "update the README", inputKind: "task", supplements: [], response: "README updated and tests pass.",
    changes: [{ tool: "write_file", paths: ["README.md"], description: "write_file write README.md", files: [{ path: "README.md", kind: "modified", additions: 3, deletions: 1, bytesBefore: 120, bytesAfter: 180, preview: ["+ ## Install"] }] }],
    receipts: ["npm test: 12 tests passed"], completion: { message: "done", success: true }, exact: true,
  };
  await fs.writeFile(path.join(workspace, ".xiu", "sessions", "session-1.jsonl"), [
    JSON.stringify({ type: "task", task: "update the README", timestamp: "2026-10-19T01:00:00.000Z" }),
    JSON.stringify({ type: "ui_turn", turn, timestamp: "2026-10-19T01:00:10.000Z" }),
  ].map((line) => `${line}\n`).join(""));
  return { root, workspace, journal, record };
}

test("the desktop report panel shows the same report as xiu report, including the run's file changes", async (t) => {
  const { root, workspace, journal, record } = await fixture(t);
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime: new XiuRuntime(), journal, provider: { id: "p", label: "p", model: "m" } }));
  const desktop = await controller.taskDiagnostics(workspace);

  assert.match(desktop.report, /^# Xiu 完整执行报告/);
  assert.match(desktop.report, /update the README/);
  assert.match(desktop.report, /`README\.md` \+3 -1/, "file changes come from the session turn, not only from the run record");
  assert.match(desktop.report, /npm test/);
  assert.equal(desktop.diagnostics.length > 0, true);

  const runOnly = formatExecutionReport(buildExecutionReport({ cwd: workspace, run: record }), "zh-CN");
  assert.doesNotMatch(runOnly, /README\.md/, "the old run-only report had no file changes to show");

  const out: string[] = [];
  const code = await runReportCommand([], {
    cwd: workspace, language: "zh-CN", yes: false, stdout: (text) => out.push(text), stderr: () => undefined,
    sources: { taskRunJournal: journal, securityAudit: new SecurityAuditLog(path.join(root, "security-audit.jsonl"), workspace) },
    isTrusted: async () => true,
  });
  assert.equal(code, 0);
  assert.equal(desktop.report, out[0]!.trimEnd(), "desktop and CLI render the same report for the same run");
});

test("the desktop report panel says so when the workspace has no run yet", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-report-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const journal = new TaskRunJournal(workspace, path.join(root, "task-runs"));
  const controller = new DesktopTaskController(() => undefined, async () => ({ runtime: new XiuRuntime(), journal, provider: { id: "p", label: "p", model: "m" } }));
  const { report } = await controller.taskDiagnostics(workspace);
  assert.equal(report, "尚无任务报告。");
});
