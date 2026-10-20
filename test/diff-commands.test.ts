import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatRunChangeList, parseDiffCommand, replayRunChanges } from "../src/commands/diff-commands.js";
import { terminalDisplayWidth } from "../src/interactive-ui.js";
import { formatLocalTime } from "../src/local-time.js";
import { saveTaskChangeHistory } from "../src/task-change-history.js";
import type { TaskChangeReport } from "../src/task-changes.js";
import { TASK_RUN_SCHEMA_VERSION, TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";

const RUN_IDS = ["3f2a9c1e-0000-4000-8000-000000000001", "3f2a0000-0000-4000-8000-000000000002", "7b00c0de-0000-4000-8000-000000000003"];

async function fixture(): Promise<{ cwd: string; taskRunJournal: TaskRunJournal }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-diff-commands-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const journal = new TaskRunJournal(cwd, path.join(root, "task-runs"));
  await fs.mkdir(path.join(root, "task-runs", journal.workspaceId), { recursive: true });
  for (const [index, runId] of RUN_IDS.entries()) {
    const day = String(20 - index - 1).padStart(2, "0");
    const record: TaskRunRecord = {
      version: TASK_RUN_SCHEMA_VERSION, runId, workspaceId: journal.workspaceId, sessionId: "session-1",
      taskPreview: index === 0 ? "rename the helper api_key=sk-diff-secret-1234567890" : `older task ${index + 1}`,
      providerId: "provider", model: "model", status: index === 2 ? "cancelled" : "completed",
      startedAt: `2026-10-${day}T01:00:00.000Z`, updatedAt: `2026-10-${day}T01:00:10.000Z`, finishedAt: `2026-10-${day}T01:00:10.000Z`,
      ownerPid: 1, ownerInstance: "instance", operations: [], recoveryPoints: [], events: [],
    };
    await fs.writeFile(path.join(root, "task-runs", journal.workspaceId, `${runId}.json`), JSON.stringify(record));
  }
  const latest: TaskChangeReport = {
    view: "task", git: true, capturedAt: "2026-10-19T01:00:00.000Z", complete: true, preExisting: ["docs/notes.md"], warnings: [],
    changes: [
      { path: "src/helper.ts", kind: "modified", source: "unknown", preExisting: false, staged: false, preview: "@@ -1,1 +1,1 @@\n-old\n+new", fullDiff: "@@ -1,2 +1,2 @@\n-old helper\n+new helper\n token=sk-diff-secret-1234567890", stats: { additions: 1, deletions: 1, exact: true }, limitations: [] },
      { path: "assets/logo.png", kind: "created", source: "unknown", preExisting: false, staged: true, limitations: ["binary"] },
    ],
  };
  await saveTaskChangeHistory(cwd, RUN_IDS[0]!, latest);
  await saveTaskChangeHistory(cwd, RUN_IDS[1]!, { view: "task", git: true, complete: true, preExisting: [], warnings: [], changes: [] });
  return { cwd, taskRunJournal: journal };
}

test("parseDiffCommand recognizes views, the run list, run selectors with an optional file, and usage errors", () => {
  assert.deepEqual(parseDiffCommand("/diff"), { kind: "view", view: "task" });
  assert.deepEqual(parseDiffCommand("/diff staged"), { kind: "view", view: "staged" });
  assert.deepEqual(parseDiffCommand("/diff runs"), { kind: "runs" });
  assert.deepEqual(parseDiffCommand("/diff run:2"), { kind: "run", selector: "2" });
  assert.deepEqual(parseDiffCommand("/diff RUN:7b00  src/a.ts"), { kind: "run", selector: "7b00", file: "src/a.ts" });
  assert.deepEqual(parseDiffCommand("/diff run:1 a b"), { kind: "usage" });
  assert.deepEqual(parseDiffCommand("/diff workspace extra"), { kind: "usage" });
  assert.deepEqual(parseDiffCommand("/diff all"), { kind: "usage" });
});

