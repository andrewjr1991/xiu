import { localize, type UiLanguage } from "../i18n.js";
import { terminalDisplayWidth } from "../interactive-ui.js";
import { formatLocalTime } from "../local-time.js";
import { taskRunStatusLabel } from "../status-labels.js";
import type { TaskRunJournal, TaskRunJournalScan, TaskRunRecord } from "../task-run.js";

/** Up to this many recent runs are listed and selectable by index or run-id prefix. */
export const RUN_LIST_LIMIT = 50;

/** Fewer characters than this are too short to identify a run by its id. */
export const RUN_ID_PREFIX_MINIMUM = 4;

export const RUN_SELECTOR = /^run:(.+)$/i;

/** The journal methods the run lists need; `scan` is optional so a narrow test store still works. */
export type RunListJournal = Pick<TaskRunJournal, "recent"> & Partial<Pick<TaskRunJournal, "scan">>;

/** Recent runs, newest first, as listed by `/report runs`, `xiu report runs` and `/diff runs`; index 1 is the latest. */
export async function listRecentRuns(taskRunJournal: RunListJournal): Promise<TaskRunRecord[]> {
  return taskRunJournal.recent(RUN_LIST_LIMIT);
}

/** `listRecentRuns` plus the journal records that could not be read, so a list can say what it leaves out. */
export async function listRecentRunsWithIssues(taskRunJournal: RunListJournal): Promise<{ runs: TaskRunRecord[]; unreadable: TaskRunJournalScan["unreadable"] }> {
  if (!taskRunJournal.scan) return { runs: await listRecentRuns(taskRunJournal), unreadable: [] };
  const scan = await taskRunJournal.scan(RUN_LIST_LIMIT);
  return { runs: scan.records, unreadable: scan.unreadable };
}

/** Pads by display width, so a Chinese label fills the same columns as an English one. */
function padColumn(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - terminalDisplayWidth(value)));
}

/**
 * The columns every run list starts with: 1-based index, the first 8 characters of the run id, the
 * start time as local `YYYY-MM-DD HH:mm:ss`, and the status in the user's language. Column widths
 * match the headers of `/report runs` and `/diff runs`; the caller appends its own columns.
 */
export function formatRunListColumns(run: TaskRunRecord, index: number, language: UiLanguage): string {
  return `${String(index + 1).padEnd(5)} ${run.runId.slice(0, 8).padEnd(9)} ${padColumn(formatLocalTime(run.startedAt), 21)} ${padColumn(taskRunStatusLabel(run.status, language), 13)}`;
}

/** One line naming how many journal records a list leaves out and why; undefined when none. */
export function unreadableRunsNote(unreadable: TaskRunJournalScan["unreadable"], language: UiLanguage): string | undefined {
  if (!unreadable.length) return undefined;
  const counts = new Map<string, number>();
  for (const item of unreadable) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const reasons = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} ×${count}`).join(localize(language, "、", ", "));
  return localize(language,
    `另有 ${unreadable.length} 条运行记录无法读取（${reasons}），未列出；它们不影响这里的其他运行，中断任务的检查仍按原规则进行。`,
    `${unreadable.length} more run record(s) could not be read (${reasons}) and are not listed; the runs shown are unaffected, and the interrupted-task check is unchanged.`);
}

/**
 * Resolves `run:<selector>` against the recent list: a 1-based index, or a run-id prefix of at
 * least four characters that matches exactly one run. `listCommands` names the commands that
 * print the list, so the error tells the user where to look.
 */
export async function selectRun(
  taskRunJournal: Pick<TaskRunJournal, "latest"> & RunListJournal,
  selector: string | undefined,
  language: UiLanguage,
  listCommands: string,
): Promise<TaskRunRecord | undefined> {
  if (selector === undefined) return taskRunJournal.latest();
  const runs = await listRecentRuns(taskRunJournal);
  const matches = selector.length >= RUN_ID_PREFIX_MINIMUM ? runs.filter((run) => run.runId.toLowerCase().startsWith(selector.toLowerCase())) : [];
  if (/^\d+$/.test(selector)) {
    // Run ids are hex, so a prefix such as 69049616 can be all digits. A digits-only selector that
    // identifies exactly one run by prefix is that run; otherwise it is the 1-based list index.
    if (matches.length === 1) return matches[0];
    const index = Number(selector);
    const run = index >= 1 ? runs[index - 1] : undefined;
    if (!run) throw new Error(localize(language, `没有第 ${selector} 个运行；最近共 ${runs.length} 个，用 ${listCommands} 查看。`, `There is no run #${selector}; ${runs.length} recent run(s) exist. List them with ${listCommands}.`));
    return run;
  }
  if (selector.length < RUN_ID_PREFIX_MINIMUM) throw new Error(localize(language, `运行 ID 前缀至少 ${RUN_ID_PREFIX_MINIMUM} 位。`, `A run-id prefix needs at least ${RUN_ID_PREFIX_MINIMUM} characters.`));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(localize(language, `最近 ${runs.length} 个运行里没有以 ${selector} 开头的运行 ID。`, `No run id among the ${runs.length} recent run(s) starts with ${selector}.`));
  throw new Error(localize(language, `运行 ID 前缀 ${selector} 匹配 ${matches.length} 个运行，请再多写几位。`, `The run-id prefix ${selector} matches ${matches.length} runs; add more characters.`));
}
