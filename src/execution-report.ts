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
export type ExecutionReportFormat = "markdown" | "json";

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
  const changed = files.length > 0;
  const verificationPassed = verification.some((item) => item.status === "succeeded");
  const complete = run.status === "completed";
  const verified = complete && (!changed || verificationPassed || turns.at(-1)?.completion?.success === true || turn?.completion?.success === true);
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
    `- Provider/Model: ${report.run.provider}/${report.run.model}`,
    `- ${zh ? "耗时" : "Duration"}: ${(report.run.durationMs / 1000).toFixed(1)}s`,
    "",
    `## ${zh ? "关键操作与依据" : "Key actions and evidence"}`,
    ...(report.keyActions.length ? report.keyActions.map((item) => `- ${item}`) : [`- ${zh ? "无单独回执；请结合阶段与验证证据复核" : "no separate receipts; review the phases and verification evidence"}`]),
    "",
    `## ${zh ? "阶段" : "Phases"}`,
    ...report.phases.map((item) => `- ${statusLabel(item.kind, language)}: ${item.succeeded}/${item.total} ${zh ? "成功" : "succeeded"} · ${item.failed} ${zh ? "失败" : "failed"} · ${item.pending} ${zh ? "待确认" : "pending"}`),
    "",
    `## ${zh ? "文件变化" : "File changes"}`,
    ...(report.files.length ? report.files.flatMap((file) => [
      `- ${file.kind} \`${file.path}\`${file.additions === undefined ? "" : ` +${file.additions}`}${file.deletions === undefined ? "" : ` -${file.deletions}`}`,
      ...(file.preview ?? []).map((line) => `  - \`${line.replace(/`/g, "'")}\``),
    ]) : [`- ${zh ? "无记录" : "none recorded"}`]),
    "",
    `## ${zh ? "验证证据" : "Verification evidence"}`,
    ...(report.verification.length ? report.verification.map((item) => `- ${statusLabel(item.status, language)} · ${item.name}${item.evidence ? ` · ${item.evidence}` : ""}`) : [`- ${zh ? "无验证操作记录" : "no verification operation recorded"}`]),
    "",
    `## ${zh ? "失败与重试" : "Failures and retries"}`,
    ...(report.failures.length ? report.failures.map((item) => `- ${item.source} · ${item.operation}: ${item.message}`) : [`- ${zh ? "无" : "none"}`]),
    ...(report.diagnostics ? [`- ${zh ? "模型重试" : "Model retries"}: ${report.diagnostics.retries} · ${zh ? "模型调用" : "model calls"}: ${report.diagnostics.modelCalls} · ${zh ? "工具调用" : "tool calls"}: ${report.diagnostics.toolCalls}`] : []),
    "",
    `## ${zh ? "安全与恢复" : "Security and recovery"}`,
    `- ${zh ? "安全事件" : "Security events"}: ${report.security.events} · ${zh ? "拒绝" : "denied"}: ${report.security.denied} · ${zh ? "失败" : "failed"}: ${report.security.failed}`,
    `- ${zh ? "未知副作用" : "Unknown side effects"}: ${report.recovery.unknownSideEffects.length ? report.recovery.unknownSideEffects.join(", ") : (zh ? "无" : "none")}`,
    ...(report.recovery.lastEvidence ? [`- ${zh ? "最近恢复点" : "Latest recovery point"}: ${report.recovery.lastEvidence}`] : []),
    "",
    `> ${zh ? "报告默认脱敏且有界；details 范围仅额外包含少量脱敏文件预览。" : "The report is redacted and bounded by default; details only adds small redacted file previews."}`,
  ];
  return lines.join("\n");
}

export function serializeExecutionReport(report: ExecutionReport, format: ExecutionReportFormat, language: UiLanguage): string {
  return format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${formatExecutionReport(report, language)}\n`;
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