/** The fixture's start time as the list prints it (local time), escaped for a RegExp. */
function localTime(iso: string): string {
  return formatLocalTime(iso).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("/diff runs lists recent runs newest first with the saved change count or a dash", async () => {
  const f = await fixture();
  const text = await formatRunChangeList(f, "en-US");
  const lines = text.split("\n");
  assert.match(lines[0]!, /^#\s+run id\s+started\s+status\s+changed\s+task/);
  assert.match(lines[1]!, new RegExp(`^1\\s+3f2a9c1e\\s+${localTime("2026-10-19T01:00:00.000Z")}\\s+completed\\s+2\\s+rename the helper`));
  assert.match(lines[2]!, new RegExp(`^2\\s+3f2a0000\\s+${localTime("2026-10-18T01:00:00.000Z")}\\s+completed\\s+0\\s+older task 2`));
  assert.match(lines[3]!, new RegExp(`^3\\s+7b00c0de\\s+${localTime("2026-10-17T01:00:00.000Z")}\\s+cancelled\\s+-\\s+older task 3`));
  assert.doesNotMatch(text, /T01:00:00/, "the start time is local time, not the stored ISO string");
  // Chinese: the status is a label, and the task column still starts at one display column on every row.
  const zh = (await formatRunChangeList(f, "zh-CN")).split("\n");
  assert.match(zh[0]!, /^序号\s+运行 ID\s+开始时间\s+状态\s+改动文件\s+任务/);
  assert.match(zh[1]!, new RegExp(`^1\\s+3f2a9c1e\\s+${localTime("2026-10-19T01:00:00.000Z")}\\s+已完成\\s+2\\s+rename the helper`));
  assert.match(zh[3]!, new RegExp(`^3\\s+7b00c0de\\s+${localTime("2026-10-17T01:00:00.000Z")}\\s+已取消\\s+-\\s+older task 3`));
  const taskColumn = (line: string, task: string) => terminalDisplayWidth(line.slice(0, line.indexOf(task)));
  assert.equal(taskColumn(zh[1]!, "rename the helper"), taskColumn(zh[3]!, "older task 3"));
  assert.equal(taskColumn(zh[1]!, "rename the helper"), taskColumn(lines[1]!, "rename the helper"), "both languages use the same columns");
  assert.equal(taskColumn(zh[0]!, "任务"), taskColumn(zh[1]!, "rename the helper"), "the header lines up with the rows");
  assert.doesNotMatch(text, /sk-diff-secret/);
  assert.match(text, /\/diff run:3f2a9c1e src\/index\.ts/);
});

test("/diff run:<selector> replays the saved report and never substitutes the current workspace", async () => {
  const f = await fixture();
  const byIndex = await replayRunChanges(f, "1", undefined, "en-US");
  assert.match(byIndex, /^Run 3f2a9c1e · 2026-10-19T01:00:00 · completed · rename the helper/);
  assert.match(byIndex, /saved when the task finished, not the current workspace state/);
  assert.match(byIndex, /Changes during this task/);
  assert.match(byIndex, /Pre-existing changes: 1/);
  assert.match(byIndex, /modified "src\/helper\.ts"/);
  assert.match(byIndex, /created "assets\/logo\.png" \[staged\]/);
  assert.doesNotMatch(byIndex, /sk-diff-secret/);
  const byPrefix = await replayRunChanges(f, "3F2A0", undefined, "zh-CN");
  assert.match(byPrefix, /^运行 3f2a0000 · 2026-10-18T01:00:00 · completed · older task 2/);
  assert.match(byPrefix, /在已覆盖的文件中未发现变化/);
  await assert.rejects(replayRunChanges(f, "3", undefined, "en-US"), /Run 7b00c0de has no saved change record/);
  await assert.rejects(replayRunChanges(f, "3f2a", undefined, "en-US"), /matches 2 runs/);
  await assert.rejects(replayRunChanges(f, "9", undefined, "en-US"), /no run #9; 3 recent run\(s\) exist\. List them with \/diff runs/);
  await assert.rejects(replayRunChanges(f, "3f2", undefined, "en-US"), /at least 4 characters/);
});

test("/diff run:<selector> <file> shows that file's saved complete diff, falls back to the preview, and rejects unknown files", async () => {
  const f = await fixture();
  const full = await replayRunChanges(f, "1", "./src\\helper.ts", "en-US");
  assert.match(full, /modified "src\/helper\.ts"/);
  assert.match(full, /Stats: \+1 \/ -1/);
  assert.match(full, /-old helper\n\+new helper/);
  assert.doesNotMatch(full, /sk-diff-secret/);
  const binary = await replayRunChanges(f, "1", "assets/logo.png", "zh-CN");
  assert.match(binary, /新增 "assets\/logo\.png" \[已暂存\]/);
  assert.match(binary, /没有可显示的文本差异/);
  assert.match(binary, /详情限制: binary/);
  await assert.rejects(replayRunChanges(f, "1", "src/missing.ts", "en-US"), /has no "src\/missing\.ts"; it covers 2 file\(s\), listed by \/diff run:1/);
});

test("a saved change record that cannot be read is told apart from a missing one", async () => {
  const f = await fixture();
  const file = path.join(await fs.realpath(f.cwd), ".xiu", "task-change-history", `${RUN_IDS[2]}.json`);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 99, runId: RUN_IDS[2], savedAt: "2026-10-17T01:00:10.000Z", report: {} }));

  const list = await formatRunChangeList(f, "en-US");
  assert.match(list.split("\n")[3]!, new RegExp(`^3\\s+7b00c0de\\s+${localTime("2026-10-17T01:00:00.000Z")}\\s+cancelled\\s+!\\s+older task 3`), "an unreadable record shows ! where a missing one shows -");
  assert.match(list, /"!" a record that exists but cannot be read/);
  assert.match(await formatRunChangeList(f, "zh-CN"), /“!”表示记录存在但无法读取/);

  await assert.rejects(replayRunChanges(f, "3", undefined, "en-US"), /^Error: The change record of run 7b00c0de cannot be read \(Unsupported or corrupt task change history file\.\): the record exists but is corrupt, altered or over its limits\. The current workspace diff is not shown in its place/);
  await assert.rejects(replayRunChanges(f, "3", "src/a.ts", "zh-CN"), /^Error: 运行 7b00c0de 的改动记录无法读取（Unsupported or corrupt task change history file\.）：记录存在但已损坏/);
  await assert.rejects(replayRunChanges(f, "3", undefined, "en-US"), (error: Error) => !error.message.includes(f.cwd), "no path leaks into the message");

  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(replayRunChanges(f, "3", undefined, "en-US"), /cannot be read \(Unsafe or oversized task change history file\.\)/);
});

test("/diff runs lists the readable runs and says how many journal records it could not read", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(path.dirname(f.cwd), "task-runs", f.taskRunJournal.workspaceId, "not-json.json"), "{not json");
  const text = await formatRunChangeList(f, "en-US");
  assert.match(text, /^1\s+3f2a9c1e\s+/m);
  assert.match(text, /\n1 more run record\(s\) could not be read \(corrupt ×1\) and are not listed/);
  assert.match(await formatRunChangeList(f, "zh-CN"), /\n另有 1 条运行记录无法读取（corrupt ×1），未列出/);
});

test("/diff runs on a workspace without runs says so", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-diff-commands-empty-"));
  const journal = new TaskRunJournal(root, path.join(root, "task-runs"));
  assert.equal(await formatRunChangeList({ cwd: root, taskRunJournal: journal }, "en-US"), "This workspace has no task run yet.");
  await assert.rejects(replayRunChanges({ cwd: root, taskRunJournal: journal }, "1", undefined, "en-US"), /no run #1; 0 recent run\(s\) exist/);
});
