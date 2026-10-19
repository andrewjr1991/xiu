import chalk from "chalk";
import type { Agent, AgentFailureReason } from "../agent.js";
import type { ClipboardAttachmentManager } from "../clipboard.js";
import { formatTaskDiagnostics, formatTaskDiagnosticSummary } from "../diagnostics.js";
import type { DraftStore } from "../draft.js";
import { localize, type UiLanguage } from "../i18n.js";
import { describeFailure } from "../user-facing-errors.js";
import type { ManagedWebSearchAuth } from "../managed-web-search-auth.js";
import type { XiuSettings } from "../settings.js";
import type { RunningTaskView, TaskInputQueue } from "../task-queue.js";
import { printWebSearchStatus } from "./web-commands.js";

export interface RunningTaskCommandContext {
  agent: Agent;
  applyRuntimeLanguage: (selected: UiLanguage, redrawScreen: boolean) => Promise<void>;
  chooseRuntimeLanguage: (command: string) => Promise<UiLanguage | undefined>;
  clipboard: ClipboardAttachmentManager;
  draftStore: DraftStore;
  language: UiLanguage;
  managedWebSearchAuth: () => ManagedWebSearchAuth | undefined;
  printCredentialStatus: () => Promise<void>;
  printDiff: (command: string) => Promise<void>;
  queue: TaskInputQueue;
  settings: XiuSettings;
  view: RunningTaskView;
}

/**
 * The command words the steer> prompt accepts while a task runs, in the order the prompt lists them. `/cancel`,
 * `/exit` and `/quit` end the running-task loop in cli.ts; every other listed word is handled below. Any other
 * known command is unavailable until the task ends (`explainUnhandledSlashInput` says so instead of steering).
 */
export const RUNNING_TASK_COMMAND_WORDS: ReadonlySet<string> = new Set([
  "/cancel", "/exit", "/quit", "/queue", "/clear-queue", "/status", "/diff", "/check", "/diagnostics", "/details", "/paste", "/credentials", "/web", "/language",
]);

/**
 * Handles the slash commands accepted at the steer> prompt while a task runs; returns false when the
 * input is not one of them, so cli.ts can send it as steering or queue it. /cancel and /exit stay in
 * cli.ts because they end the running-task loop.
 */
