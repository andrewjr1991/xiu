import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReportCommand } from "../src/commands/report-commands.js";
import { SecurityAuditLog } from "../src/security-audit.js";
import { TASK_RUN_SCHEMA_VERSION, TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

interface Fixture { cwd: string; journal: TaskRunJournal; audit: SecurityAuditLog; out: string[]; err: string[] }

async function fixture(withRun = true): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-report-command-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const journal = new TaskRunJournal(cwd, path.join(root, "task-runs"));
  const audit = new SecurityAuditLog(path.join(root, "security-audit.jsonl"), cwd);
  if (withRun) {
    const record: TaskRunRecord = {
      version: TASK_RUN_SCHEMA_VERSION,
      runId: "run-1",
      workspaceId: journal.workspaceId,
      sessionId: "session-1",
      taskPreview: "update the README api_key=sk-report-secret-1234567890",
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
        { id: "verify", kind: "verification", name: "npm test", sideEffect: "process", replay: "forbidden", status: "succeeded", startedAt: "2026-10-19T01:00:03.000Z", finishedAt: "2026-10-19T01:00:10.000Z" },
      ],
      recoveryPoints: [],
      events: [],
    };
    await fs.mkdir(path.join(root, "task-runs", journal.workspaceId), { recursive: true });
    await fs.writeFile(path.join(root, "task-runs", journal.workspaceId, "run-1.json"), JSON.stringify(record));
  }
  return { cwd, journal, audit, out: [], err: [] };
}

function run(f: Fixture, args: string[], options: { yes?: boolean; trusted?: boolean; language?: "zh-CN" | "en-US" } = {}): Promise<number> {
  return runReportCommand(args, {
    cwd: f.cwd,
    language: options.language ?? "en-US",
    yes: options.yes ?? false,
    stdout: (text) => f.out.push(text),
    stderr: (text) => f.err.push(text),
    sources: { taskRunJournal: f.journal, securityAudit: f.audit },
    isTrusted: async () => options.trusted ?? true,
  });
}

test("xiu report prints the latest task's Markdown summary to stdout by default", async () => {
  const f = await fixture();
  assert.equal(await run(f, []), 0);
  assert.equal(f.err.length, 0);
  assert.equal(f.out.length, 1);
  assert.match(f.out[0]!, /update the README/);
  assert.match(f.out[0]!, /npm test/);
  assert.ok(!f.out[0]!.includes("sk-report-secret-1234567890"), "secrets never reach the report");
});

test("xiu report writes html or json inside the workspace and overwrites only with --yes", async () => {
  const f = await fixture();
  assert.equal(await run(f, ["details", "html", "reports/latest.html"]), 0);
  const html = await fs.readFile(path.join(f.cwd, "reports", "latest.html"), "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.match(f.err.at(-1)!, /Execution report exported: reports[\\/]latest\.html/);
  assert.equal(f.out.length, 0, "a file export writes nothing to stdout");

  assert.equal(await run(f, ["html", "reports/latest.html"]), 1);
  assert.match(f.err.at(-1)!, /already exists.*--yes/);
  assert.equal(await fs.readFile(path.join(f.cwd, "reports", "latest.html"), "utf8"), html, "the existing file is untouched");

  assert.equal(await run(f, ["json", "reports/latest.html"], { yes: true }), 0);
  const parsed = JSON.parse(await fs.readFile(path.join(f.cwd, "reports", "latest.html"), "utf8")) as { scope?: string };
  assert.equal(parsed.scope, "summary");

  assert.equal(await run(f, ["md", "../outside.md"], { yes: true }), 1);
  assert.match(f.err.at(-1)!, /inside the workspace/);
});

test("xiu report refuses bad usage, untrusted workspaces and workspaces without a run", async () => {
  const f = await fixture();
  assert.equal(await run(f, ["--format", "html"]), 1);
  assert.match(f.err.at(-1)!, /Usage: xiu report/);
  assert.equal(await run(f, ["a.md", "b.md"]), 1);
  assert.match(f.err.at(-1)!, /Usage: xiu report/);
  assert.equal(f.out.length, 0);
  assert.equal(await run(f, [], { trusted: false, language: "zh-CN" }), 1);
  assert.match(f.err.at(-1)!, /工作区尚未信任/);
  const empty = await fixture(false);
  assert.equal(await run(empty, []), 1);
  assert.match(empty.err.at(-1)!, /no task run to report yet/);
  assert.equal(empty.out.length, 0);
});
