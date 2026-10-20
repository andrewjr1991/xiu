import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { CheckpointManager } from "../checkpoint.js";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import { formatLocalTime } from "../local-time.js";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import { listSessionsWithIssues, loadSession, type RestoredSession, type SessionReplayTurn, sessionTitle, unreadableSessionsNote } from "../session.js";
import type { StatusLine } from "../status.js";
import { type InterruptedTaskRun, recoveryContinuation, type TaskRunJournal } from "../task-run.js";
import { askYesNo } from "../terminal-prompts.js";
import { describeFailure } from "../user-facing-errors.js";

export interface SessionCommandContext {
  agent: Pick<Agent, "status" | "compact" | "plan" | "setPlanMode" | "restoreSession" | "setRecoverySource">;
  checkpointManager: Pick<CheckpointManager, "list" | "restore">;
  /** The live runtime config: `cwd` is the workspace whose `.xiu` records are read, `providerId` the provider current when a session is restored. */
  config: Pick<AgentConfig, "cwd" | "providerId">;
  language: UiLanguage;
  /** Runs after a checkpoint restore rewrote files (the CLI invalidates its project index). */
  onCheckpointRestored: () => void;
  /** Runs after `/recover` or `/resume` replaced the agent's session (the CLI drops its per-task baselines). */
  onSessionRestored: (source: "recover" | "resume") => void;
  providerRegistry: Pick<ProviderRegistry, "get">;
  renderReplay: (session: RestoredSession) => void;
  /** Runs the recovery continuation of an interrupted task as a system input. */
  runTaskSequence: (task: string, display: Pick<SessionReplayTurn, "task" | "inputKind">) => Promise<boolean>;
  status: Pick<StatusLine, "stop">;
  /** Switches to the provider a restored session used, without persisting it; false means the switch failed. */
  switchProviderProfile: (profile: ProviderProfile, persist: boolean, preferredModel?: string) => Promise<boolean>;
  taskRunJournal: Pick<TaskRunJournal, "interrupted" | "abandon">;
  /** The final yes/no before files are overwritten; defaults to the terminal prompt and is injectable for tests. */
  confirmRestore?: (prompt: string) => Promise<boolean>;
}

/** Lists the workspace's sessions and lets the user pick one; undefined when there is none or the choice was cancelled. */
export async function chooseSession(workspace: string, language: UiLanguage): Promise<RestoredSession | undefined> {
  const { sessions, unreadable } = await listSessionsWithIssues(workspace);
  const note = unreadableSessionsNote(unreadable, language);
  if (note) console.log(chalk.yellow(note));
  if (!sessions.length) return undefined;
  const selected = await selectTerminalOption(localize(language, "恢复哪个会话？", "Resume which session?"), sessions.map((session) => ({
    label: sessionTitle(session, language),
    description: `${formatLocalTime(session.updatedAt)}  ${session.model ?? localize(language, "未知模型", "unknown model")}  ${session.id}`,
    value: session.id,
  })), language);
  return selected ? await loadSession(workspace, selected) : undefined;
}

/**
 * Conversation, plan, checkpoint and recovery slash commands moved out of the interactive loop in cli.ts
 * (`/history`, `/history sessions`, `/compact`, `/plan`, `/tasks`, `/plan on|off`, `/checkpoints`, `/rewind`,
 * `/recover`, `/resume`); returns false when `task` is not one of them. Output and prompts are unchanged: without
 * a terminal every selector counts as cancelled, so nothing is restored, abandoned or replayed.
 */
