import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./secret-redaction.js";
import type { TaskDiagnosticSnapshot } from "./diagnostics.js";
import type { SecurityAuditRecord } from "./security-audit.js";
import type { SessionReplayTurn } from "./session.js";
import type { TaskRunOperation, TaskRunRecord } from "./task-run.js";
import type { UiLanguage } from "./i18n.js";

export type ExecutionReportScope = "summary" | "details";
export type ExecutionReportFormat = "markdown" | "json" | "html";

/**
 * Whether the run's session log backed the report. File changes, receipts and the task chain
 * come from the session log; when it is missing, unreadable or holds no turn for the run, the
 * report says so instead of showing an empty "file changes" that reads as "nothing changed".
 */
export interface ExecutionReportSessionLog {
  status: "read" | "turn-missing" | "missing" | "unreadable";
  sessionId: string;
  /** The system error code for `unreadable` (such as EACCES); never a path or message. */
  detail?: string;
}

export interface ExecutionReport {
  version: 1;
  generatedAt: string;
  scope: ExecutionReportScope;
  run: {
    id: string;
    status: TaskRunRecord["status"];
    startedAt: string;
    finishedAt?: string;
    durationMs: number;
    provider: string;
    model: string;
  };
  goal: string;
  outcome: { complete: boolean; verified: boolean; canContinue: boolean; nextAction: string };
  keyActions: string[];
  phases: Array<{ kind: TaskRunOperation["kind"]; total: number; succeeded: number; failed: number; pending: number }>;
  files: Array<{ path: string; kind: string; additions?: number; deletions?: number; bytesBefore: number; bytesAfter: number; preview?: string[] }>;
  verification: Array<{ name: string; status: string; evidence?: string }>;
  diagnostics?: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    failures: number;
    retries: number;
    durationMs: number;
    compactions: number;
    budget?: TaskDiagnosticSnapshot["budget"];
  };
  failures: Array<{ source: "operation" | "diagnostic"; operation: string; message: string }>;
  security: { events: number; allowed: number; denied: number; failed: number; dangerous: number };
  recovery: { lastEvidence?: string; unknownSideEffects: string[] };
  sessionLog: ExecutionReportSessionLog;
  bounded: { fileLimitReached: boolean; failureLimitReached: boolean; sourceContentIncluded: boolean };
}

const MAX_FILES = 60;
const MAX_FAILURES = 20;
const MAX_PREVIEW_LINES = 4;