export async function handleRunningTaskCommand(followUp: string, ctx: RunningTaskCommandContext): Promise<boolean> {
  const { agent, applyRuntimeLanguage, chooseRuntimeLanguage, clipboard, draftStore, language, managedWebSearchAuth, printCredentialStatus, printDiff, queue, settings, view } = ctx;
  if (followUp === "/queue") {
    const pending = queue.list();
    console.log(pending.length
      ? `${chalk.cyan(localize(language, "排队任务", "Queued follow-ups"))}\n${pending.map((item, index) => `${index + 1}. ${item.text.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")}\n`
      : chalk.dim(localize(language, "后续任务队列为空。\n", "The follow-up queue is empty.\n")));
    return true;
  }
  if (followUp.startsWith("/queue ")) {
    if (/^\/(?:check|diff)(?:\s|$)/.test(followUp.slice("/queue ".length).trim())) {
      console.log(chalk.dim(localize(language, "项目检查和差异命令请直接使用，不进入模型任务队列。\n", "Use check and diff commands directly; they are not queued model tasks.\n")));
      return true;
    }
    try {
      const queued = queue.enqueue(followUp.slice("/queue ".length));
      console.log(chalk.green(localize(language, `已安排下一项 ${queued.id}：${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`, `Scheduled next ${queued.id}: ${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`)));
    } catch (error) {
      console.error(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  if (followUp === "/clear-queue") {
    const cleared = queue.clear();
    console.log(chalk.dim(localize(language, `已清空 ${cleared} 个排队任务。\n`, `Cleared ${cleared} queued follow-up(s).\n`)));
    return true;
  }
  if (followUp === "/language" || followUp.startsWith("/language ")) {
    const selected = await chooseRuntimeLanguage(followUp);
    if (!selected) console.log(chalk.dim(localize(language, "已取消语言选择。\n", "Language selection cancelled.\n")));
    else await applyRuntimeLanguage(selected, false);
    return true;
  }
  if (followUp === "/web" || followUp === "/web status") {
    await printWebSearchStatus({ language, managedWebSearchAuth, settings });
    return true;
  }
  if (followUp === "/check" || followUp.startsWith("/check ")) {
    console.log(chalk.dim(localize(language, "请在当前任务结束后执行 /check；检查命令没有作为模型补充发送。\n", "Run /check after the current task finishes; the command was not sent as model steering.\n")));
    return true;
  }
  if (followUp === "/diff" || followUp.startsWith("/diff ")) {
    await printDiff(followUp);
    return true;
  }
  if (followUp.startsWith("/web ")) {
    console.log(chalk.dim(localize(language, "联网搜索配置请在当前任务结束后修改。\n", "Change web search configuration after the current task finishes.\n")));
    return true;
  }
  if (followUp === "/status") {
    const currentStatus = agent.status();
    const turnStatus = currentStatus.maxTurns ? `${currentStatus.turn}/${currentStatus.maxTurns}` : `${currentStatus.turn}`;
    console.log(chalk.dim(localize(language, `运行中：第 ${turnStatus} 轮 | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)} 秒 | ${currentStatus.pendingSteering} 条补充 | ${queue.size} 个排队 | ${currentStatus.stats.modelCalls} 次模型调用 | ${currentStatus.stats.toolCalls} 次工具调用${currentStatus.diagnostics ? `\n诊断：${formatTaskDiagnosticSummary(currentStatus.diagnostics, language)}` : ""}\n`, `Working: turn ${turnStatus} | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)}s | ${currentStatus.pendingSteering} steering | ${queue.size} queued | ${currentStatus.stats.modelCalls} model call(s) | ${currentStatus.stats.toolCalls} tool call(s)${currentStatus.diagnostics ? `\nDiagnostics: ${formatTaskDiagnosticSummary(currentStatus.diagnostics, language)}` : ""}\n`)));
    return true;
  }
  if (followUp === "/diagnostics") {
    console.log(`${formatTaskDiagnostics(agent.status().diagnostics, language)}\n`);
    return true;
  }
  if (followUp === "/credentials" || followUp === "/credentials status") {
    try { await printCredentialStatus(); }
    catch (error) { console.error(chalk.red(`${describeFailure(localize(language, "读取凭证状态失败", "Could not read credential status"), error, language)}\n`)); }
    return true;
  }
  if (followUp === "/credentials probe") {
    console.log(chalk.dim(localize(language, "/credentials probe 请在当前任务结束后执行。\n", "Run /credentials probe after the current task finishes.\n")));
    return true;
  }
  if (followUp.startsWith("/credentials migrate") || followUp.startsWith("/credentials cleanup") || followUp.startsWith("/credentials rollback") || followUp.startsWith("/credentials forget")) {
    console.log(chalk.dim(localize(language, "凭证修改请在当前任务结束后执行。\n", "Change credentials after the current task finishes.\n")));
    return true;
  }
  if (followUp === "/paste") {
    try {
      const pasted = await clipboard.paste();
      await draftStore.save(pasted.insertText);
      await draftStore.flush();
      console.log(chalk.green(`${pasted.notice ?? localize(language, "剪贴板内容已加入输入草稿。", "Clipboard content added to the input draft.")}\n`));
    } catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "剪贴板粘贴失败", "Clipboard paste failed"), error, language)}\n`));
    }
    return true;
  }
  if (followUp === "/details") {
    const visible = view.toggleDetails();
    console.log(chalk.dim(localize(language, `实时视图已切换为${visible ? "详细工具活动" : "任务步骤摘要"}，Ctrl+O 可直接切换。\n`, `Live view switched to ${visible ? "detailed tool activity" : "task step summary"}. Ctrl+O toggles it without submitting the prompt.\n`)));
    return true;
  }
  return false;
}

/** Explains why a task that ended with outcome "failed" did not reach its goal. */
export function incompleteTaskMessage(reason: AgentFailureReason | undefined, language: UiLanguage): string {
  return reason === "verification_failed"
    ? localize(language, "仍有失败或已过期的必要验证，目标尚未完成。", "A required verification is still failed or stale, so the goal is incomplete.")
    : reason === "plan_incomplete"
      ? localize(language, "任务计划仍有未完成或受阻步骤，目标尚未完成。", "The task plan still has unfinished or blocked steps, so the goal is incomplete.")
    : reason === "web_evidence"
      ? localize(language, "联网证据不足或获取失败，目标尚未完成。", "Required web evidence was unavailable or insufficient, so the goal is incomplete.")
      : reason === "model_incomplete"
        ? localize(language, "模型响应未正常结束，目标尚未完成。", "The model response did not finish normally, so the goal is incomplete.")
        : reason === "tool_failed"
          ? localize(language, "最后一批工具操作均失败或被拒绝，目标尚未完成。", "Every operation in the last tool batch failed or was denied, so the goal is incomplete.")
          : localize(language, "任务因运行时错误停止，目标尚未完成。", "The task stopped because of a runtime error, so the goal is incomplete.");
}
