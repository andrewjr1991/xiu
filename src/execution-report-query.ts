import { listRecentRuns, selectRun } from "./commands/run-selection.js";
import { originalTaskGoal } from "./execution-report.js";
import { localize, type UiLanguage } from "./i18n.js";
import { SecurityAuditLog } from "./security-audit.js";
import { loadSession, type SessionReplayTurn } from "./session.js";
import { TaskRunJournal, type TaskRunRecord } from "./task-run.js";

/**
 * The one query behind every execution report: the interactive `/report`, the one-shot
 * `xiu report` and the desktop's "报告与诊断" panel all gather a task run, the session turns of
 * its task chain and the workspace's audit facts here, so the same run reads the same on each
 * surface. The module has no terminal or Electron dependency.
 */

/** The journal and audit methods the report needs; narrow so tests and the one-shot command can supply their own stores. */
export interface ExecutionReportSources {
  cwd: string;
  taskRunJournal: Pick<TaskRunJournal, "latest" | "recent">;
  securityAudit: Pick<SecurityAuditLog, "read">;
}

export interface ExecutionReportInputs {
  cwd: string;
  run: TaskRunRecord;
  runs: TaskRunRecord[];
  turn?: SessionReplayTurn;
  turns: SessionReplayTurn[];
  auditRecords: Awaited<ReturnType<SecurityAuditLog["read"]>>["records"];
}

/** The workspace's own stores: its task-run journal (or the live one a host already holds) and the user's security audit log scoped to it. */
export function defaultExecutionReportSources(cwd: string, taskRunJournal: ExecutionReportSources["taskRunJournal"] = new TaskRunJournal(cwd)): ExecutionReportSources {
  return { cwd, taskRunJournal, securityAudit: new SecurityAuditLog(undefined, cwd) };
}

/** Recent runs, newest first, as shown by `/report runs` and `xiu report runs`; index 1 is the latest. */
export async function listReportableRuns(taskRunJournal: Pick<TaskRunJournal, "recent">): Promise<TaskRunRecord[]> {
  return listRecentRuns(taskRunJournal);
}

/**
 * Gathers one task run of the workspace (the latest, or the one `selector` names), the session
 * turns of its task chain and the workspace's audit facts. Returns undefined when the workspace
 * has no run yet; throws when the selector matches nothing or the audit log cannot be read.
 */
export async function collectExecutionReportInputs(sources: ExecutionReportSources, selector?: string, language: UiLanguage = "en-US"): Promise<ExecutionReportInputs | undefined> {
  const { cwd, taskRunJournal, securityAudit } = sources;
  const run = await selectRun(taskRunJournal, selector, language, localize(language, "/report runs 或 xiu report runs", "/report runs or xiu report runs"));
  if (!run) return undefined;
  const restored = await loadSession(cwd, run.sessionId).catch(() => undefined);
  const replay = restored?.replay.filter((item) => item.inputKind !== "system") ?? [];
  const sessionUpdatedAt = restored?.updatedAt ?? run.updatedAt;
  const turn = replay
    .sort((left, right) => {
      const leftDistance = Math.abs(Date.parse(left.diagnostics?.startedAt ?? sessionUpdatedAt) - Date.parse(run.startedAt));
      const rightDistance = Math.abs(Date.parse(right.diagnostics?.startedAt ?? sessionUpdatedAt) - Date.parse(run.startedAt));
      return leftDistance - rightDistance;
    })[0];
  const selectedIndex = turn ? restored?.replay.indexOf(turn) ?? -1 : -1;
  const rootGoal = originalTaskGoal(turn?.task ?? run.taskPreview);
  let rootIndex = selectedIndex;
  if (restored && selectedIndex >= 0) {
    for (let index = selectedIndex; index >= 0; index--) {
      const candidate = restored.replay[index];
      if (candidate?.inputKind !== "system" && originalTaskGoal(candidate?.task ?? "") === rootGoal) rootIndex = index;
      if (candidate?.task === rootGoal) { rootIndex = index; break; }
    }
  }
  const turns = restored && rootIndex >= 0 && selectedIndex >= rootIndex
    ? restored.replay.slice(rootIndex, selectedIndex + 1).filter((item) => item.inputKind !== "system")
    : (turn ? [turn] : []);
  const chainStartedAt = turns[0]?.diagnostics?.startedAt;
  const recentRuns = await taskRunJournal.recent(200);
  const runs = recentRuns
    .filter((item) => item.sessionId === run.sessionId
      && (!chainStartedAt || Date.parse(item.startedAt) >= Date.parse(chainStartedAt) - 5_000)
      && Date.parse(item.startedAt) <= Date.parse(run.finishedAt ?? run.updatedAt))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const audit = await securityAudit.read({ limit: 500, workspaceOnly: true });
  return { cwd, run, runs, turn, turns, auditRecords: audit.records };
}
