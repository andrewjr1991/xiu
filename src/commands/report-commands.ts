import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { AgentConfig } from "../config.js";
import { formatTaskDiagnostics } from "../diagnostics.js";
import { auditRecordDetails } from "./audit-command.js";
import { buildExecutionReport, type ExecutionReportFormat, type ExecutionReportScope, formatExecutionReport, serializeExecutionReport, writeExecutionReport } from "../execution-report.js";
import { collectExecutionReportInputs, defaultExecutionReportSources, type ExecutionReportSources, listReportableRuns } from "../execution-report-query.js";
import { localize, type UiLanguage } from "../i18n.js";
import { redactSecrets } from "../secret-redaction.js";
import type { SecurityAuditCategory, SecurityAuditLog } from "../security-audit.js";
import type { TaskRunJournal, TaskRunRecord } from "../task-run.js";
import { RUN_LIST_LIMIT, RUN_SELECTOR } from "./run-selection.js";
import { renderTerminalMarkdown } from "../terminal-markdown.js";
import { askQuestion } from "../terminal-prompts.js";
import { isWorkspaceTrusted } from "../trust.js";

export interface ReportCommandContext {
  agent: Agent;
  config: AgentConfig;
  language: UiLanguage;
  securityAudit: SecurityAuditLog;
  taskRunJournal: TaskRunJournal;
}

export { collectExecutionReportInputs, type ExecutionReportInputs, type ExecutionReportSources, listReportableRuns } from "../execution-report-query.js";

function noReportableRun(language: UiLanguage): string {
  return localize(language, "本工作区还没有可报告的任务运行记录。", "This workspace has no task run to report yet.");
}

/** Up to this many recent runs are listed and selectable by index or run-id prefix. */
export const REPORT_RUN_LIST_LIMIT = RUN_LIST_LIMIT;

export function formatRunList(runs: TaskRunRecord[], language: UiLanguage): string {
  if (!runs.length) return noReportableRun(language);
  const header = localize(language, "序号  运行 ID   开始时间              状态          任务", "#     run id    started               status        task");
  const lines = runs.map((run, index) => {
    const number = String(index + 1).padEnd(5);
    const id = run.runId.slice(0, 8).padEnd(9);
    const started = run.startedAt.slice(0, 19).padEnd(21);
    const status = run.status.padEnd(13);
    return `${number} ${id} ${started} ${status} ${redactSecrets(run.taskPreview).replace(/\s+/g, " ").slice(0, 80)}`;
  });
  return [header, ...lines, localize(language,
    `选择方式：run:<序号> 或 run:<运行 ID 前缀>（至少 4 位），例如 /report run:2、xiu report run:${runs[0]!.runId.slice(0, 8)}`,
    `Select with run:<number> or run:<run-id prefix> (at least 4 characters), for example /report run:2 or xiu report run:${runs[0]!.runId.slice(0, 8)}`)].join("\n");
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
    "用法：xiu report [markdown|json|html] [summary|details] [run:<序号|运行 ID 前缀>] [工作区内路径] [--yes]，或 xiu report runs 列出最近运行\n省略路径时报告写到标准输出；已存在的文件只有加 --yes 才覆盖。",
    "Usage: xiu report [markdown|json|html] [summary|details] [run:<number|run-id prefix>] [path inside the workspace] [--yes], or xiu report runs to list recent runs\nWithout a path the report goes to stdout; an existing file is overwritten only with --yes.");
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
  let selector: string | undefined;
  let listRuns = false;
  for (const argument of args) {
    const word = argument.toLowerCase();
    const selection = RUN_SELECTOR.exec(argument);
    if (word === "runs") listRuns = true;
    else if (selection && selector === undefined) selector = selection[1];
    else if (REPORT_FORMATS[word]) format = REPORT_FORMATS[word];
    else if (REPORT_SCOPES[word]) scope = REPORT_SCOPES[word];
    else if (!argument.startsWith("-") && requestedPath === undefined) requestedPath = argument;
    else { stderr(reportUsage(language)); return 1; }
  }
  if (listRuns && (selector !== undefined || requestedPath !== undefined)) { stderr(reportUsage(language)); return 1; }
  const trusted = await (options.isTrusted ?? isWorkspaceTrusted)(cwd);
  if (!trusted) {
    stderr(localize(language,
      "工作区尚未信任，不能读取它的任务记录。请先交互运行一次 xiu 并确认信任，或在你掌控的检出目录上显式加 --trust-workspace。",
      "This workspace is not trusted yet, so its task records are not read. Run xiu interactively once and confirm trust, or pass --trust-workspace explicitly on a checkout you control."));
    return 1;
  }
  try {
    const sources: ExecutionReportSources = options.sources ? { cwd, ...options.sources } : defaultExecutionReportSources(cwd);
    if (listRuns) {
      const runs = await listReportableRuns(sources.taskRunJournal);
      if (!runs.length) { stderr(noReportableRun(language)); return 1; }
      stdout(formatRunList(runs, language));
      return 0;
    }
    const inputs = await collectExecutionReportInputs(sources, selector, language);
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
      if (/^\/report\s+runs$/i.test(task)) {
        console.log(`${formatRunList(await listReportableRuns(taskRunJournal), language)}\n`);
        return true;
      }
      const preview = task.match(/^\/report(?:\s+run:(\S+))?$/i);
      const match = preview ? undefined : task.match(/^\/report\s+export\s+(markdown|json|html)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(summary|details)(?:\s+run:(\S+))?$/i);
      if (!preview && !match) {
        console.log(chalk.yellow(localize(language,
          "用法：/report [run:<序号|运行 ID 前缀>]、/report runs 或 /report export <markdown|json|html> <工作区内路径> <summary|details> [run:<序号|运行 ID 前缀>]\n",
          "Usage: /report [run:<number|run-id prefix>], /report runs, or /report export <markdown|json|html> <workspace path> <summary|details> [run:<number|run-id prefix>]\n")));
        return true;
      }
      const inputs = await collectExecutionReportInputs({ cwd: config.cwd, taskRunJournal, securityAudit }, preview ? preview[1] : match![6], language);
      if (!inputs) throw new Error(noReportableRun(language));
      if (preview) {
        const report = buildExecutionReport({ ...inputs, scope: "summary" });
        console.log(`${renderTerminalMarkdown(formatExecutionReport(report, language))}\n`);
        return true;
      }
      const format = match![1]!.toLowerCase() as ExecutionReportFormat;
      const requestedPath = match![2] ?? match![3] ?? match![4]!;
      const scope = match![5]!.toLowerCase() as ExecutionReportScope;
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
        console.log(`${chalk.dim(record.timestamp)} · ${auditRecordDetails(record)}`);
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
