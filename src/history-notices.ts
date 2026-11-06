import { localize, type UiLanguage } from "./i18n.js";
import type { TaskRunJournalScan } from "./task-run.js";

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
