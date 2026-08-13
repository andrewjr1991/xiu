import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildExecutionReport, formatExecutionReport, serializeExecutionReport, writeExecutionReport } from "../src/execution-report.js";
import type { SessionReplayTurn } from "../src/session.js";
import type { TaskRunRecord } from "../src/task-run.js";

function run(): TaskRunRecord {
  return {
    version: 1,
    runId: "run-1",
    workspaceId: "workspace",
    sessionId: "session-1",
    taskPreview: "update project",
    providerId: "provider",
    model: "model",
    status: "completed",
    startedAt: "2026-08-12T01:00:00.000Z",
    updatedAt: "2026-08-12T01:00:10.000Z",
    finishedAt: "2026-08-12T01:00:10.000Z",
    ownerPid: 1,
    ownerInstance: "instance",
    operations: [
      { id: "model", kind: "model", name: "turn 1", sideEffect: "none", replay: "safe-after-confirmation", status: "succeeded", startedAt: "2026-08-12T01:00:00.000Z", finishedAt: "2026-08-12T01:00:02.000Z" },
      { id: "tool", kind: "tool", name: "write_file", risk: "write", sideEffect: "workspace", replay: "verify-first", status: "succeeded", startedAt: "2026-08-12T01:00:02.000Z", finishedAt: "2026-08-12T01:00:03.000Z" },
      { id: "verify", kind: "verification", name: "npm test", sideEffect: "process", replay: "forbidden", status: "succeeded", startedAt: "2026-08-12T01:00:03.000Z", finishedAt: "2026-08-12T01:00:10.000Z", evidence: "12 tests passed" },
    ],
    recoveryPoints: [{ id: "point", kind: "verification", at: "2026-08-12T01:00:10.000Z", evidence: "tests passed" }],
    events: [],
  };
}

function turn(secret: string): SessionReplayTurn {
  return {
    task: `Update app api_key=${secret}`,
    supplements: [],
    changes: [{
      tool: "write_file",
      paths: ["src/app.ts"],
      description: "updated",
      files: [{ path: "src/app.ts", kind: "modified", additions: 2, deletions: 1, bytesBefore: 10, bytesAfter: 20, preview: [`+ api_key=${secret}`, "+ safe line"] }],
    }],
    receipts: [],
    completion: { message: "verified", success: true },
    exact: true,
  };
}

test("summary reports are bounded and exclude source previews and secrets", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const report = buildExecutionReport({ cwd: "D:/workspace", run: run(), turn: turn(secret), scope: "summary" });
  const text = serializeExecutionReport(report, "json", "en-US");
  assert.equal(report.outcome.complete, true);
  assert.equal(report.outcome.verified, true);
  assert.equal(report.files[0]?.preview, undefined);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(formatExecutionReport(report, "zh-CN"), /已验证/);
});

test("details add only a small redacted preview", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const report = buildExecutionReport({ cwd: "D:/workspace", run: run(), turn: turn(secret), scope: "details" });
  assert.equal(report.bounded.sourceContentIncluded, true);
  assert.ok(report.files[0]?.preview?.length);
  assert.doesNotMatch(JSON.stringify(report.files[0]?.preview), new RegExp(secret));
});

test("a completed read-only task is not labeled verified without verification evidence", () => {
  const item = run();
  item.operations = item.operations.filter((operation) => operation.kind !== "tool" && operation.kind !== "verification");
  const replay = turn("sk-abcdefghijklmnopqrstuvwxyz012345");
  replay.changes = [];
  const report = buildExecutionReport({ cwd: "D:/workspace", run: item, turn: replay });
  assert.equal(report.outcome.complete, true);
  assert.equal(report.outcome.verified, false);
  assert.equal(report.verification.length, 0);
});

test("continued task runs report the original goal and cumulative file evidence", () => {
  const firstRun = run();
  firstRun.status = "unverified";
  const finalRun = run();
  finalRun.runId = "run-2";
  finalRun.taskPreview = "Continue the unfinished task from the existing evidence. Original goal: Fix startup";
  finalRun.startedAt = "2026-08-12T01:00:11.000Z";
  finalRun.updatedAt = "2026-08-12T01:00:20.000Z";
  finalRun.finishedAt = "2026-08-12T01:00:20.000Z";
  finalRun.operations = finalRun.operations.filter((item) => item.kind !== "tool");
  const firstTurn = turn("sk-abcdefghijklmnopqrstuvwxyz012345");
  firstTurn.task = "Fix startup";
  firstTurn.completion = { message: "unverified", success: false };
  const finalTurn: SessionReplayTurn = {
    task: "Continue the unfinished task from the existing evidence. Do not restart the investigation or repeat successful reads. Original goal: Fix startup",
    supplements: [], changes: [], receipts: ["verified startup"], completion: { message: "verified", success: true }, exact: true,
  };
  const report = buildExecutionReport({ cwd: "D:/workspace", run: finalRun, runs: [firstRun, finalRun], turn: finalTurn, turns: [firstTurn, finalTurn] });
  assert.equal(report.goal, "Fix startup");
  assert.equal(report.files[0]?.path, "src/app.ts");
  assert.equal(report.outcome.verified, true);
  assert.match(formatExecutionReport(report, "zh-CN"), /状态: 已完成/);
});

test("Chinese report localizes persisted enum values and built-in evidence", () => {
  const item = run();
  item.operations.find((operation) => operation.kind === "verification")!.name = "verify_output";
  item.operations.find((operation) => operation.kind === "verification")!.evidence = "Verification passed: snake.html - size: 18223 bytes - required substrings: 5/5 - forbidden substrings absent: 0/0";
  item.recoveryPoints[0]!.evidence = "assistant turn 4 completed";
  const report = buildExecutionReport({ cwd: "D:/workspace", run: item, turn: turn("sk-abcdefghijklmnopqrstuvwxyz012345") });
  const text = formatExecutionReport(report, "zh-CN");
  assert.match(text, /服务商\/模型/);
  assert.match(text, /已修改 `src\/app\.ts`/);
  assert.match(text, /成功 · 输出验证 · 验证通过：snake\.html - 大小：18223 字节 - 必需内容：5\/5 - 禁止内容未出现：0\/0/);
  assert.match(text, /最近恢复点: 助手第 4 轮已完成/);
  assert.doesNotMatch(text, /Provider\/Model|created|modified|Verification passed|required substrings|assistant turn|details 范围/);
});

test("report export stays inside the workspace and writes atomically", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-report-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const written = await writeExecutionReport(workspace, "reports/latest.md", "report\n");
  assert.equal(await fs.readFile(written, "utf8"), "report\n");
  await writeExecutionReport(workspace, "reports/latest.md", "updated\n");
  assert.equal(await fs.readFile(written, "utf8"), "updated\n");
  await assert.rejects(() => writeExecutionReport(workspace, "../outside.md", "unsafe"), /inside the workspace/);
  if (process.platform !== "win32") {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-report-outside-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.symlink(outside, path.join(workspace, "link"), "dir");
    await assert.rejects(() => writeExecutionReport(workspace, "link/report.md", "unsafe"), /Unsafe report directory/);
  }
});
