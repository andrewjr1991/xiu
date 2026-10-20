import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReportCommand } from "../src/commands/report-commands.js";
import { formatLocalTime } from "../src/local-time.js";
import { SecurityAuditLog } from "../src/security-audit.js";
import { TASK_RUN_SCHEMA_VERSION, TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

interface Fixture { cwd: string; journal: TaskRunJournal; audit: SecurityAuditLog; out: string[]; err: string[] }

async function fixture(withRun = true, runs = 1): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-report-command-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const journal = new TaskRunJournal(cwd, path.join(root, "task-runs"));
  const audit = new SecurityAuditLog(path.join(root, "security-audit.jsonl"), cwd);
  for (let index = 1; withRun && index <= runs; index++) {
    const record: TaskRunRecord = {
      version: TASK_RUN_SCHEMA_VERSION,
      runId: `${["3f2a9c1e", "3f2a0000", "7b00c0de"][index - 1] ?? `run-${index}`}-0000-4000-8000-00000000000${index}`,
      workspaceId: journal.workspaceId,
      sessionId: "session-1",
      taskPreview: index === 1 ? "update the README api_key=sk-report-secret-1234567890" : `older task ${index}`,
      providerId: "provider",
      model: "model",
      status: "completed",
      startedAt: `2026-10-${String(20 - index).padStart(2, "0")}T01:00:00.000Z`,
      updatedAt: `2026-10-${String(20 - index).padStart(2, "0")}T01:00:10.000Z`,
      finishedAt: `2026-10-${String(20 - index).padStart(2, "0")}T01:00:10.000Z`,
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
    await fs.writeFile(path.join(root, "task-runs", journal.workspaceId, `${record.runId}.json`), JSON.stringify(record));
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

test("xiu report runs lists recent runs and run:<selector> picks one by index or id prefix", async () => {
  const f = await fixture(true, 3);
  assert.equal(await run(f, ["runs"]), 0);
  const listing = f.out.at(-1)!;
  const rows = listing.split("\n");
  const localTime = (iso: string) => formatLocalTime(iso).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(rows[1]!, new RegExp(`^1\\s+3f2a9c1e\\s+${localTime("2026-10-19T01:00:00.000Z")}\\s+completed\\s+update the README`));
  assert.match(rows[2]!, new RegExp(`^2\\s+3f2a0000\\s+${localTime("2026-10-18T01:00:00.000Z")}\\s+completed\\s+older task 2`));
  assert.doesNotMatch(listing, /T01:00:00/, "the start time is local time, not the stored ISO string");
  assert.match(rows[3]!, /^3\s+7b00c0de\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+completed/);
  assert.equal(await run(f, ["runs"], { language: "zh-CN" }), 0);
  assert.match(f.out.at(-1)!.split("\n")[1]!, new RegExp(`^1\\s+3f2a9c1e\\s+${localTime("2026-10-19T01:00:00.000Z")}\\s+已完成\\s+update the README`), "the Chinese list labels the status");
  assert.ok(!listing.includes("sk-report-secret"), "the listing shows the stored preview, which is already redacted at write time");

  f.out.length = 0;
  assert.equal(await run(f, ["run:2"]), 0);
  assert.match(f.out[0]!, /older task 2/);
  assert.doesNotMatch(f.out[0]!, /update the README/);

  f.out.length = 0;
  assert.equal(await run(f, ["RUN:7b00", "json"]), 0);
  assert.match(f.out[0]!, /older task 3/);

  assert.equal(await run(f, ["run:3f2a"]), 1);
  assert.match(f.err.at(-1)!, /matches 2 runs/);
  assert.equal(await run(f, ["run:9"]), 1);
  assert.match(f.err.at(-1)!, /no run #9; 3 recent/);
  assert.equal(await run(f, ["run:3f2"]), 1);
  assert.match(f.err.at(-1)!, /at least 4 characters/);
  assert.equal(await run(f, ["runs", "run:1"]), 1);
  assert.match(f.err.at(-1)!, /Usage: xiu report/);

  const empty = await fixture(false);
  assert.equal(await run(empty, ["runs"]), 1);
  assert.match(empty.err.at(-1)!, /no task run to report yet/);
});

test("xiu report runs lists the readable runs and says how many records it could not read", async () => {
  const f = await fixture();
  const directory = path.join(path.dirname(f.cwd), "task-runs", f.journal.workspaceId);
  await fs.writeFile(path.join(directory, "bad-version.json"), JSON.stringify({ version: 99, runId: "bad-version" }));
  await fs.writeFile(path.join(directory, "not-json.json"), "{not json");

  assert.equal(await run(f, ["runs"]), 0);
  const listing = f.out.at(-1)!;
  assert.match(listing, /^1\s+3f2a9c1e\s+/m, "the readable run is still listed");
  assert.match(listing, /\n2 more run record\(s\) could not be read \(corrupt ×2\) and are not listed; the runs shown are unaffected, and the interrupted-task check is unchanged\.$/);
  assert.doesNotMatch(listing, /bad-version|not-json|task-runs/, "no file name or path is echoed");
  assert.equal(await run(f, ["runs"], { language: "zh-CN" }), 0);
  assert.match(f.out.at(-1)!, /另有 2 条运行记录无法读取（corrupt ×2），未列出/);
  assert.equal(await run(f, []), 0, "the latest readable run still reports");
  assert.match(f.out.at(-1)!, /update the README/);

  const empty = await fixture(false);
  const emptyDirectory = path.join(path.dirname(empty.cwd), "task-runs", empty.journal.workspaceId);
  await fs.mkdir(emptyDirectory, { recursive: true });
  await fs.writeFile(path.join(emptyDirectory, "not-json.json"), "{not json");
  assert.equal(await run(empty, ["runs"]), 1);
  assert.match(empty.err.at(-1)!, /no task run to report yet\.\n1 more run record\(s\) could not be read \(corrupt ×1\)/);
  assert.equal(empty.out.length, 0);
});