function safe(value: string | undefined, maximum = 320): string {
  return redactSecrets(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeGoal(value: string, cwd: string): string {
  const root = path.resolve(cwd);
  return safe(value, 500)
    .replaceAll(root, "[workspace]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]");
}

export function originalTaskGoal(value: string): string {
  let goal = value.trim();
  const continuation = /^Continue the unfinished task from the existing evidence\. Do not restart the investigation or repeat successful reads\. Original goal:\s*/i;
  for (let attempt = 0; attempt < 4 && continuation.test(goal); attempt++) goal = goal.replace(continuation, "").trim();
  return goal;
}

function phaseSummary(operations: TaskRunOperation[]): ExecutionReport["phases"] {
  const kinds: TaskRunOperation["kind"][] = ["model", "tool", "verification", "checkpoint", "steering"];
  return kinds.flatMap((kind) => {
    const items = operations.filter((item) => item.kind === kind);
    if (!items.length) return [];
    return [{
      kind,
      total: items.length,
      succeeded: items.filter((item) => item.status === "succeeded").length,
      failed: items.filter((item) => item.status === "failed" || item.status === "cancelled").length,
      pending: items.filter((item) => item.status === "planned" || item.status === "started" || item.status === "unknown").length,
    }];
  });
}

export function buildExecutionReport(options: {
  cwd: string;
  run: TaskRunRecord;
  runs?: TaskRunRecord[];
  turn?: SessionReplayTurn;
  turns?: SessionReplayTurn[];
  auditRecords?: SecurityAuditRecord[];
  sessionLog?: ExecutionReportSessionLog;
  scope?: ExecutionReportScope;
}): ExecutionReport {
  const { cwd, run, turn } = options;
  const scope = options.scope ?? "summary";
  const runs = options.runs?.length ? options.runs : [run];
  const turns = options.turns?.length ? options.turns : (turn ? [turn] : []);
  const diagnostics = turns.at(-1)?.diagnostics ?? turn?.diagnostics;
  const operations = runs.flatMap((item) => item.operations);
  const rawFiles = turns.flatMap((item) => item.changes).flatMap((notice) => notice.files);
  const fileMap = new Map<string, (typeof rawFiles)[number]>();
  for (const file of rawFiles) {
    const existing = fileMap.get(file.path);
    fileMap.set(file.path, existing ? {
      ...file,
      kind: existing.kind === "created" ? "created" : file.kind,
      additions: (existing.additions ?? 0) + (file.additions ?? 0),
      deletions: (existing.deletions ?? 0) + (file.deletions ?? 0),
      bytesBefore: existing.bytesBefore,
    } : file);
  }
  const allFiles = [...fileMap.values()];
  const files = allFiles.slice(0, MAX_FILES).map((file) => ({
    path: safe(file.path, 240),
    kind: file.kind,
    ...(file.additions === undefined ? {} : { additions: file.additions }),
    ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
    bytesBefore: file.bytesBefore,
    bytesAfter: file.bytesAfter,
    ...(scope === "details" && file.preview.length ? {
      preview: file.preview.slice(0, MAX_PREVIEW_LINES).map((line) => safe(line, 180)),
    } : {}),
  }));
  const verification = operations.filter((item) => item.kind === "verification").slice(-20).map((item) => ({
    name: safe(item.name, 160), status: item.status, ...(item.evidence ? { evidence: safe(item.evidence) } : {}),
  }));
  const operationFailures = operations
    .filter((item) => item.status === "failed" || item.status === "cancelled" || item.status === "unknown")
    .map((item) => ({ source: "operation" as const, operation: safe(item.name), message: safe(item.evidence || item.status) }));
  const diagnosticFailures = (diagnostics?.failures ?? []).map((item) => ({
    source: "diagnostic" as const, operation: safe(item.operation), message: safe(item.message),
  }));
  const allFailures = [...operationFailures, ...diagnosticFailures];
  const startedAt = runs.map((item) => item.startedAt).sort()[0] ?? run.startedAt;
  const finishedAt = runs.map((item) => item.finishedAt ?? item.updatedAt).sort().at(-1) ?? run.updatedAt;
  const auditRecords = (options.auditRecords ?? []).filter((record) => record.timestamp >= startedAt && record.timestamp <= finishedAt);
  const verificationPassed = verification.some((item) => item.status === "succeeded");
  const complete = run.status === "completed";
  const verified = complete && verificationPassed;
  const canContinue = run.status === "running" || run.status === "paused" || run.status === "unverified" || run.status === "failed";
  const unknownSideEffects = operations
    .filter((item) => item.status === "unknown" && item.sideEffect !== "none")
    .slice(-12)
    .map((item) => `${safe(item.name, 120)} (${item.sideEffect}, ${item.replay})`);
  const nextAction = run.status === "running" || run.status === "paused"
    ? "/recover"
    : canContinue
      ? "Start a follow-up task using the recorded evidence; do not replay unknown side effects automatically."
      : "No continuation is required.";
  const receipts = turns.flatMap((item) => item.receipts);
  const keyActions = (receipts.length
    ? receipts
    : operations.filter((item) => item.status === "succeeded" && item.kind !== "model").map((item) => `${item.name}${item.evidence ? `: ${item.evidence}` : ""}`))
    .slice(-20)
    .map((item) => safe(item, 240));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    scope,
    run: {
      id: run.runId, status: run.status, startedAt, ...(run.finishedAt ? { finishedAt } : {}),
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), provider: safe(run.providerId, 100), model: safe(run.model, 160),
    },
    goal: safeGoal(originalTaskGoal(turns[0]?.task || turn?.task || run.taskPreview), cwd),
    outcome: { complete, verified, canContinue, nextAction },
    keyActions,
    phases: phaseSummary(operations),
    files,
    verification,
    ...(diagnostics ? { diagnostics: {
      modelCalls: diagnostics.model.attempts,
      toolCalls: diagnostics.tools.calls,
      inputTokens: diagnostics.model.inputTokens,
      outputTokens: diagnostics.model.outputTokens,
      failures: diagnostics.model.failures + diagnostics.tools.failures,
      retries: diagnostics.model.retries,
      durationMs: diagnostics.durationMs,
      compactions: diagnostics.compactions,
      ...(diagnostics.budget ? { budget: diagnostics.budget } : {}),
    } } : {}),
    failures: allFailures.slice(-MAX_FAILURES),
    security: {
      events: auditRecords.length,
      allowed: auditRecords.filter((item) => item.outcome === "allowed" || item.outcome === "succeeded").length,
      denied: auditRecords.filter((item) => item.outcome === "denied" || item.outcome === "cancelled").length,
      failed: auditRecords.filter((item) => item.outcome === "failed").length,
      dangerous: auditRecords.filter((item) => item.risk === "dangerous").length,
    },
    recovery: { ...(runs.flatMap((item) => item.recoveryPoints).at(-1)?.evidence ? { lastEvidence: safe(runs.flatMap((item) => item.recoveryPoints).at(-1)?.evidence) } : {}), unknownSideEffects },
    sessionLog: options.sessionLog
      ? { status: options.sessionLog.status, sessionId: safe(options.sessionLog.sessionId, 160), ...(options.sessionLog.detail ? { detail: safe(options.sessionLog.detail, 40) } : {}) }
      : { status: turns.length ? "read" : "turn-missing", sessionId: safe(run.sessionId, 160) },
    bounded: { fileLimitReached: allFiles.length > MAX_FILES, failureLimitReached: allFailures.length > MAX_FAILURES, sourceContentIncluded: scope === "details" },
  };
}