export async function handleSessionCommand(task: string, ctx: SessionCommandContext): Promise<boolean> {
  const { agent, checkpointManager, config, language, onCheckpointRestored, onSessionRestored, providerRegistry, renderReplay, runTaskSequence, status, switchProviderProfile, taskRunJournal } = ctx;
  const confirmRestore = ctx.confirmRestore ?? askYesNo;
  if (task === "/recover") {
    let interrupted: InterruptedTaskRun | undefined;
    try { interrupted = await taskRunJournal.interrupted(); }
    catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "任务恢复日志无法读取", "Could not read the task recovery journal"), error, language)}\n`));
      return true;
    }
    if (!interrupted) {
      console.log(chalk.dim(localize(language, "当前工作区没有异常中断任务。\n", "There is no interrupted task in this workspace.\n")));
      return true;
    }
    const action = await selectTerminalOption(localize(language, "如何处理异常中断任务？", "How should the interrupted task be handled?"), [
      { label: localize(language, "确认恢复", "Resume after confirmation"), description: localize(language, "先核验未知副作用，再继续", "Verify unknown side effects before continuing"), value: "resume" as const },
      { label: localize(language, "放弃旧任务", "Abandon old task"), description: localize(language, "不重放任何操作", "Do not replay any operation"), value: "abandon" as const },
    ], language);
    if (action === "abandon") {
      await taskRunJournal.abandon(interrupted.runId);
      console.log(chalk.green(localize(language, "旧任务已放弃；没有重放任何操作。\n", "The old task was abandoned; no operation was replayed.\n")));
      return true;
    }
    if (action !== "resume") return true;
    let selected: RestoredSession;
    try { selected = await loadSession(config.cwd, interrupted.sessionId); }
    catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "无法加载关联会话", "Could not load the linked session"), error, language)}\n`));
      return true;
    }
    if (selected.providerId && selected.providerId !== config.providerId) {
      const selectedProfile = providerRegistry.get(selected.providerId);
      if (!selectedProfile || !(await switchProviderProfile(selectedProfile, false, selected.model))) {
        console.log(chalk.yellow(localize(language, "无法恢复该会话使用的 Provider，恢复记录保持不变。\n", "Could not restore the session provider; the recovery record was preserved.\n")));
        return true;
      }
    }
    agent.restoreSession(selected);
    onSessionRestored("recover");
    agent.setRecoverySource(interrupted);
    renderReplay(selected);
    await runTaskSequence(recoveryContinuation(interrupted, language), {
      task: localize(language, `恢复中断任务：${interrupted.taskPreview}`, `Recover interrupted task: ${interrupted.taskPreview}`),
      inputKind: "system",
    });
    return true;
  }
  if (task === "/resume") {
    const selected = await chooseSession(config.cwd, language);
    if (!selected) console.log(chalk.dim(localize(language, "未选择会话。\n", "No session selected.\n")));
    else {
      if (selected.providerId && selected.providerId !== config.providerId) {
        const selectedProfile = providerRegistry.get(selected.providerId);
        if (!selectedProfile || !(await switchProviderProfile(selectedProfile, false, selected.model))) {
          console.log(chalk.yellow(localize(language, "无法恢复该会话使用的 Provider，会话未切换。\n", "Could not restore the session provider; the session was not changed.\n")));
          return true;
        }
      }
      agent.restoreSession(selected);
      onSessionRestored("resume");
      renderReplay(selected);
    }
    return true;
  }
  if (task === "/history" || task === "/history current") {
    const currentSessionId = agent.status().sessionId;
    if (!currentSessionId) console.log(chalk.dim(localize(language, "没有对话历史。\n", "No conversation history.\n")));
    else renderReplay(await loadSession(config.cwd, currentSessionId));
    return true;
  }
  if (task === "/history sessions") {
    const { sessions, unreadable } = await listSessionsWithIssues(config.cwd);
    const note = unreadableSessionsNote(unreadable, language);
    console.log([
      sessions.length ? sessions.map((session) => `${session.id}  ${formatLocalTime(session.updatedAt)}  ${sessionTitle(session, language)}`).join("\n") : localize(language, "没有已保存会话。", "No saved sessions."),
      ...(note ? [chalk.yellow(note)] : []),
    ].join("\n") + "\n");
    return true;
  }
  if (task === "/compact" || task.startsWith("/compact ")) {
    const focus = task.slice("/compact".length).trim();
    try { console.log(chalk.green(`${await agent.compact(focus || undefined)}\n`)); }
    catch (error) { status.stop(); console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`)); }
    finally { status.stop(); }
    return true;
  }
  if (task === "/plan" || task === "/tasks") {
    console.log(`${agent.plan()}\n`);
    return true;
  }
  if (task === "/plan on" || task === "/plan off") {
    const enabled = task.endsWith("on");
    await agent.setPlanMode(enabled);
    console.log(chalk.green(localize(language, `规划模式已${enabled ? "启用（只读）" : "关闭"}。\n`, `Plan mode ${enabled ? "enabled (read-only)" : "disabled"}.\n`)));
    return true;
  }
  if (task === "/checkpoints") {
    const checkpoints = await checkpointManager.list();
    console.log(checkpoints.length
      ? `${checkpoints.map((checkpoint) => `${checkpoint.id}  ${checkpoint.tool}  ${checkpoint.files.map((file) => file.path).join(", ")}`).join("\n")}\n`
      : localize(language, "当前会话没有恢复点。\n", "No checkpoints in the current session.\n"));
    return true;
  }
  if (task === "/rewind") {
    const checkpoints = await checkpointManager.list();
    if (!checkpoints.length) {
      console.log(chalk.dim(localize(language, "当前会话没有恢复点。\n", "No checkpoints in the current session.\n")));
      return true;
    }
    const selected = await selectTerminalOption(localize(language, "恢复哪个检查点？", "Restore which checkpoint?"), checkpoints.map((checkpoint) => ({
      label: checkpoint.description,
      description: `${formatLocalTime(checkpoint.createdAt)}  ${checkpoint.files.map((file) => file.path).join(", ")}`,
      value: checkpoint.id,
    })), language);
    if (!selected) {
      console.log(chalk.dim(localize(language, "已取消恢复。\n", "Restore cancelled.\n")));
      return true;
    }
    if (!(await confirmRestore(chalk.bgRed.white.bold(" RESTORE ") + ` Restore files from checkpoint ${selected}? [y/N] `))) {
      console.log(chalk.dim(localize(language, "已取消恢复。\n", "Restore cancelled.\n")));
      return true;
    }
    const restoredCheckpoint = await checkpointManager.restore(selected);
    onCheckpointRestored();
    console.log(chalk.green(localize(language, `已从 ${restoredCheckpoint.id} 恢复：${restoredCheckpoint.files.map((file) => file.path).join(", ")}。\n`, `Restored ${restoredCheckpoint.files.map((file) => file.path).join(", ")} from ${restoredCheckpoint.id}.\n`)));
    return true;
  }
  return false;
}
