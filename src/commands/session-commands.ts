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

export interface StartupRecoveryContext {
  config: Pick<AgentConfig, "cwd">;
  language: UiLanguage;
  /** True when a one-shot task is waiting to start: an interrupted run then refuses it instead of asking. */
  oneShot: boolean;
  /** Prints the refusal and records the one-shot / `--json` failure exit state. */
  refuseToStart: (message: string) => void;
  taskRunJournal: Pick<TaskRunJournal, "interrupted" | "abandon">;
  /** The terminal and the session store; the real ones unless a test injects its own. */
  io?: StartupRecoveryIo;
}

export interface StartupRecoveryIo {
  log: (line: string) => void;
  select: (title: string, options: Array<{ label: string; description: string; value: StartupRecoveryChoice }>, language: UiLanguage) => Promise<StartupRecoveryChoice | undefined>;
  loadSession: (cwd: string, sessionId: string) => Promise<RestoredSession>;
}

export type StartupRecoveryChoice = "resume" | "abandon" | "exit";

export type StartupRecoveryOutcome =
  /** No interrupted task: start normally. */
  | { action: "none" }
  /** The journal could not be read, or a one-shot task met an interrupted run: `refuseToStart` was called, leave. */
  | { action: "refused" }
  /** The user confirmed recovery on the terminal: restore `restored`, then run `continuation` before the first prompt. */
  | { action: "resume"; run: InterruptedTaskRun; restored: RestoredSession; continuation: string }
  /** The user abandoned the old task; nothing was replayed. */
  | { action: "abandoned" }
  /** Leave without starting: the user chose Exit, the linked session could not be loaded, or (`failed`) the menu was cancelled because there is no terminal. */
  | { action: "exit"; failed: boolean };

const realStartupRecoveryIo: StartupRecoveryIo = {
  log: (line) => console.log(line),
  select: (title, options, language) => selectTerminalOption(title, options, language),
  loadSession,
};

/**
 * The interrupted-task check every start runs before anything else: an unreadable journal or an interrupted run in
 * front of a one-shot task refuses to start (no new side effects before replay safety is established); an interactive
 * start shows the run and asks whether to resume after confirmation, abandon it, or exit. Only a choice made on a
 * terminal resumes or abandons: a cancelled menu (no terminal) leaves the record alone and counts as a failed start.
 */
export async function resolveStartupRecovery(ctx: StartupRecoveryContext): Promise<StartupRecoveryOutcome> {
  const { config, language, refuseToStart, taskRunJournal } = ctx;
  const io = ctx.io ?? realStartupRecoveryIo;
  let recoverySource: InterruptedTaskRun | undefined;
  try {
    recoverySource = await taskRunJournal.interrupted();
  } catch (error) {
    refuseToStart(localize(language,
      `任务恢复日志无法读取：${error instanceof Error ? error.message : String(error)}。为避免错误重放，Xiu 不会开始新任务。`,
      `The task recovery journal could not be read: ${error instanceof Error ? error.message : String(error)}. Xiu will not start a new task because replay safety cannot be established.`));
    return { action: "refused" };
  }
  if (!recoverySource) return { action: "none" };
  if (ctx.oneShot) {
    refuseToStart(localize(language,
      `检测到异常中断任务 ${recoverySource.runId.slice(0, 8)}。请先在可交互终端里不带任务参数启动 xiu 确认恢复或放弃，或运行 xiu recover abandon ${recoverySource.runId.slice(0, 8)} 明确放弃，然后再运行新任务。`,
      `Interrupted task ${recoverySource.runId.slice(0, 8)} was detected. Start xiu without a task in an interactive terminal to resume or abandon it, or run xiu recover abandon ${recoverySource.runId.slice(0, 8)} to abandon it explicitly, before running a new task.`));
    return { action: "refused" };
  }
  const point = recoverySource.recoveryPoints.at(-1);
  io.log(chalk.yellow(localize(language,
    `检测到异常中断任务：${recoverySource.taskPreview || "（无摘要）"}\n最后恢复点：${point?.evidence ?? "尚无安全恢复点"}\n待核验副作用：${recoverySource.pendingSideEffects.length} 项。Xiu 不会自动重放这些操作。`,
    `Interrupted task detected: ${recoverySource.taskPreview || "(no summary)"}\nLast recovery point: ${point?.evidence ?? "no safe recovery point"}\nSide effects awaiting verification: ${recoverySource.pendingSideEffects.length}. Xiu will not replay them automatically.`)));
  const action = await io.select(localize(language, "如何处理异常中断任务？", "How should the interrupted task be handled?"), [
    { label: localize(language, "确认恢复", "Resume after confirmation"), description: localize(language, "恢复会话，先核验未知副作用，再继续剩余任务", "Restore the session, verify unknown side effects, then continue"), value: "resume" as const },
    { label: localize(language, "放弃旧任务", "Abandon old task"), description: localize(language, "将旧任务标记为已放弃，不执行任何旧操作", "Mark it abandoned without executing any old operation"), value: "abandon" as const },
    { label: localize(language, "退出", "Exit"), description: localize(language, "保持恢复记录，暂不继续", "Keep the recovery record and do nothing"), value: "exit" as const },
  ], language);
  if (action === "resume") {
    let restored: RestoredSession;
    try {
      restored = await io.loadSession(config.cwd, recoverySource.sessionId);
    } catch (error) {
      io.log(chalk.red(localize(language,
        `无法加载关联会话：${error instanceof Error ? error.message : String(error)}。恢复记录已保留。`,
        `The linked session could not be loaded: ${error instanceof Error ? error.message : String(error)}. The recovery record was preserved.`)));
      return { action: "exit", failed: false };
    }
    return { action: "resume", run: recoverySource, restored, continuation: recoveryContinuation(recoverySource, language) };
  }
  if (action === "abandon") {
    await taskRunJournal.abandon(recoverySource.runId);
    io.log(chalk.green(localize(language, "旧任务已标记为放弃；没有重放任何操作。\n", "The old task was abandoned; no operation was replayed.\n")));
    return { action: "abandoned" };
  }
  // "Exit" is the user's own choice (exit code 0); a menu cancelled because there is no terminal means a
  // scripted session ran none of its input, which is a failure.
  return { action: "exit", failed: action === undefined };
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