function yes(value: boolean, language: UiLanguage): string {
  return language === "zh-CN" ? (value ? "是" : "否") : (value ? "yes" : "no");
}

function statusLabel(status: string, language: UiLanguage): string {
  if (language !== "zh-CN") return status;
  return ({
    running: "运行中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消",
    unverified: "未验证", abandoned: "已放弃", succeeded: "成功", planned: "已计划", started: "进行中", unknown: "未知",
    model: "模型", tool: "工具", verification: "验证", checkpoint: "检查点", steering: "用户引导",
  } as Record<string, string>)[status] ?? status;
}

function nextActionLabel(report: ExecutionReport, language: UiLanguage): string {
  if (language !== "zh-CN") return report.outcome.nextAction;
  if (!report.outcome.canContinue) return "无需继续操作。";
  if (report.run.status === "running" || report.run.status === "paused") return "使用 /recover 从安全恢复点继续。";
  return "沿用已记录证据创建后续任务；不要自动重放副作用未知的操作。";
}

function fileKindLabel(kind: string, language: UiLanguage): string {
  if (language !== "zh-CN") return kind;
  return ({ created: "已创建", modified: "已修改", deleted: "已删除" } as Record<string, string>)[kind] ?? kind;
}

function operationLabel(name: string, language: UiLanguage): string {
  if (language !== "zh-CN") return name;
  return ({
    verify_output: "输出验证", read_file: "读取文件", write_file: "写入文件", replace_text: "替换文本",
    apply_patch: "应用补丁", run_command: "运行命令", run_process: "运行程序", git_status: "检查 Git 状态",
  } as Record<string, string>)[name] ?? name;
}

function evidenceLabel(value: string, language: UiLanguage): string {
  if (language !== "zh-CN") return value;
  return value
    .replace(/^Verification passed:\s*/i, "验证通过：")
    .replace(/\bsize:\s*([\d,]+)\s*bytes?\b/gi, "大小：$1 字节")
    .replace(/\brequired substrings:\s*(\d+\/\d+)/gi, "必需内容：$1")
    .replace(/\bforbidden substrings absent:\s*(\d+\/\d+)/gi, "禁止内容未出现：$1")
    .replace(/^assistant turn\s+(\d+)\s+completed$/i, "助手第 $1 轮已完成")
    .replace(/^assistant turn\s+(\d+)\s+persisted$/i, "助手第 $1 轮已保存")
    .replace(/^tests? passed$/i, "测试通过");
}

