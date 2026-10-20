import chalk from "chalk";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { redactSecrets } from "../secret-redaction.js";
import { loadTaskChangeHistory } from "../task-change-history.js";
import { formatTaskChanges, getWorkspaceDiff, inspectTaskChanges, type TaskChangeEntry, type TaskChangeReport, type TaskChangeSnapshot } from "../task-changes.js";
import type { TaskRunJournal, TaskRunRecord } from "../task-run.js";
import { describeFailure } from "../user-facing-errors.js";
import { formatRunListColumns, listRecentRunsWithIssues, RUN_SELECTOR, type RunListJournal, selectRun, unreadableRunsNote } from "./run-selection.js";

export type DiffCommand =
  | { kind: "view"; view: "task" | "workspace" | "staged" }
  | { kind: "runs" }
  | { kind: "run"; selector: string; file?: string }
  | { kind: "usage" };

/** Where saved change records and the run list come from; narrow so tests can supply their own stores. */
export interface DiffReplaySources {
  cwd: string;
  taskRunJournal: Pick<TaskRunJournal, "latest"> & RunListJournal;
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

/** Why a saved change record could not be read: the system error code when there is one, else the loader's own message; never a path. */
function unreadableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code) return code;
  return redactSecrets(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
}

function unreadableHistory(run: TaskRunRecord, error: unknown, language: UiLanguage): string {
  return localize(language,
    `运行 ${run.runId.slice(0, 8)} 的改动记录无法读取（${unreadableReason(error)}）：记录存在但已损坏、被改动或超出限制。这里不会用当前工作区的差异冒充它；/diff workspace 查看现状。`,
    `The change record of run ${run.runId.slice(0, 8)} cannot be read (${unreadableReason(error)}): the record exists but is corrupt, altered or over its limits. The current workspace diff is not shown in its place; use /diff workspace for the present state.`);
}

function noHistory(run: TaskRunRecord, language: UiLanguage): string {
  return localize(language,
    `运行 ${run.runId.slice(0, 8)} 没有保存的改动记录（任务在旧版本运行、被中断于记录之前，或记录已删除）。这里不会用当前工作区的差异冒充它；/diff workspace 查看现状。`,
    `Run ${run.runId.slice(0, 8)} has no saved change record (it ran on an older version, was interrupted before the record was written, or the record was deleted). The current workspace diff is not shown in its place; use /diff workspace for the present state.`);
}

