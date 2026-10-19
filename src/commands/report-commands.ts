import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { AgentConfig } from "../config.js";
import { formatTaskDiagnostics } from "../diagnostics.js";
import { buildExecutionReport, type ExecutionReportFormat, type ExecutionReportScope, formatExecutionReport, originalTaskGoal, serializeExecutionReport, writeExecutionReport } from "../execution-report.js";
import { localize, type UiLanguage } from "../i18n.js";
import { type SecurityAuditCategory, SecurityAuditLog } from "../security-audit.js";
import { loadSession } from "../session.js";
import { TaskRunJournal, type TaskRunRecord } from "../task-run.js";
import { renderTerminalMarkdown } from "../terminal-markdown.js";
import { askQuestion } from "../terminal-prompts.js";
import { isWorkspaceTrusted } from "../trust.js";
import type { SessionReplayTurn } from "../session.js";

export interface ReportCommandContext {
  agent: Agent;
  config: AgentConfig;
  language: UiLanguage;
  securityAudit: SecurityAuditLog;
  taskRunJournal: TaskRunJournal;
}

/** The journal and audit methods the report needs; narrow so tests and the one-shot command can supply their own stores. */
export interface ExecutionReportSources {
  cwd: string;
  taskRunJournal: Pick<TaskRunJournal, "latest" | "recent">;
  securityAudit: Pick<SecurityAuditLog, "read">;
}

export interface ExecutionReportInputs {
  cwd: string;
  run: TaskRunRecord;
  runs: TaskRunRecord[];
  turn?: SessionReplayTurn;
  turns: SessionReplayTurn[];
  auditRecords: Awaited<ReturnType<SecurityAuditLog["read"]>>["records"];
}

function noReportableRun(language: UiLanguage): string {
  return localize(language, "本工作区还没有可报告的任务运行记录。", "This workspace has no task run to report yet.");
}

/**
 * Gathers the latest task run of the workspace, the session turns of its task chain and the
 * workspace's audit facts. Shared by the interactive `/report` and the one-shot `xiu report`.
 * Returns undefined when the workspace has no run yet.
 */
export async function collectLatestExecutionReportInputs(sources: ExecutionReportSources): Promise<ExecutionReportInputs | undefined> {
  const { cwd, taskRunJournal, securityAudit } = sources;
  const run = await taskRunJournal.latest();
  if (!run) return undefined;
  const restored = await loadSession(cwd, run.sessionId).catch(() => undefined);
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
  return { cwd, run, runs, turn, turns, auditRecords: audit.records };
}

export interface ReportCliOptions {
  cwd: string;
  language: UiLanguage;
  /** `--yes`: overwrite an existing report file. Nothing else is auto-approved by this command. */
  yes: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sources?: Omit<ExecutionReportSources, "cwd">;
  isTrusted?: (cwd: string) => Promise<boolean>;
}

const REPORT_FORMATS: Record<string, ExecutionReportFormat> = { markdown: "markdown", md: "markdown", json: "json", html: "html" };
const REPORT_SCOPES: Record<string, ExecutionReportScope> = { summary: "summary", details: "details" };

function reportUsage(language: UiLanguage): string {
  return localize(language,
    "用法：xiu report [markdown|json|html] [summary|details] [工作区内路径] [--yes]\n省略路径时报告写到标准输出；已存在的文件只有加 --yes 才覆盖。",
    "Usage: xiu report [markdown|json|html] [summary|details] [path inside the workspace] [--yes]\nWithout a path the report goes to stdout; an existing file is overwritten only with --yes.");
}

/**
 * `xiu report …`: exports the latest task's execution report without entering the interactive
 * loop. Same data and formats as `/report export`; the workspace must already be trusted, the
 * report never leaves the workspace directory, and no prompt is read from stdin. Returns the
 * process exit code: 0 written or printed, 1 usage error, untrusted workspace or no run yet.
 */
export async function runReportCommand(args: readonly string[], options: ReportCliOptions): Promise<number> {
  const { cwd, language } = options;
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  let format: ExecutionReportFormat = "markdown";
  let scope: ExecutionReportScope = "summary";
  let requestedPath: string | undefined;
  for (const argument of args) {
    const word = argument.toLowerCase();
    if (REPORT_FORMATS[word]) format = REPORT_FORMATS[word];
    else if (REPORT_SCOPES[word]) scope = REPORT_SCOPES[word];
    else if (!argument.startsWith("-") && requestedPath === undefined) requestedPath = argument;
    else { stderr(reportUsage(language)); return 1; }
  }
  const trusted = await (options.isTrusted ?? isWorkspaceTrusted)(cwd);
  if (!trusted) {
    stderr(localize(language,
      "工作区尚未信任，不能读取它的任务记录。请先交互运行一次 xiu 并确认信任，或在你掌控的检出目录上显式加 --trust-workspace。",
      "This workspace is not trusted yet, so its task records are not read. Run xiu interactively once and confirm trust, or pass --trust-workspace explicitly on a checkout you control."));
    return 1;
  }
  try {
    const sources: ExecutionReportSources = options.sources
      ? { cwd, ...options.sources }
      : { cwd, taskRunJournal: new TaskRunJournal(cwd), securityAudit: new SecurityAuditLog(undefined, cwd) };
    const inputs = await collectLatestExecutionReportInputs(sources);
    if (!inputs) { stderr(noReportableRun(language)); return 1; }
    const content = serializeExecutionReport(buildExecutionReport({ ...inputs, scope }), format, language);
    if (requestedPath === undefined) { stdout(content); return 0; }
    const target = path.resolve(cwd, requestedPath);
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing && !options.yes) {
      stderr(localize(language, `报告文件已存在：${requestedPath}。加 --yes 才会覆盖。`, `Report already exists: ${requestedPath}. Add --yes to overwrite it.`));
      return 1;
    }
    const written = await writeExecutionReport(cwd, requestedPath, content);
    stderr(localize(language, `执行报告已导出：${path.relative(cwd, written)}`, `Execution report exported: ${path.relative(cwd, written)}`));
    return 0;
  } catch (error) {
    stderr(`${localize(language, "生成执行报告失败", "Could not generate execution report")}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
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
      const inputs = await collectLatestExecutionReportInputs({ cwd: config.cwd, taskRunJournal, securityAudit });
      if (!inputs) throw new Error(noReportableRun(language));
      if (task === "/report") {
        const report = buildExecutionReport({ ...inputs, scope: "summary" });
        console.log(`${renderTerminalMarkdown(formatExecutionReport(report, language))}\n`);
        return true;
      }
      const match = task.match(/^\/report\s+export\s+(markdown|json|html)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(summary|details)$/i);
      if (!match) {
        console.log(chalk.yellow(localize(language,
          "用法：/report 或 /report export <markdown|json|html> <工作区内路径> <summary|details>\n",
          "Usage: /report or /report export <markdown|json|html> <workspace path> <summary|details>\n")));
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
      const report = buildExecutionReport({ ...inputs, scope });
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