function failureSourceLabel(source: "operation" | "diagnostic", language: UiLanguage): string {
  if (language !== "zh-CN") return source;
  return source === "operation" ? "操作" : "诊断";
}

function sideEffectLabel(value: string, language: UiLanguage): string {
  if (language !== "zh-CN") return value;
  return value
    .replace(/\(none, safe-after-confirmation\)/g, "（无副作用，确认后可安全重放）")
    .replace(/\(workspace, verify-first\)/g, "（工作区副作用，需先验证）")
    .replace(/\(process, forbidden\)/g, "（进程副作用，禁止重放）")
    .replace(/\(external, forbidden\)/g, "（外部副作用，禁止重放）")
    .replace(/\(unknown, forbidden\)/g, "（未知副作用，禁止重放）");
}

function keyActionLabel(value: string, language: UiLanguage): string {
  if (language !== "zh-CN") return value;
  const separator = value.indexOf(": ");
  if (separator < 0) return operationLabel(value, language);
  return `${operationLabel(value.slice(0, separator), language)}：${evidenceLabel(value.slice(separator + 2), language)}`;
}

/**
 * One sentence on why the session-backed parts of the report (file changes, receipts, task
 * chain) are absent; undefined when the session log was read. The plain-text one-liner is the same
 * in the Markdown and HTML reports.
 */
export function sessionLogNote(report: ExecutionReport, language: UiLanguage): string | undefined {
  const { status, sessionId, detail } = report.sessionLog;
  if (status === "read") return undefined;
  const zh = language === "zh-CN";
  const session = `${zh ? "会话" : "session"} ${sessionId.slice(0, 8) || "?"}`;
  const consequence = zh
    ? "文件变化、操作回执与任务链无法列出，其余内容仅来自运行记录与审计账本"
    : "file changes, receipts and the task chain cannot be listed; the rest comes from the run record and the audit ledger alone";
  const cause = status === "missing"
    ? (zh ? `会话日志缺失（${session}）` : `session log missing (${session})`)
    : status === "unreadable"
      ? (zh ? `会话日志无法读取（${session}${detail ? `，${detail}` : ""}）` : `session log unreadable (${session}${detail ? `, ${detail}` : ""})`)
      : (zh ? `会话日志里没有这次运行的轮次（${session}）` : `the session log has no turn for this run (${session})`);
  return `${cause}${zh ? "：" : ": "}${consequence}`;
}

function unavailableLabel(report: ExecutionReport, language: UiLanguage, recorded: string): string {
  if (report.sessionLog.status === "read") return recorded;
  return language === "zh-CN" ? "无法列出（见“来源”）" : "unavailable (see Sources)";
}