/** `/diff runs`: recent runs, newest first, with the number of changed files each saved record holds. */
export async function formatRunChangeList(sources: DiffReplaySources, language: UiLanguage): Promise<string> {
  const { runs, unreadable } = await listRecentRunsWithIssues(sources.taskRunJournal);
  const note = unreadableRunsNote(unreadable, language);
  if (!runs.length) return [localize(language, "本工作区还没有任务运行记录。", "This workspace has no task run yet."), ...(note ? [note] : [])].join("\n");
  const load = sources.loadHistory ?? loadTaskChangeHistory;
  const header = localize(language, "序号  运行 ID   开始时间              状态          改动文件  任务", "#     run id    started               status        changed   task");
  const lines: string[] = [];
  for (const [index, run] of runs.entries()) {
    const changed = await load(sources.cwd, run.runId).then((report) => (report ? String(report.changes.length) : "-"), () => "!");
    lines.push(`${formatRunListColumns(run, index, language)} ${changed.padEnd(9)} ${redactSecrets(run.taskPreview).replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return [header, ...lines, localize(language,
    `“-”表示没有保存的改动记录，“!”表示记录存在但无法读取（损坏、被改动或超出限制）。回放：/diff run:<序号> 或 /diff run:<运行 ID 前缀>（至少 4 位），加文件路径查看该文件的完整差异，例如 /diff run:1、/diff run:${runs[0]!.runId.slice(0, 8)} src/index.ts`,
    `"-" means no saved change record, "!" a record that exists but cannot be read (corrupt, altered or over its limits). Replay with /diff run:<number> or /diff run:<run-id prefix> (at least 4 characters); add a file path for that file's complete diff, for example /diff run:1 or /diff run:${runs[0]!.runId.slice(0, 8)} src/index.ts`),
  ...(note ? [note] : [])].join("\n");
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
 * diff. Throws a localized Error for an unknown selector, a run without a record, a record that cannot
 * be read (corrupt, altered, over its limits; the reason is named, never a path), or an unknown file.
 */
export async function replayRunChanges(sources: DiffReplaySources, selector: string, file: string | undefined, language: UiLanguage): Promise<string> {
  const run = await selectRun(sources.taskRunJournal, selector, language, listCommands(language));
  if (!run) throw new Error(localize(language, "本工作区还没有任务运行记录。", "This workspace has no task run yet."));
  let report: TaskChangeReport | undefined;
  try { report = await (sources.loadHistory ?? loadTaskChangeHistory)(sources.cwd, run.runId); }
  catch (error) { throw new Error(unreadableHistory(run, error, language)); }
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

export interface DiffCommandContext {
  /** `cwd` is the workspace inspected; `apiKey` is redacted from every diff and error line. */
  config: Pick<AgentConfig, "cwd" | "apiKey">;
  language: UiLanguage;
  /** The file state recorded when this session's latest task started; undefined before the first task (a restored session never rebuilds it). */
  latestTaskBaseline: () => TaskChangeSnapshot | undefined;
  /** Redacts a line the way the CLI redacts everything it prints. */
  redact: (value: string) => string;
  taskRunJournal: DiffReplaySources["taskRunJournal"];
}

/**
 * The `/diff` command moved out of the interactive loop in cli.ts (`/diff`, `/diff task|workspace|staged`, `/diff runs`,
 * `/diff run:<selector> [file]`); returns false when `task` is not it. Output is unchanged: the task view needs this
 * session's baseline, the run views read only saved change records, and a usage error prints the usage line.
 */
export async function handleDiffCommand(task: string, ctx: DiffCommandContext): Promise<boolean> {
  if (task !== "/diff" && !task.startsWith("/diff ")) return false;
  const { config, language, redact, taskRunJournal } = ctx;
  const parsed = parseDiffCommand(task);
  if (parsed.kind === "usage") {
    console.log(chalk.yellow(`${diffUsage(language)}\n`));
    return true;
  }
  if (parsed.kind === "runs" || parsed.kind === "run") {
    try {
      const sources = { cwd: config.cwd, taskRunJournal };
      const output = parsed.kind === "runs" ? await formatRunChangeList(sources, language) : await replayRunChanges(sources, parsed.selector, parsed.file, language);
      console.log(`${redact(output)}\n`);
    } catch (error) {
      console.error(chalk.red(redact(`${describeFailure(localize(language, "读取改动记录失败", "Could not read the change record"), error, language)}\n`)));
    }
    return true;
  }
  const baseline = ctx.latestTaskBaseline();
  if (parsed.view === "task" && !baseline) {
    console.log(chalk.dim(localize(language,
      "本次会话还没有任务起点快照。恢复的历史会话不会重建旧快照；使用 /diff runs 回放以前运行保存的改动，或用 /diff workspace、/diff staged 查看当前状态。\n",
      "No task baseline is available in this session. Historical baselines are not reconstructed on resume; use /diff runs to replay the changes saved for earlier runs, or /diff workspace and /diff staged for the current state.\n")));
    return true;
  }
  try {
    const diffOptions = { sensitiveValues: config.apiKey ? [config.apiKey] : [] };
    const report = parsed.view === "task"
      ? await inspectTaskChanges(config.cwd, baseline!, diffOptions)
      : await getWorkspaceDiff(config.cwd, parsed.view, diffOptions);
    console.log(`${redact(formatTaskChanges(report, language))}\n`);
  } catch (error) {
    console.error(chalk.red(redact(`${describeFailure(localize(language, "读取改动失败", "Could not inspect changes"), error, language)}\n`)));
  }
  return true;
}
