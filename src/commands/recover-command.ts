import { localize, type UiLanguage } from "../i18n.js";
import { type InterruptedTaskRun, TaskRunJournal } from "../task-run.js";
import { isWorkspaceTrusted } from "../trust.js";
import { formatLocalTime } from "../local-time.js";

/**
 * `xiu recover [status]` and `xiu recover abandon <run id>`: the non-interactive half of crash
 * recovery, for scripts and CI where the resume/abandon menu cannot be answered.
 *
 * `status` describes the interrupted run of the workspace (or says there is none) and exits 2
 * when one exists, so a script can branch on it. `abandon` marks that run abandoned without
 * replaying anything; the run id (a prefix of at least four characters) is the explicit
 * confirmation, and a mismatch changes nothing. Resuming is never offered here: it needs the
 * interactive confirmation and the verification notes the terminal flow gives the model.
 */

export interface RecoverCliOptions {
  cwd: string;
  language: UiLanguage;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  journal?: Pick<TaskRunJournal, "interrupted" | "abandon">;
  isTrusted?: (cwd: string) => Promise<boolean>;
}

/** Exit codes of `xiu recover`; `status` uses 2 for "an interrupted run exists" so scripts can branch. */
export const RECOVER_EXIT_CODES = { clean: 0, failed: 1, interrupted: 2 } as const;

const RUN_ID_PREFIX = /^[0-9a-f-]{4,36}$/i;
const MAX_LISTED_SIDE_EFFECTS = 10;

function recoverUsage(language: UiLanguage): string {
  return localize(language,
    "用法：xiu recover [status] 查看当前工作区的异常中断任务；xiu recover abandon <运行 ID 或至少 4 位前缀> 明确放弃它（不重放任何操作）。\n恢复任务需要在可交互终端里不带任务参数运行 xiu。",
    "Usage: xiu recover [status] shows the interrupted task of this workspace; xiu recover abandon <run id or a prefix of at least 4 characters> abandons it explicitly (nothing is replayed).\nResuming requires running xiu without a task in an interactive terminal.");
}

export function describeInterruptedRun(run: InterruptedTaskRun, language: UiLanguage): string {
  const id = run.runId.slice(0, 8);
  const point = run.recoveryPoints.at(-1);
  const lines = [
    localize(language,
      `异常中断任务 ${id}（${run.status === "paused" ? "中断时已暂停" : "中断时正在运行"}）`,
      `Interrupted task ${id} (${run.status === "paused" ? "paused when interrupted" : "running when interrupted"})`),
    localize(language, `任务：${run.taskPreview || "（无摘要）"}`, `Task: ${run.taskPreview || "(no summary)"}`),
    localize(language, `开始于：${formatLocalTime(run.startedAt)}`, `Started: ${formatLocalTime(run.startedAt)}`),
    localize(language, `最后恢复点：${point?.evidence ?? "尚无安全恢复点"}`, `Last recovery point: ${point?.evidence ?? "no safe recovery point"}`),
    localize(language,
      `中断时未完成的操作：${run.interruptedOperations.length} 项；待核验副作用：${run.pendingSideEffects.length} 项。Xiu 不会自动重放这些操作。`,
      `Operations interrupted: ${run.interruptedOperations.length}; side effects awaiting verification: ${run.pendingSideEffects.length}. Xiu will not replay them automatically.`),
  ];
  for (const operation of run.pendingSideEffects.slice(0, MAX_LISTED_SIDE_EFFECTS)) {
    lines.push(`  - ${operation.kind}:${operation.name} (${operation.sideEffect}, ${operation.replay})`);
  }
  if (run.pendingSideEffects.length > MAX_LISTED_SIDE_EFFECTS) {
    lines.push(localize(language, `  … 另有 ${run.pendingSideEffects.length - MAX_LISTED_SIDE_EFFECTS} 项`, `  … ${run.pendingSideEffects.length - MAX_LISTED_SIDE_EFFECTS} more`));
  }
  lines.push(localize(language,
    `放弃：xiu recover abandon ${id}（标记为已放弃，不重放任何操作）。恢复：在可交互终端里不带任务参数运行 xiu，确认后继续。`,
    `Abandon: xiu recover abandon ${id} (marks it abandoned; nothing is replayed). Resume: run xiu without a task in an interactive terminal and confirm there.`));
  return lines.join("\n");
}

