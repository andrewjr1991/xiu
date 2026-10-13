import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { AgentConfig } from "../config.js";
import { formatTaskDiagnostics } from "../diagnostics.js";
import { buildExecutionReport, type ExecutionReportFormat, type ExecutionReportScope, formatExecutionReport, originalTaskGoal, serializeExecutionReport, writeExecutionReport } from "../execution-report.js";
import { localize, type UiLanguage } from "../i18n.js";
import type { SecurityAuditCategory, SecurityAuditLog } from "../security-audit.js";
import { loadSession } from "../session.js";
import type { TaskRunJournal } from "../task-run.js";
import { renderTerminalMarkdown } from "../terminal-markdown.js";
import { askQuestion } from "../terminal-prompts.js";

export interface ReportCommandContext {
  agent: Agent;
  config: AgentConfig;
  language: UiLanguage;
  securityAudit: SecurityAuditLog;
  taskRunJournal: TaskRunJournal;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleReportCommand(task: string, ctx: ReportCommandContext): Promise<boolean> {
  const { agent, config, language, securityAudit, taskRunJournal } = ctx;
  if (task === "/diagnostics") {
    console.log(`${formatTaskDiagnostics(agent.status().diagnostics, language)}\n`);
    return true;
  }
  if (task === "/report" || task.startsWith("/report ")) {
    try {
      const run = await taskRunJournal.latest();
      if (!run) throw new Error(localize(language, "本工作区还没有可报告的任务运行记录。", "This workspace has no task run to report yet."));
      const restored = await loadSession(config.cwd, run.sessionId).catch(() => undefined);
      const replay = restored?.replay.filter((item) => item.inputKind !== "system") ?? [];
      const sessionUpdatedAt = restored?.updatedAt ?? run.updatedAt;
      const turn = replay
        .sort((left, right) => {
          const leftDistance = Math.abs(Date.parse(left.diagnostics?.startedAt ?? sessionUpdatedAt) - Date.parse(run.startedAt));
          const rightDistance = Math.abs(Date.parse(right.diagnostics?.startedAt ?? sessionUpdatedAt) - Date.parse(run.startedAt));
          return leftDistance - rightDistance;
        })[0];
      const selectedIndex = turn ? restored?.replay.indexOf(turn) ?? -1 : -1;
      const rootGoal = originalTaskGoal(turn?.task ?? run.taskPreview);
      let rootIndex = selectedIndex;
      if (restored && selectedIndex >= 0) {
        for (let index = selectedIndex; index >= 0; index--) {
          const candidate = restored.replay[index];
          if (candidate?.inputKind !== "system" && originalTaskGoal(candidate?.task ?? "") === rootGoal) rootIndex = index;
          if (candidate?.task === rootGoal) { rootIndex = index; break; }
        }
      }
      const turns = restored && rootIndex >= 0 && selectedIndex >= rootIndex
        ? restored.replay.slice(rootIndex, selectedIndex + 1).filter((item) => item.inputKind !== "system")
        : (turn ? [turn] : []);
      const chainStartedAt = turns[0]?.diagnostics?.startedAt;
      const recentRuns = await taskRunJournal.recent(200);
      const runs = recentRuns
        .filter((item) => item.sessionId === run.sessionId
          && (!chainStartedAt || Date.parse(item.startedAt) >= Date.parse(chainStartedAt) - 5_000)
          && Date.parse(item.startedAt) <= Date.parse(run.finishedAt ?? run.updatedAt))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      const audit = await securityAudit.read({ limit: 500, workspaceOnly: true });
      if (task === "/report") {
        const report = buildExecutionReport({ cwd: config.cwd, run, runs, turn, turns, auditRecords: audit.records, scope: "summary" });
        console.log(`${renderTerminalMarkdown(formatExecutionReport(report, language))}\n`);
        return true;
      }
      const match = task.match(/^\/report\s+export\s+(markdown|json)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(summary|details)$/i);
      if (!match) {
        console.log(chalk.yellow(localize(language,
          "用法：/report 或 /report export <markdown|json> <工作区内路径> <summary|details>\n",
          "Usage: /report or /report export <markdown|json> <workspace path> <summary|details>\n")));
        return true;
      }
      const format = match[1]!.toLowerCase() as ExecutionReportFormat;
      const requestedPath = match[2] ?? match[3] ?? match[4]!;
      const scope = match[5]!.toLowerCase() as ExecutionReportScope;
      const target = path.resolve(config.cwd, requestedPath);
      const exists = await fs.lstat(target).catch(() => undefined);
      if (exists) {
        const answer = await askQuestion(chalk.yellow(localize(language, `报告文件已存在，覆盖 ${requestedPath}？[y/N] `, `Report exists. Overwrite ${requestedPath}? [y/N] `)));
        if (!/^(y|yes)$/i.test(answer.trim())) {
          console.log(chalk.dim(localize(language, "已取消报告导出。\n", "Report export cancelled.\n")));
          return true;
        }
      }
      const report = buildExecutionReport({ cwd: config.cwd, run, runs, turn, turns, auditRecords: audit.records, scope });
      const written = await writeExecutionReport(config.cwd, requestedPath, serializeExecutionReport(report, format, language));
      console.log(chalk.green(localize(language, `执行报告已导出：${path.relative(config.cwd, written)}\n`, `Execution report exported: ${path.relative(config.cwd, written)}\n`)));
    } catch (error) {
      console.error(chalk.red(`${localize(language, "生成执行报告失败", "Could not generate execution report")}: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  if (task === "/audit" || task.startsWith("/audit ")) {
    const argument = task.slice("/audit".length).trim().toLowerCase();
    const category: SecurityAuditCategory | undefined = argument === "approvals" || argument === "approval"
      ? "approval"
      : argument === "credentials" || argument === "credential"
        ? "credential"
        : undefined;
    if (argument && !category) {
      console.log(chalk.yellow(localize(language, "用法：/audit [approvals|credentials]\n", "Usage: /audit [approvals|credentials]\n")));
      return true;
    }
    try {
      const result = await securityAudit.read({ category, limit: 50 });
      const auditStatus = securityAudit.status();
      console.log(chalk.cyan(localize(language, "本机安全审计（不包含命令正文、Prompt、文件内容或凭证）", "Local security audit (excludes command text, prompts, file contents, and credentials)")));
      if (!result.records.length) console.log(chalk.dim(localize(language, "暂无匹配记录。", "No matching records.")));
      else for (const record of result.records) {
        const details = [record.category, record.action, record.outcome, record.risk, record.source, record.scope, record.subject].filter(Boolean).join(" · ");
        console.log(`${chalk.dim(record.timestamp)} · ${details}`);
      }
      if (result.truncated) console.log(chalk.dim(localize(language, "仅显示最近 50 条匹配记录。", "Showing only the 50 most recent matching records.")));
      if (result.invalidLines) console.log(chalk.yellow(localize(language, `忽略了 ${result.invalidLines} 条损坏记录。`, `Ignored ${result.invalidLines} invalid record(s).`)));
      if (!auditStatus.healthy) console.log(chalk.yellow(localize(language, `本进程最近一次审计写入失败：${auditStatus.lastError}`, `The most recent audit write in this process failed: ${auditStatus.lastError}`)));
      console.log();
    } catch (error) {
      console.error(chalk.red(`${localize(language, "读取安全审计失败", "Could not read security audit")}: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  return false;
}