export function formatExecutionReport(report: ExecutionReport, language: UiLanguage = "zh-CN"): string {
  const zh = language === "zh-CN";
  const lines = [
    `# ${zh ? "Xiu 完整执行报告" : "Xiu execution report"}`,
    "",
    `- ${zh ? "目标" : "Goal"}: ${report.goal || (zh ? "未记录" : "not recorded")}`,
    `- ${zh ? "状态" : "Status"}: ${statusLabel(report.run.status, language)}`,
    `- ${zh ? "完整" : "Complete"}: ${yes(report.outcome.complete, language)}`,
    `- ${zh ? "已验证" : "Verified"}: ${yes(report.outcome.verified, language)}`,
    `- ${zh ? "可继续" : "Can continue"}: ${yes(report.outcome.canContinue, language)} · ${nextActionLabel(report, language)}`,
    `- ${zh ? "服务商/模型" : "Provider/Model"}: ${report.run.provider}/${report.run.model}`,
    `- ${zh ? "耗时" : "Duration"}: ${(report.run.durationMs / 1000).toFixed(1)}${zh ? " 秒" : "s"}`,
    ...(sessionLogNote(report, language) ? [`- ${zh ? "来源" : "Sources"}: ${sessionLogNote(report, language)}`] : []),
    "",
    `## ${zh ? "关键操作与依据" : "Key actions and evidence"}`,
    ...(report.keyActions.length ? report.keyActions.map((item) => `- ${keyActionLabel(item, language)}`) : [`- ${unavailableLabel(report, language, zh ? "无单独回执；请结合阶段与验证证据复核" : "no separate receipts; review the phases and verification evidence")}`]),
    "",
    `## ${zh ? "阶段" : "Phases"}`,
    ...report.phases.map((item) => `- ${statusLabel(item.kind, language)}: ${item.succeeded}/${item.total} ${zh ? "成功" : "succeeded"} · ${item.failed} ${zh ? "失败" : "failed"} · ${item.pending} ${zh ? "待确认" : "pending"}`),
    "",
    `## ${zh ? "文件变化" : "File changes"}`,
    ...(report.files.length ? report.files.flatMap((file) => [
      `- ${fileKindLabel(file.kind, language)} \`${file.path}\`${file.additions === undefined ? "" : ` +${file.additions}`}${file.deletions === undefined ? "" : ` -${file.deletions}`}`,
      ...(file.preview ?? []).map((line) => `  - \`${line.replace(/`/g, "'")}\``),
    ]) : [`- ${unavailableLabel(report, language, zh ? "无记录" : "none recorded")}`]),
    "",
    `## ${zh ? "验证证据" : "Verification evidence"}`,
    ...(report.verification.length ? report.verification.map((item) => `- ${statusLabel(item.status, language)} · ${operationLabel(item.name, language)}${item.evidence ? ` · ${evidenceLabel(item.evidence, language)}` : ""}`) : [`- ${zh ? "无验证操作记录" : "no verification operation recorded"}`]),
    "",
    `## ${zh ? "失败与重试" : "Failures and retries"}`,
    ...(report.failures.length ? report.failures.map((item) => `- ${failureSourceLabel(item.source, language)} · ${operationLabel(item.operation, language)}: ${evidenceLabel(item.message, language)}`) : [`- ${zh ? "无" : "none"}`]),
    ...(report.diagnostics ? [`- ${zh ? "模型重试" : "Model retries"}: ${report.diagnostics.retries} · ${zh ? "模型调用" : "model calls"}: ${report.diagnostics.modelCalls} · ${zh ? "工具调用" : "tool calls"}: ${report.diagnostics.toolCalls}`] : []),
    "",
    `## ${zh ? "安全与恢复" : "Security and recovery"}`,
    `- ${zh ? "安全事件" : "Security events"}: ${report.security.events} · ${zh ? "拒绝" : "denied"}: ${report.security.denied} · ${zh ? "失败" : "failed"}: ${report.security.failed}`,
    `- ${zh ? "未知副作用" : "Unknown side effects"}: ${report.recovery.unknownSideEffects.length ? report.recovery.unknownSideEffects.map((item) => sideEffectLabel(item, language)).join("、") : (zh ? "无" : "none")}`,
    ...(report.recovery.lastEvidence ? [`- ${zh ? "最近恢复点" : "Latest recovery point"}: ${evidenceLabel(report.recovery.lastEvidence, language)}`] : []),
    "",
    `> ${zh ? "报告默认脱敏且有界；详细范围仅额外包含少量脱敏文件预览。" : "The report is redacted and bounded by default; details only adds small redacted file previews."}`,
  ];
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[char] ?? char);
}

