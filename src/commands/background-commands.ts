import chalk from "chalk";
import { listBackgroundProcesses, readBackgroundProcessOutput, startBackgroundProcess, stopBackgroundProcess } from "../background.js";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { askQuestion } from "../terminal-prompts.js";
import { classifyCommand } from "../tools.js";
import { formatUserFacingError } from "../user-facing-errors.js";

export interface BackgroundCommandContext {
  config: AgentConfig;
  language: UiLanguage;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleBackgroundCommand(task: string, ctx: BackgroundCommandContext): Promise<boolean> {
  const { config, language } = ctx;
  if (task === "/background" || task.startsWith("/background ")) {
    const parts = task.split(/\s+/);
    try {
      if (parts.length === 1 || parts[1] === "list") {
        const jobs = listBackgroundProcesses();
        if (!jobs.length) console.log(chalk.dim(localize(language, "当前工作区没有后台任务。\n", "No background jobs exist for this workspace.\n")));
        else {
          for (const job of jobs) console.log(`${job.running ? chalk.cyan("●") : chalk.dim("○")} ${job.id} · ${job.state} · PID ${job.pid ?? "-"} · ${job.outputBytes.toLocaleString()} B · ${job.command}`);
          console.log(chalk.dim(localize(language, "使用 /background read <ID> [游标] 读取增量输出；/background cancel <ID> 显式取消。\n", "Use /background read <id> [cursor] for incremental output; /background cancel <id> to stop it explicitly.\n")));
        }
      } else if (parts[1] === "start") {
        const command = task.slice("/background start".length).trim();
        if (!command) throw new Error(localize(language, "必须提供命令", "a command is required"));
        const risk = classifyCommand(command);
        const prompt = risk === "dangerous"
          ? localize(language, `这是危险命令，后台启动后不会再有交互审批。输入 BACKGROUND 确认：`, `This is a dangerous command and cannot prompt again after detaching. Type BACKGROUND to confirm: `)
          : localize(language, `后台启动并允许它在退出 Xiu 后继续？[y/N] `, `Start in background and let it continue after Xiu exits? [y/N] `);
        const answer = await askQuestion(chalk.yellow(prompt));
        const confirmed = risk === "dangerous" ? answer.trim() === "BACKGROUND" : /^(y|yes)$/i.test(answer.trim());
        if (!confirmed) console.log(chalk.dim(localize(language, "已取消后台启动。\n", "Background start cancelled.\n")));
        else {
          const started = startBackgroundProcess(command, config.cwd);
          console.log(chalk.green(localize(language, `后台任务 ${started.id} 已启动（PID ${started.pid ?? "未知"}），退出 Xiu 后仍会继续。\n`, `Background job ${started.id} started (PID ${started.pid ?? "unknown"}) and will survive Xiu exit.\n`)));
        }
      } else if (parts[1] === "read" && parts[2]) {
        const cursor = parts[3] === undefined ? 0 : Number(parts[3]);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(localize(language, "游标必须是非负整数", "cursor must be a non-negative integer"));
        const page = readBackgroundProcessOutput(parts[2], cursor);
        console.log(`${page.text}\n${chalk.dim(localize(language, `状态 ${page.state} · 下一游标 ${page.nextCursor} · 共 ${page.outputBytes.toLocaleString()} B\n`, `State ${page.state} · next cursor ${page.nextCursor} · ${page.outputBytes.toLocaleString()} B total\n`))}`);
      } else if (parts[1] === "cancel" && parts[2]) {
        const selected = listBackgroundProcesses().find((job) => job.id === parts[2]);
        if (!selected) throw new Error(localize(language, `未知后台任务：${parts[2]}`, `Unknown background job: ${parts[2]}`));
        if (!selected.running) console.log(chalk.dim(localize(language, `后台任务 ${selected.id} 已是 ${selected.state}。\n`, `Background job ${selected.id} is already ${selected.state}.\n`)));
        else {
          const answer = await askQuestion(chalk.yellow(localize(language, `取消后台任务 ${selected.id}（${selected.command}）？[y/N] `, `Cancel background job ${selected.id} (${selected.command})? [y/N] `)));
          if (/^(y|yes)$/i.test(answer.trim())) { await stopBackgroundProcess(selected.id); console.log(chalk.green(localize(language, `已取消后台任务 ${selected.id}。\n`, `Background job ${selected.id} cancelled.\n`))); }
          else console.log(chalk.dim(localize(language, "已保留后台任务。\n", "Background job kept running.\n")));
        }
      } else console.log(chalk.yellow(localize(language, "用法：/background [list] | start <命令> | read <ID> [游标] | cancel <ID>\n", "Usage: /background [list] | start <command> | read <id> [cursor] | cancel <id>\n")));
    } catch (error) { console.error(chalk.red(`${formatUserFacingError(localize(language, "后台任务操作失败", "Background job operation failed"), error, language, { diagnostic: "/background list" })}\n`)); }
    return true;
  }
  return false;
}