/** Returns the process exit code: 0 no interrupted run / abandoned, 2 an interrupted run exists (`status`), 1 usage error, untrusted workspace, unreadable journal or mismatch. */
export async function runRecoverCommand(args: readonly string[], options: RecoverCliOptions): Promise<number> {
  const { cwd, language } = options;
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  const [action = "status", target, ...rest] = args;
  const word = action.toLowerCase();
  const usageError = rest.length > 0
    || (word === "status" && target !== undefined)
    || (word === "abandon" && (target === undefined || !RUN_ID_PREFIX.test(target)))
    || (word !== "status" && word !== "abandon");
  if (usageError) { stderr(recoverUsage(language)); return RECOVER_EXIT_CODES.failed; }
  const trusted = await (options.isTrusted ?? isWorkspaceTrusted)(cwd);
  if (!trusted) {
    stderr(localize(language,
      "工作区尚未信任，不能读取它的任务记录。请先交互运行一次 xiu 并确认信任，或在你掌控的检出目录上显式加 --trust-workspace。",
      "This workspace is not trusted yet, so its task records are not read. Run xiu interactively once and confirm trust, or pass --trust-workspace explicitly on a checkout you control."));
    return RECOVER_EXIT_CODES.failed;
  }
  const journal = options.journal ?? new TaskRunJournal(cwd);
  let interrupted: InterruptedTaskRun | undefined;
  try { interrupted = await journal.interrupted(); }
  catch (error) {
    stderr(localize(language,
      `任务恢复日志无法读取：${error instanceof Error ? error.message : String(error)}。没有改动任何记录。`,
      `The task recovery journal could not be read: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`));
    return RECOVER_EXIT_CODES.failed;
  }
  if (!interrupted) {
    if (word === "abandon") {
      stderr(localize(language, "当前工作区没有异常中断任务，没有可放弃的记录。", "There is no interrupted task in this workspace, so there is nothing to abandon."));
      return RECOVER_EXIT_CODES.failed;
    }
    stdout(localize(language, "当前工作区没有异常中断任务。", "There is no interrupted task in this workspace."));
    return RECOVER_EXIT_CODES.clean;
  }
  if (word === "status") {
    stdout(describeInterruptedRun(interrupted, language));
    return RECOVER_EXIT_CODES.interrupted;
  }
  const id = interrupted.runId.slice(0, 8);
  if (!interrupted.runId.toLowerCase().startsWith(target!.toLowerCase())) {
    stderr(localize(language,
      `给出的运行 ID 与当前异常中断任务 ${id} 不匹配，没有改动任何记录。先运行 xiu recover 查看它。`,
      `The given run id does not match the interrupted task ${id}; nothing was changed. Run xiu recover to see it first.`));
    return RECOVER_EXIT_CODES.failed;
  }
  try { await journal.abandon(interrupted.runId); }
  catch (error) {
    stderr(localize(language,
      `无法写入放弃记录：${error instanceof Error ? error.message : String(error)}。`,
      `Could not record the abandonment: ${error instanceof Error ? error.message : String(error)}.`));
    return RECOVER_EXIT_CODES.failed;
  }
  stdout(localize(language,
    `异常中断任务 ${id} 已标记为放弃；没有重放任何操作。现在可以运行新任务。`,
    `Interrupted task ${id} was abandoned; no operation was replayed. New tasks can run now.`));
  return RECOVER_EXIT_CODES.clean;
}
