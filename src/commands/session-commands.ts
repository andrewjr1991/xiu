import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { CheckpointManager } from "../checkpoint.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import { formatLocalTime } from "../local-time.js";
import { listSessionsWithIssues, loadSession, type RestoredSession, sessionTitle, unreadableSessionsNote } from "../session.js";
import type { StatusLine } from "../status.js";
import { askYesNo } from "../terminal-prompts.js";

export interface SessionCommandContext {
  agent: Pick<Agent, "status" | "compact" | "plan" | "setPlanMode">;
  checkpointManager: Pick<CheckpointManager, "list" | "restore">;
  /** Workspace whose `.xiu/sessions` the history commands read. */
  cwd: string;
  language: UiLanguage;
  /** Runs after a checkpoint restore rewrote files (the CLI invalidates its project index). */
  onCheckpointRestored: () => void;
  renderReplay: (session: RestoredSession) => void;
  status: Pick<StatusLine, "stop">;
  /** The final yes/no before files are overwritten; defaults to the terminal prompt and is injectable for tests. */
  confirmRestore?: (prompt: string) => Promise<boolean>;
}

/**
 * Conversation, plan and checkpoint slash commands moved out of the interactive loop in cli.ts
 * (`/history`, `/history sessions`, `/compact`, `/plan`, `/tasks`, `/plan on|off`, `/checkpoints`, `/rewind`);
 * returns false when `task` is not one of them. Output and prompts are unchanged.
 */
export async function handleSessionCommand(task: string, ctx: SessionCommandContext): Promise<boolean> {
  const { agent, checkpointManager, cwd, language, onCheckpointRestored, renderReplay, status } = ctx;
  const confirmRestore = ctx.confirmRestore ?? askYesNo;
  if (task === "/history" || task === "/history current") {
    const currentSessionId = agent.status().sessionId;
    if (!currentSessionId) console.log(chalk.dim(localize(language, "没有对话历史。\n", "No conversation history.\n")));
    else renderReplay(await loadSession(cwd, currentSessionId));
    return true;
  }
  if (task === "/history sessions") {
    const { sessions, unreadable } = await listSessionsWithIssues(cwd);
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
