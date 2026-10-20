import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckpointManager } from "../../../src/checkpoint.js";
import { listReviewFiles } from "../../../src/runtime/review.js";
import type { XiuRuntime } from "../../../src/runtime/xiu-runtime.js";
import type { WorkspaceAgentHost } from "../../../src/runtime/workspace-agent-host.js";
import { redactSecrets } from "../../../src/secret-redaction.js";
import { loadTaskChangeHistory } from "../../../src/task-change-history.js";
import { getWorkspaceDiff, inspectTaskChanges, type TaskChangeReport, type TaskChangeSnapshot } from "../../../src/task-changes.js";
import type { TaskRunJournal } from "../../../src/task-run.js";
import { reviewOperation } from "./task-history.js";
import type { DesktopChangeView, DesktopReviewSnapshot } from "../shared/protocol.js";

/**
 * Desktop review snapshot: the changes, files, operations, checkpoints,
 * background processes and recovery evidence the renderer's review
 * inspector shows for one workspace. Pure over the host and the
 * controller state it is handed; the controller owns the host, the
 * persistence barrier and the busy checks around it.
 */

/** The parts of a workspace host the review snapshot reads. */
export interface ReviewSnapshotHost {
  runtime: Pick<XiuRuntime, "snapshot">;
  journal: Pick<TaskRunJournal, "currentRun" | "latest" | "interrupted" | "recent">;
  checkpointManager?: Pick<CheckpointManager, "list">;
  background?: WorkspaceAgentHost["background"];
}

/** Controller state read at the same points the inline code read it. */
export interface ReviewSnapshotState {
  baseline: () => TaskChangeSnapshot | undefined;
  completedTaskChanges: () => { taskId: string; report: TaskChangeReport } | undefined;
  active: () => boolean;
}

export interface ReviewSnapshotIo {
  inspectTaskChanges: typeof inspectTaskChanges;
  getWorkspaceDiff: typeof getWorkspaceDiff;
  listReviewFiles: typeof listReviewFiles;
  loadTaskChangeHistory: typeof loadTaskChangeHistory;
  currentBranch: (workspace: string) => Promise<string | undefined>;
}

/** The checked-out branch name, redacted and bounded; undefined off a branch or outside Git. */
export async function currentGitBranch(workspace: string): Promise<string | undefined> {
  return promisify(execFile)("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspace, windowsHide: true, timeout: 2000, maxBuffer: 4096 }).then(({ stdout }) => redactSecrets(stdout.trim()).slice(0, 160)).catch(() => undefined);
}

const defaultIo: ReviewSnapshotIo = { inspectTaskChanges, getWorkspaceDiff, listReviewFiles, loadTaskChangeHistory, currentBranch: currentGitBranch };

export function assertChangeView(changeView: DesktopChangeView): void {
  if (!(["task", "workspace", "staged"] as string[]).includes(changeView)) throw new Error("Invalid change view.");
}

export async function buildReviewSnapshot(workspace: string, changeView: DesktopChangeView, host: ReviewSnapshotHost, state: ReviewSnapshotState, io: ReviewSnapshotIo = defaultIo): Promise<DesktopReviewSnapshot> {
  assertChangeView(changeView);
  const currentTaskId = host.runtime.snapshot().task?.id;
  const completed = state.completedTaskChanges();
  const completedReport = completed && completed.taskId === currentTaskId ? completed.report : undefined;
  const baseline = state.baseline();
  const [changes, files, latest, interrupted, checkpoints] = await Promise.all([
    changeView === "task" && baseline
      ? io.inspectTaskChanges(workspace, baseline)
      : changeView === "task" && completedReport
        ? Promise.resolve(structuredClone(completedReport))
        : io.getWorkspaceDiff(workspace, changeView === "staged" ? "staged" : "workspace"),
    io.listReviewFiles(workspace),
    Promise.resolve(host.journal.currentRun()).then((run) => run ?? host.journal.latest()),
    state.active() ? Promise.resolve(undefined) : host.journal.interrupted(),
    host.checkpointManager?.list() ?? Promise.resolve([]),
  ]);
  const currentBaseline = state.baseline(); // Re-read after the awaits, as the inline code did.
  if (changeView === "task" && !currentBaseline && state.completedTaskChanges()?.taskId !== currentTaskId) changes.warnings = ["no-task-baseline: no in-memory baseline is available; showing current workspace changes.", ...changes.warnings];
  const operations = latest?.operations ?? [];
  const taskReport = changeView === "task" && (currentBaseline || completedReport) ? changes : currentBaseline ? await io.inspectTaskChanges(workspace, currentBaseline) : completedReport;
  const commands = operations.filter((operation) => operation.kind === "tool" && ["run_command", "run_process"].includes(operation.name)).map((operation) => reviewOperation(operation, "command"));
  const validations = operations.filter((operation) => operation.kind === "verification").map((operation) => reviewOperation(operation, "verification"));
  const related = latest ? (await host.journal.recent(500)).filter((run) => run.sessionId === latest.sessionId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-80) : [];
  const changeRounds = await Promise.all(related.map(async (run) => ({ id: run.runId, startedAt: run.startedAt, report: await io.loadTaskChangeHistory(workspace, run.runId) })));
  return {
    changeRounds,
    manualAcceptance: latest?.manualAcceptance ? { eligible: true, ...latest.manualAcceptance } : undefined,
    overview: { workspace, taskId: currentTaskId, taskChanges: taskReport, branch: await io.currentBranch(workspace) },
    generatedAt: new Date().toISOString(), changeView, changes, files,
    artifacts: (taskReport?.changes ?? []).filter((entry) => ["created", "modified"].includes(entry.kind)).map(({ path, kind }) => ({ path, kind })),
    background: host.background?.().map((item) => ({ ...item, command: redactSecrets(item.command).slice(0, 240) })) ?? [],
    tools: operations.filter((operation) => operation.kind === "tool").slice(-80).reverse().map((operation) => reviewOperation(operation, "command")),
    commands: commands.slice(-80).reverse(), validations: validations.slice(-80).reverse(),
    checkpoints: checkpoints.slice(0, 80).map((checkpoint) => structuredClone(checkpoint)),
    ...(latest ? { run: { id: latest.runId, status: latest.status, startedAt: latest.startedAt, updatedAt: latest.updatedAt, ...(latest.finishedAt ? { finishedAt: latest.finishedAt } : {}) } } : {}),
    ...(interrupted ? { recovery: {
      runId: interrupted.runId,
      taskPreview: interrupted.taskPreview,
      status: interrupted.status === "paused" ? "paused" : "recoverable",
      recommendation: interrupted.recommendation,
      unknownOperations: interrupted.interruptedOperations.map((operation) => reviewOperation(operation, operation.kind === "verification" ? "verification" : "command")),
      ...(interrupted.recoveryPoints.at(-1) ? { lastRecoveryPoint: {
        at: interrupted.recoveryPoints.at(-1)!.at,
        kind: interrupted.recoveryPoints.at(-1)!.kind,
        evidence: interrupted.recoveryPoints.at(-1)!.evidence,
      } } : {}),
    } } : {}),
  };
}