const REPORT_HTML_STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --panel: #f6f8fa; --ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --panel: #161b22; --ok: #3fb950; --bad: #f85149; --warn: #d29922; } }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif; }
main { max-width: 960px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; padding: 14px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
dt { color: var(--muted); } dd { margin: 0; }
.ok { color: var(--ok); font-weight: 600; } .bad { color: var(--bad); font-weight: 600; } .warn { color: var(--warn); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 600; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; } code { background: var(--panel); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
pre { margin: 4px 0 0; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
ul { margin: 0; padding-left: 20px; } li { margin: 3px 0; } .empty { color: var(--muted); }
footer { margin-top: 32px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 12px; }
`;

/**
 * A single self-contained HTML document: inline styles only, no scripts, no
 * external resources, and a Content-Security-Policy that forbids both, so the
 * file can be opened or shared without loading anything. Every value is escaped.
 */
export function formatExecutionReportHtml(report: ExecutionReport, language: UiLanguage = "zh-CN"): string {
  const zh = language === "zh-CN";
  const t = (chinese: string, english: string): string => zh ? chinese : english;
  const e = escapeHtml;
  const flag = (value: boolean, good = true): string => `<span class="${value === good ? "ok" : "bad"}">${e(yes(value, language))}</span>`;
  const list = (items: string[], empty: string): string => items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : `<p class="empty">${e(empty)}</p>`;
  const number = (value: number): string => `<td class="num">${value}</td>`;
  const fileRows = report.files.map((file) => `<tr><td>${e(fileKindLabel(file.kind, language))}</td><td><code>${e(file.path)}</code>${file.preview?.length ? `<pre>${file.preview.map(e).join("\n")}</pre>` : ""}</td>${number(file.additions ?? 0)}${number(file.deletions ?? 0)}${number(file.bytesBefore)}${number(file.bytesAfter)}</tr>`).join("");
  const phaseRows = report.phases.map((item) => `<tr><td>${e(statusLabel(item.kind, language))}</td>${number(item.total)}${number(item.succeeded)}${number(item.failed)}${number(item.pending)}</tr>`).join("");
  const statusClass = report.run.status === "completed" ? "ok" : report.run.status === "failed" || report.run.status === "cancelled" || report.run.status === "abandoned" ? "bad" : "warn";
  const diagnostics = report.diagnostics;
  const body = `
<main>
<h1>${e(t("Xiu 完整执行报告", "Xiu execution report"))}</h1>
<p class="meta">${e(t("生成时间", "Generated"))} ${e(report.generatedAt)} · ${e(t("范围", "Scope"))} ${e(report.scope)} · ${e(t("运行", "Run"))} <code>${e(report.run.id)}</code></p>
<dl>
<dt>${e(t("目标", "Goal"))}</dt><dd>${e(report.goal || t("未记录", "not recorded"))}</dd>
<dt>${e(t("状态", "Status"))}</dt><dd><span class="${statusClass}">${e(statusLabel(report.run.status, language))}</span></dd>
<dt>${e(t("完整", "Complete"))}</dt><dd>${flag(report.outcome.complete)}</dd>
<dt>${e(t("已验证", "Verified"))}</dt><dd>${flag(report.outcome.verified)}</dd>
<dt>${e(t("可继续", "Can continue"))}</dt><dd>${e(yes(report.outcome.canContinue, language))} · ${e(nextActionLabel(report, language))}</dd>
<dt>${e(t("服务商/模型", "Provider/Model"))}</dt><dd><code>${e(report.run.provider)}/${e(report.run.model)}</code></dd>
<dt>${e(t("开始", "Started"))}</dt><dd>${e(report.run.startedAt)}${report.run.finishedAt ? ` → ${e(report.run.finishedAt)}` : ""}</dd>
<dt>${e(t("耗时", "Duration"))}</dt><dd>${(report.run.durationMs / 1000).toFixed(1)}${e(t(" 秒", "s"))}</dd>
${sessionLogNote(report, language) ? `<dt>${e(t("来源", "Sources"))}</dt><dd><span class="warn">${e(sessionLogNote(report, language)!)}</span></dd>` : ""}
</dl>
<h2>${e(t("关键操作与依据", "Key actions and evidence"))}</h2>
${list(report.keyActions.map((item) => e(keyActionLabel(item, language))), unavailableLabel(report, language, t("无单独回执；请结合阶段与验证证据复核", "no separate receipts; review the phases and verification evidence")))}
<h2>${e(t("阶段", "Phases"))}</h2>
${report.phases.length ? `<table><thead><tr><th>${e(t("阶段", "Phase"))}</th><th class="num">${e(t("总数", "Total"))}</th><th class="num">${e(t("成功", "Succeeded"))}</th><th class="num">${e(t("失败", "Failed"))}</th><th class="num">${e(t("待确认", "Pending"))}</th></tr></thead><tbody>${phaseRows}</tbody></table>` : `<p class="empty">${e(t("无记录", "none recorded"))}</p>`}
<h2>${e(t("文件变化", "File changes"))}</h2>
${report.files.length ? `<table><thead><tr><th>${e(t("类型", "Kind"))}</th><th>${e(t("路径", "Path"))}</th><th class="num">+</th><th class="num">−</th><th class="num">${e(t("原字节", "Bytes before"))}</th><th class="num">${e(t("现字节", "Bytes after"))}</th></tr></thead><tbody>${fileRows}</tbody></table>${report.bounded.fileLimitReached ? `<p class="empty">${e(t(`仅列出前 ${MAX_FILES} 个文件。`, `Only the first ${MAX_FILES} files are listed.`))}</p>` : ""}` : `<p class="empty">${e(unavailableLabel(report, language, t("无记录", "none recorded")))}</p>`}
<h2>${e(t("验证证据", "Verification evidence"))}</h2>
${list(report.verification.map((item) => `<span class="${item.status === "succeeded" ? "ok" : item.status === "failed" ? "bad" : "warn"}">${e(statusLabel(item.status, language))}</span> · ${e(operationLabel(item.name, language))}${item.evidence ? ` · ${e(evidenceLabel(item.evidence, language))}` : ""}`), t("无验证操作记录", "no verification operation recorded"))}
<h2>${e(t("失败与重试", "Failures and retries"))}</h2>
${list(report.failures.map((item) => `${e(failureSourceLabel(item.source, language))} · ${e(operationLabel(item.operation, language))}: ${e(evidenceLabel(item.message, language))}`), t("无", "none"))}
${diagnostics ? `<p>${e(t("模型重试", "Model retries"))}: ${diagnostics.retries} · ${e(t("模型调用", "model calls"))}: ${diagnostics.modelCalls} · ${e(t("工具调用", "tool calls"))}: ${diagnostics.toolCalls} · ${e(t("输入/输出 Token", "input/output tokens"))}: ${diagnostics.inputTokens}/${diagnostics.outputTokens} · ${e(t("失败", "failures"))}: ${diagnostics.failures} · ${e(t("上下文压缩", "compactions"))}: ${diagnostics.compactions}</p>` : ""}
${report.bounded.failureLimitReached ? `<p class="empty">${e(t(`仅列出最近 ${MAX_FAILURES} 条失败。`, `Only the last ${MAX_FAILURES} failures are listed.`))}</p>` : ""}
<h2>${e(t("安全与恢复", "Security and recovery"))}</h2>
<ul>
<li>${e(t("安全事件", "Security events"))}: ${report.security.events} · ${e(t("允许", "allowed"))}: ${report.security.allowed} · ${e(t("拒绝", "denied"))}: ${report.security.denied} · ${e(t("失败", "failed"))}: ${report.security.failed} · ${e(t("危险", "dangerous"))}: ${report.security.dangerous}</li>
<li>${e(t("未知副作用", "Unknown side effects"))}: ${report.recovery.unknownSideEffects.length ? report.recovery.unknownSideEffects.map((item) => e(sideEffectLabel(item, language))).join(zh ? "、" : ", ") : e(t("无", "none"))}</li>
${report.recovery.lastEvidence ? `<li>${e(t("最近恢复点", "Latest recovery point"))}: ${e(evidenceLabel(report.recovery.lastEvidence, language))}</li>` : ""}
</ul>
<footer>${e(t("报告默认脱敏且有界；详细范围仅额外包含少量脱敏文件预览。此文件不含脚本，不加载任何外部资源。", "The report is redacted and bounded by default; details only adds small redacted file previews. This file contains no scripts and loads no external resources."))}</footer>
</main>`;
  return `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${e(t("Xiu 执行报告", "Xiu execution report"))} · ${e(report.run.id)}</title>
<style>${REPORT_HTML_STYLE}</style>
</head>
<body>${body}
</body>
</html>
`;
}

export function serializeExecutionReport(report: ExecutionReport, format: ExecutionReportFormat, language: UiLanguage): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "html") return formatExecutionReportHtml(report, language);
  return `${formatExecutionReport(report, language)}\n`;
}

export async function writeExecutionReport(cwd: string, requested: string, content: string): Promise<string> {
  const root = path.resolve(cwd);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Report path must be a file inside the workspace.");
  let cursor = root;
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch(() => undefined);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error(`Unsafe report directory: ${cursor}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const existing = await fs.lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`Unsafe report path: ${target}`);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return target;
}
