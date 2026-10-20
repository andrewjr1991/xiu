import chalk from "chalk";
import type { ActivityLog } from "./activity.js";
import type { AgentEvents } from "./agent.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import type { AgentConfig } from "./config.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { RunningTaskView } from "./task-queue.js";
import { localizeToolDescription, localizeToolProgress, summarizeToolResult } from "./tool-display.js";

/** The parts of the interactive task view the event presenter drives; undefined while idle or in a one-shot run. */
export type TerminalTaskView = Pick<RunningTaskView, "clearDraftPreview" | "setTurn" | "activity" | "setDraftPreview" | "narrate" | "beginTool" | "markVerificationPassed" | "recordImportantAction" | "setPlan" | "recordWorkspaceChange" | "markFinishing" | "setCompletion">;

export interface TerminalAgentEventsContext {
  activities: Pick<ActivityLog, "start" | "progress" | "finish">;
  /** `maxTurns` labels the model turn counter. */
  config: Pick<AgentConfig, "maxTurns">;
  /** Read at call time, because `/language` changes it during the session. */
  language: () => UiLanguage;
  /** The live interactive view, read at call time because each task gets its own. */
  runningTaskView: () => TerminalTaskView | undefined;
  /** Prints a line into the view or to stdout; `emitWrite` streams text without a newline the same way. */
  emitLine: (value?: string) => void;
  emitWrite: (value: string) => void;
  /** Redacts secrets the way the CLI redacts everything it prints. */
  redact: (value: string) => string;
  /** Shows the current phase on the view or the status line; `stopPhase` clears it. */
  startPhase: (value: string) => void;
  stopPhase: () => void;
  /** A workspace change with no interactive view (a one-shot run or an idle session): the CLI prints and keeps it. */
  onDetachedWorkspaceChange: (change: WorkspaceChangeNotice) => void;
}

export interface TerminalAgentEvents {
  events: AgentEvents;
  /** Forgets the verification state at the start of a task, so an earlier task's passed verification never labels the new one. */
  reset: () => void;
}

/** Shortens one-line tool descriptions for the terminal; the full text stays in the activity log. */
export function compactTerminalDescription(value: string, maximum = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  return characters.length > maximum ? `${characters.slice(0, maximum - 3).join("")}...` : normalized;
}

/**
 * The terminal rendering of agent events moved out of cli.ts: model turns, streamed text, tool starts and results,
 * verification, plan updates, workspace changes, provider failover and routing, and the completion line. In an
 * interactive task the lines go into the running task view; a one-shot run streams to stdout. Output is unchanged.
 */
