import { localize, type UiLanguage } from "../i18n.js";
import type { TaskRunJournal, TaskRunRecord } from "../task-run.js";

/** Up to this many recent runs are listed and selectable by index or run-id prefix. */
export const RUN_LIST_LIMIT = 50;

/** Fewer characters than this are too short to identify a run by its id. */
export const RUN_ID_PREFIX_MINIMUM = 4;

export const RUN_SELECTOR = /^run:(.+)$/i;

/** Recent runs, newest first, as listed by `/report runs`, `xiu report runs` and `/diff runs`; index 1 is the latest. */
export async function listRecentRuns(taskRunJournal: Pick<TaskRunJournal, "recent">): Promise<TaskRunRecord[]> {
  return taskRunJournal.recent(RUN_LIST_LIMIT);
}

/**
 * Resolves `run:<selector>` against the recent list: a 1-based index, or a run-id prefix of at
 * least four characters that matches exactly one run. `listCommands` names the commands that
 * print the list, so the error tells the user where to look.
 */
export async function selectRun(
  taskRunJournal: Pick<TaskRunJournal, "latest" | "recent">,
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
