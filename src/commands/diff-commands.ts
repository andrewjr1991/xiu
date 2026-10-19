import { localize, type UiLanguage } from "../i18n.js";
import { redactSecrets } from "../secret-redaction.js";
import { loadTaskChangeHistory } from "../task-change-history.js";
import { formatTaskChanges, type TaskChangeEntry, type TaskChangeReport } from "../task-changes.js";
import type { TaskRunJournal, TaskRunRecord } from "../task-run.js";
import { listRecentRuns, RUN_SELECTOR, selectRun } from "./run-selection.js";

export type DiffCommand =
  | { kind: "view"; view: "task" | "workspace" | "staged" }
  | { kind: "runs" }
  | { kind: "run"; selector: string; file?: string }
  | { kind: "usage" };

/** Where saved change records and the run list come from; narrow so tests can supply their own stores. */
export interface DiffReplaySources {
  cwd: string;
  taskRunJournal: Pick<TaskRunJournal, "latest" | "recent">;
  loadHistory?: (cwd: string, runId: string) => Promise<TaskChangeReport | undefined>;
}

const MAX_FILE_DIFF_OUTPUT = 256_000;

export function diffUsage(language: UiLanguage): string {
  return localize(language,
    "用法：/diff [task|workspace|staged]，/diff runs 列出最近运行，/diff run:<序号|运行 ID 前缀> [文件路径] 回放某次运行保存的改动",
    "Usage: /diff [task|workspace|staged]; /diff runs lists recent runs; /diff run:<number|run-id prefix> [file path] replays the changes saved for that run");
}

/** Parses the text after `/diff`. One optional path may follow a `run:` selector; anything else is a usage error. */
export function parseDiffCommand(command: string): DiffCommand {
  const words = command.slice("/diff".length).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { kind: "view", view: "task" };
  const [first, ...rest] = words;
  const selection = RUN_SELECTOR.exec(first!);
  if (selection) {
    if (rest.length > 1) return { kind: "usage" };
    return { kind: "run", selector: selection[1]!, ...(rest.length ? { file: rest[0]! } : {}) };
  }
  if (rest.length) return { kind: "usage" };
  if (first === "runs") return { kind: "runs" };
  if (first === "task" || first === "workspace" || first === "staged") return { kind: "view", view: first };
  return { kind: "usage" };
}

function listCommands(language: UiLanguage): string {
  return localize(language, "/diff runs", "/diff runs");
}

function runHeading(run: TaskRunRecord, language: UiLanguage): string {
  const preview = redactSecrets(run.taskPreview).replace(/\s+/g, " ").slice(0, 80);
  return localize(language,
    `运行 ${run.runId.slice(0, 8)} · ${run.startedAt.slice(0, 19)} · ${run.status} · ${preview}`,
    `Run ${run.runId.slice(0, 8)} · ${run.startedAt.slice(0, 19)} · ${run.status} · ${preview}`);
}

function noHistory(run: TaskRunRecord, language: UiLanguage): string {
  return localize(language,
    `运行 ${run.runId.slice(0, 8)} 没有保存的改动记录（任务在旧版本运行、被中断于记录之前，或记录已删除）。这里不会用当前工作区的差异冒充它；/diff workspace 查看现状。`,
    `Run ${run.runId.slice(0, 8)} has no saved change record (it ran on an older version, was interrupted before the record was written, or the record was deleted). The current workspace diff is not shown in its place; use /diff workspace for the present state.`);
}