export function createTerminalAgentEvents(ctx: TerminalAgentEventsContext): TerminalAgentEvents {
  const { activities, emitLine, emitWrite, redact, startPhase, stopPhase, onDetachedWorkspaceChange } = ctx;
  const language = (): UiLanguage => ctx.language();
  const view = (): TerminalTaskView | undefined => ctx.runningTaskView();
  const maxTurns = (): number | undefined => ctx.config.maxTurns;
  let activeToolActivity: string | undefined;
  let activeToolDetails: { name: string; description: string; verification: boolean; risk: "read" | "write" | "execute" | "dangerous" } | undefined;
  let verificationReadyForSummary = false;
  const events: AgentEvents = {
    onModelStart: (turn) => {
      view()?.clearDraftPreview();
      view()?.setTurn(turn, maxTurns());
      const modelTurn = localize(language(), `模型第 ${turn}${maxTurns() ? `/${maxTurns()}` : ""} 轮开始`, `Model turn ${turn}${maxTurns() ? `/${maxTurns()}` : ""} started`);
      view()?.activity(modelTurn);
      if (view()) emitLine(chalk.cyan(`● ${modelTurn}`));
      startPhase(verificationReadyForSummary
        ? localize(language(), "验证已通过，正在整理最终结果", "Verification passed; preparing the final result")
        : localize(language(), "思考中", "Thinking"));
    },
    onModelEnd: () => {
      view()?.clearDraftPreview();
      stopPhase();
    },
    onDraftPreview: (text, receivedChars) => {
      view()?.setDraftPreview(redact(text), receivedChars);
      if (!view()) startPhase(localize(language(), `正在接收回复 · ${receivedChars} 字符`, `Receiving response · ${receivedChars} characters`));
    },
    onText: (text) => {
      // Interactive final text is rendered once, after the complete turn
      // has passed normalization and evidence gates. Tool-bound narration
      // is persisted by onAssistantTurn below.
      if (!view()) emitLine(`${text}\n`);
    },
    onTextDelta: (text) => {
      stopPhase();
      // Interactive tasks wait until the complete assistant turn is known
      // before making text persistent. This prevents a streamed draft that
      // is later rejected by a verification/evidence gate from leaking into
      // terminal scrollback. One-shot mode continues to stream directly.
      if (!view()) emitWrite(text);
    },
    onTextStreamEnd: () => {
      if (!view()) emitWrite("\n\n");
    },
    onAssistantTurn: (text, hasToolCalls) => {
      if (!hasToolCalls || !view()) return;
      const narration = view()!.narrate(text);
      if (narration) emitLine(`${chalk.cyan(localize(language(), "思考摘要：", "Reasoning summary: "))}${redact(narration)}\n`);
    },
    onToolStart: (name, description, details) => {
      if (!details.verification) verificationReadyForSummary = false;
      const displayDescription = localizeToolDescription(name, description, language());
      const terminalDescription = compactTerminalDescription(displayDescription);
      activeToolActivity = activities.start("tool", name, displayDescription);
      activeToolDetails = { name, description: terminalDescription, verification: details.verification, risk: details.risk };
      view()?.beginTool(name, terminalDescription, details.changesWorkspace, details.verification);
      emitLine(`${chalk.cyan(`> ${name}`)} ${chalk.dim(terminalDescription)}`);
      startPhase(localize(language(), `正在运行 ${name}`, `Running ${name}`));
    },
    onToolProgress: (name, message) => {
      const displayMessage = localizeToolProgress(message, language());
      if (activeToolActivity) activities.progress(activeToolActivity, displayMessage);
      view()?.activity(`${name}: ${displayMessage}`);
      startPhase(`${name}: ${displayMessage}`);
    },
    onToolEnd: (_name, result, details) => {
      stopPhase();
      const failed = details ? details.result.status !== "success"
        : /^(?:Tool error:|Tool execution denied|Tool execution blocked by crash recovery:|Unknown tool:|Exit code: (?!0\b)|Process timed out|Command timed out|Verification (?:timed out|unavailable|failed)|(?:Process|Command|Verification) cancelled)/i.test(result);
      if (failed) verificationReadyForSummary = false;
      if (activeToolActivity) activities.finish(activeToolActivity, result, failed);
      activeToolActivity = undefined;
      const summary = redact(summarizeToolResult(_name, result, language()) ?? result.replace(/\s+/g, " ").trim());
      view()?.activity(`${_name}: ${failed ? localize(language(), "失败", "failed") : localize(language(), "已完成", "finished")} - ${summary.slice(0, 100)}`);
      // onPlanUpdate already writes the bounded user-facing receipt. Avoid
      // printing the tool result again (historically this was the full plan).
      if (_name !== "update_task_plan") {
        emitLine(`${chalk.dim(summary.length > 240 ? `${summary.slice(0, 240)}... ${localize(language(), "（使用 /details 查看完整输出）", "(/details for full output)")}` : summary)}\n`);
      }
      if (!failed && activeToolDetails) {
        if (details?.verification) {
          verificationReadyForSummary = true;
          view()?.markVerificationPassed();
          view()?.recordImportantAction(localize(language(), `验证通过：${activeToolDetails.description}`, `Verified: ${activeToolDetails.description}`));
        }
        else if (activeToolDetails.risk === "execute" || activeToolDetails.risk === "dangerous") view()?.recordImportantAction(localize(language(), `已执行：${activeToolDetails.description}`, `Ran: ${activeToolDetails.description}`));
      }
      activeToolDetails = undefined;
    },
    onCompletionGate: () => {
      verificationReadyForSummary = false;
      emitLine(chalk.yellow(localize(language(), "完成前需要验证。\n", "Verification required before completion.\n")));
    },
    onCompaction: (message) => startPhase(message),
    onRetry: (message) => startPhase(localizeToolProgress(message, language())),
    onBudgetWarning: (message) => {
      view()?.activity(message);
      emitLine(chalk.yellow(`! ${message}\n`));
    },
    onFailure: (message) => {
      stopPhase();
      view()?.activity(`${localize(language(), "失败", "Failure")}: ${message}`);
      emitLine(chalk.red(`${message}\n`));
    },
    onProviderFailover: (details) => {
      stopPhase();
      const message = localize(language(),
        `Provider 故障转移：${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}（原请求在输出前连续失败）`,
        `Provider failover: ${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel} (the original request failed repeatedly before output)`);
      view()?.activity(message);
      emitLine(`${chalk.yellow(`↪ ${message}`)}\n`);
      if (details.skipped.length) emitLine(`${chalk.dim(details.skipped.map((item) => `${item.providerId}: ${item.reason}`).join(" · "))}\n`);
      startPhase(localize(language(), `已切换到 ${details.toProviderId}，正在继续任务`, `Continuing with ${details.toProviderId}`));
    },
    onProviderFailoverUnavailable: (details) => {
      const skipped = details.skipped.length ? ` ${details.skipped.map((item) => `${item.providerId}: ${item.reason}`).join(" · ")}` : "";
      view()?.activity(localize(language(), `备用 Provider 不可用：${details.reason}`, `No fallback provider available: ${details.reason}`));
      emitLine(`${chalk.dim(localize(language(), `未执行故障转移：${details.reason}${skipped}`, `Failover not performed: ${details.reason}${skipped}`))}\n`);
    },
    onProviderRoute: (details) => {
      stopPhase();
      const message = localize(language(),
        `阶段路由（${details.phase}）：${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`,
        `Stage route (${details.phase}): ${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`);
      view()?.activity(message);
      emitLine(`${chalk.cyan(`↪ ${message}`)}\n${chalk.dim(details.reason)}\n`);
    },
    onProviderRouteSkipped: (details) => {
      const message = localize(language(),
        `阶段路由（${details.phase}）未切换${details.targetProviderId ? `到 ${details.targetProviderId}` : ""}：${details.reason}`,
        `Stage route (${details.phase}) did not switch${details.targetProviderId ? ` to ${details.targetProviderId}` : ""}: ${details.reason}`);
      view()?.activity(message);
      emitLine(`${chalk.dim(message)}\n`);
    },
    onProviderRouteRestore: (details) => {
      view()?.activity(localize(language(), `已恢复用户选择的 Provider：${details.providerId}/${details.model}`, `Restored the user-selected provider: ${details.providerId}/${details.model}`));
    },
    onPlanUpdate: (plan) => {
      view()?.setPlan(plan);
      const completed = plan.steps.filter((step) => step.status === "completed").length;
      const current = plan.steps.find((step) => step.status === "in_progress")?.title
        ?? plan.steps.find((step) => step.status === "pending")?.title
        ?? localize(language(), "等待最终总结", "awaiting final summary");
      emitLine(`${chalk.cyan(localize(language(), `任务计划已更新：${completed}/${plan.steps.length}；当前：${compactTerminalDescription(current, 100)}`, `Task plan updated: ${completed}/${plan.steps.length}; now: ${compactTerminalDescription(current, 100)}`))}\n${chalk.dim(localize(language(), "完整计划可使用 /tasks 查看。", "Use /tasks to view the full plan."))}\n`);
    },
    onWorkspaceChange: (change) => {
      const current = view();
      if (current) {
        current.recordWorkspaceChange(change);
        emitLine(chalk.yellow(localize(language(), `△ 文件变化：${redact(change.description)}`, `△ File change: ${redact(change.description)}`)));
        for (const file of change.files) {
          const label = ({ created: localize(language(), "已创建", "Created"), modified: localize(language(), "已修改", "Modified"), deleted: localize(language(), "已删除", "Deleted") } as const)[file.kind];
          const counts = file.additions !== undefined && file.deletions !== undefined ? ` +${file.additions} -${file.deletions}` : "";
          emitLine(`  ${chalk.green("√")} ${label} ${file.path}${counts}`);
          if (file.hunk) emitLine(chalk.dim(`    ${redact(file.hunk)}`));
          for (const preview of file.preview.slice(0, 8)) {
            const color = preview.startsWith("+") ? chalk.green : preview.startsWith("-") ? chalk.red : chalk.dim;
            emitLine(`    ${color(redact(preview))}`);
          }
        }
        emitLine();
      } else onDetachedWorkspaceChange(change);
    },
    onCheckpoint: (message) => emitLine(chalk.dim(`${message}\n`)),
    onTaskComplete: (summary) => {
      view()?.markFinishing();
      const verification = summary.changed ? (summary.verified ? localize(language(), "已验证", "verified") : localize(language(), "已尝试验证", "verification noted")) : localize(language(), "无文件变化", "no changes");
      const recoveredFailures = (summary.diagnostics?.model.failures ?? 0) + (summary.diagnostics?.tools.failures ?? 0);
      const outcomeLabel = summary.outcome === "completed"
        ? localize(language(), "✓ 已完成", "✓ Done")
        : summary.outcome === "failed"
          ? localize(language(), "! 任务未完成", "! Task incomplete")
          : localize(language(), "! 未验证完成", "! Stopped unverified");
      const recoveryNote = summary.outcome === "completed" && recoveredFailures
        ? localize(language(), `（过程中有 ${recoveredFailures} 次可恢复失败）`, ` (${recoveredFailures} recoverable failure(s) during execution)`)
        : "";
      const message = `${outcomeLabel}${recoveryNote} · ${(summary.durationMs / 1000).toFixed(1)}${localize(language(), " 秒", "s")} · ${summary.turns} ${localize(language(), "轮模型调用", "model turn(s)")} · ${summary.toolCalls} ${localize(language(), "次工具调用", "tool call(s)")} · ${summary.diagnostics ? `${(summary.diagnostics.model.inputTokens + summary.diagnostics.model.outputTokens).toLocaleString()} tokens · ${localize(language(), `失败 ${summary.diagnostics.model.failures + summary.diagnostics.tools.failures} 次`, `${summary.diagnostics.model.failures + summary.diagnostics.tools.failures} failure(s)`)} · ` : ""}${verification}`;
      const finishing = view();
      if (finishing) finishing.setCompletion(message, summary.outcome === "completed");
      else emitLine(summary.outcome === "completed" ? chalk.green(message) : chalk.yellow(message));
    },
  };
  return { events, reset: () => { verificationReadyForSummary = false; } };
}