/** `/diff runs`: recent runs, newest first, with the number of changed files each saved record holds. */
export async function formatRunChangeList(sources: DiffReplaySources, language: UiLanguage): Promise<string> {
  const runs = await listRecentRuns(sources.taskRunJournal);
  if (!runs.length) return localize(language, "本工作区还没有任务运行记录。", "This workspace has no task run yet.");
  const load = sources.loadHistory ?? loadTaskChangeHistory;
  const header = localize(language, "序号  运行 ID   开始时间              状态          改动文件  任务", "#     run id    started               status        changed   task");
  const lines: string[] = [];
  for (const [index, run] of runs.entries()) {
    const report = await load(sources.cwd, run.runId).catch(() => undefined);
    const changed = report ? String(report.changes.length) : "-";
    lines.push(`${String(index + 1).padEnd(5)} ${run.runId.slice(0, 8).padEnd(9)} ${run.startedAt.slice(0, 19).padEnd(21)} ${run.status.padEnd(13)} ${changed.padEnd(9)} ${redactSecrets(run.taskPreview).replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return [header, ...lines, localize(language,
    `“-”表示没有保存的改动记录。回放：/diff run:<序号> 或 /diff run:<运行 ID 前缀>（至少 4 位），加文件路径查看该文件的完整差异，例如 /diff run:1、/diff run:${runs[0]!.runId.slice(0, 8)} src/index.ts`,
    `"-" means no saved change record. Replay with /diff run:<number> or /diff run:<run-id prefix> (at least 4 characters); add a file path for that file's complete diff, for example /diff run:1 or /diff run:${runs[0]!.runId.slice(0, 8)} src/index.ts`)].join("\n");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function formatFileChange(entry: TaskChangeEntry, language: UiLanguage): string {
  const zh = language.startsWith("zh");
  const labels = zh ? { created: "新增", modified: "修改", deleted: "删除", "index-only": "暂存状态变化", unknown: "变化待核实" }
    : { created: "created", modified: "modified", deleted: "deleted", "index-only": "index change", unknown: "uncertain change" };
  const lines = [`${labels[entry.kind]} ${JSON.stringify(entry.path)}${entry.preExisting ? (zh ? " [开始前已有改动]" : " [pre-existing]") : ""}${entry.staged ? (zh ? " [已暂存]" : " [staged]") : ""}`];
  if (entry.stats) lines.push(zh ? `统计：+${entry.stats.additions} / -${entry.stats.deletions}${entry.stats.exact ? "" : "（近似）"}` : `Stats: +${entry.stats.additions} / -${entry.stats.deletions}${entry.stats.exact ? "" : " (approximate)"}`);
  if (entry.fullDiff) lines.push(entry.fullDiff);
  else if (entry.preview) {
    lines.push(zh ? "完整差异未保存，以下为摘要：" : "The complete diff was not saved; summary follows:", entry.preview);
  } else {
    lines.push(zh ? "该文件没有可显示的文本差异（二进制、超限或内容未变）。" : "No text diff is available for this file (binary, over the size limit, or content unchanged).");
  }
  if (entry.limitations.length) lines.push(`${zh ? "详情限制" : "Detail limitations"}: ${entry.limitations.join(", ")}`);
  const output = lines.join("\n");
  return output.length > MAX_FILE_DIFF_OUTPUT ? `${output.slice(0, MAX_FILE_DIFF_OUTPUT)}\n${zh ? "显示已截断。" : "Display truncated."}` : output;
}

/**
 * `/diff run:<selector> [file]`: replays the change record saved when that run finished. Without a
 * file the whole report is shown in the `/diff task` layout; with a file, that file's saved complete
 * diff. Throws a localized Error for an unknown selector, a run without a record, or an unknown file.
 */
export async function replayRunChanges(sources: DiffReplaySources, selector: string, file: string | undefined, language: UiLanguage): Promise<string> {
  const run = await selectRun(sources.taskRunJournal, selector, language, listCommands(language));
  if (!run) throw new Error(localize(language, "本工作区还没有任务运行记录。", "This workspace has no task run yet."));
  const report = await (sources.loadHistory ?? loadTaskChangeHistory)(sources.cwd, run.runId);
  if (!report) throw new Error(noHistory(run, language));
  const heading = runHeading(run, language);
  const replayed = localize(language, "以下是任务结束时保存的改动记录，不是当前工作区状态。", "This is the change record saved when the task finished, not the current workspace state.");
  if (file === undefined) return [heading, replayed, formatTaskChanges(report, language)].join("\n");
  const wanted = normalizePath(file);
  const entry = report.changes.find((change) => normalizePath(change.path) === wanted);
  if (!entry) {
    throw new Error(localize(language,
      `运行 ${run.runId.slice(0, 8)} 的改动记录里没有 ${JSON.stringify(file)}；共 ${report.changes.length} 个文件，用 /diff run:${selector} 查看列表。`,
      `The change record of run ${run.runId.slice(0, 8)} has no ${JSON.stringify(file)}; it covers ${report.changes.length} file(s), listed by /diff run:${selector}.`));
  }
  return [heading, replayed, formatFileChange(entry, language)].join("\n");
}
