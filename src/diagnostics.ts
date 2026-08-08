import { createHash } from "node:crypto";
import { localize, type UiLanguage } from "./i18n.js";

export type DiagnosticPhaseKind = "idle" | "model" | "tool" | "approval";
export type DiagnosticHealthState = "healthy" | "waiting" | "attention" | "stalled";
export type DiagnosticOutcome = "running" | "completed" | "unverified" | "failed" | "cancelled" | "interrupted";
export type DiagnosticToolOutcome = "success" | "failure" | "denied" | "cancelled";

export interface DiagnosticFailure {
  at: string;
  category: "model" | "tool";
  operation: string;
  message: string;
  durationMs: number;
}

export interface TaskDiagnosticSnapshot {
  version: 1;
  task: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  outcome: DiagnosticOutcome;
  durationMs: number;
  phase: { kind: DiagnosticPhaseKind; operation?: string; activeMs: number };
  health: { state: DiagnosticHealthState; reason?: string; recommendation?: string };
  model: {
    attempts: number;
    completed: number;
    failures: number;
    retries: number;
    inputTokens: number;
    outputTokens: number;
    totalMs: number;
    slowestMs: number;
    slowestOperation?: string;
  };
  tools: {
    calls: number;
    failures: number;
    totalMs: number;
    slowestMs: number;
    slowestOperation?: string;
    byName: Array<{ name: string; calls: number; failures: number; totalMs: number }>;
  };
  approvals: { requests: number; denied: number; waitMs: number };
  compactions: number;
  progress: { lastAt: string; operationsSince: number; distinctOperations: number; consecutiveFailures: number };
  failures: DiagnosticFailure[];
}

interface ActiveOperation {
  kind: Exclude<DiagnosticPhaseKind, "idle">;
  operation: string;
  startedAt: number;
}

interface ActiveTool {
  name: string;
  operation: string;
  signature: string;
  startedAt: number;
  sensitiveValues: string[];
}

const MAX_FAILURES = 12;
const MAX_TOOL_NAMES = 30;
const MAX_TASK_CHARACTERS = 500;
const MAX_OPERATION_CHARACTERS = 320;
const MAX_MESSAGE_CHARACTERS = 320;

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function finiteInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function bounded(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function credentialKey(key: string): boolean {
  return /(?:api[-_]?key|token|password|passwd|secret|authorization|cookie|credential)/i.test(key);
}

function redactText(value: string, sensitiveValues: string[] = []): string {
  let result = value;
  for (const secret of sensitiveValues.filter((item) => item.length >= 4)) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/((?:api[-_]?key|token|password|secret|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function sanitizeValue(value: unknown, key: string, sensitive: string[], depth = 0): unknown {
  if (credentialKey(key)) {
    if (typeof value === "string") sensitive.push(value);
    return "[REDACTED]";
  }
  if (depth >= 3) return "[bounded]";
  if (typeof value === "string") return bounded(redactText(value), 240);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitizeValue(item, "", sensitive, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey, sensitive, depth + 1)]));
  return String(value);
}

function describeOperation(name: string, input: Record<string, unknown>): { text: string; signature: string; sensitiveValues: string[] } {
  const sensitiveValues: string[] = [];
  const safe = Object.fromEntries(Object.entries(input).slice(0, 24).map(([key, value]) => [key, sanitizeValue(value, key, sensitiveValues)]));
  const serialized = JSON.stringify(safe);
  return {
    text: bounded(`${name} ${serialized}`, MAX_OPERATION_CHARACTERS),
    signature: createHash("sha256").update(`${name}:${serialized}`).digest("hex").slice(0, 24),
    sensitiveValues,
  };
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validSnapshot(value: unknown): value is TaskDiagnosticSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.task !== "string" || item.task.length > MAX_TASK_CHARACTERS || !validDate(item.startedAt) || !validDate(item.updatedAt)) return false;
  if (item.completedAt !== undefined && !validDate(item.completedAt)) return false;
  if (!["running", "completed", "unverified", "failed", "cancelled", "interrupted"].includes(String(item.outcome)) || !finiteInteger(item.durationMs)) return false;
  const phase = item.phase as Record<string, unknown> | undefined;
  const health = item.health as Record<string, unknown> | undefined;
  const model = item.model as Record<string, unknown> | undefined;
  const tools = item.tools as Record<string, unknown> | undefined;
  const approvals = item.approvals as Record<string, unknown> | undefined;
  const progress = item.progress as Record<string, unknown> | undefined;
  if (!phase || !health || !model || !tools || !approvals || !progress) return false;
  if (!["idle", "model", "tool", "approval"].includes(String(phase.kind)) || !finiteInteger(phase.activeMs) || (phase.operation !== undefined && (typeof phase.operation !== "string" || phase.operation.length > MAX_OPERATION_CHARACTERS))) return false;
  if (!["healthy", "waiting", "attention", "stalled"].includes(String(health.state))) return false;
  if ([health.reason, health.recommendation].some((field) => field !== undefined && (typeof field !== "string" || field.length > MAX_MESSAGE_CHARACTERS))) return false;
  const modelNumbers = [model.attempts, model.completed, model.failures, model.retries, model.inputTokens, model.outputTokens, model.totalMs, model.slowestMs];
  const toolNumbers = [tools.calls, tools.failures, tools.totalMs, tools.slowestMs];
  const approvalNumbers = [approvals.requests, approvals.denied, approvals.waitMs];
  const progressNumbers = [progress.operationsSince, progress.distinctOperations, progress.consecutiveFailures];
  if (![...modelNumbers, ...toolNumbers, ...approvalNumbers, ...progressNumbers, item.compactions].every((number) => finiteInteger(number))) return false;
  if ([model.slowestOperation, tools.slowestOperation].some((field) => field !== undefined && (typeof field !== "string" || field.length > MAX_OPERATION_CHARACTERS))) return false;
  if (!validDate(progress.lastAt)) return false;
  if (!Array.isArray(tools.byName) || tools.byName.length > MAX_TOOL_NAMES || !tools.byName.every((row) => {
    if (!row || typeof row !== "object") return false;
    const entry = row as Record<string, unknown>;
    return typeof entry.name === "string" && entry.name.length <= 100 && [entry.calls, entry.failures, entry.totalMs].every((number) => finiteInteger(number));
  })) return false;
  if (!Array.isArray(item.failures) || item.failures.length > MAX_FAILURES || !item.failures.every((failure) => {
    if (!failure || typeof failure !== "object") return false;
    const entry = failure as Record<string, unknown>;
    return validDate(entry.at) && ["model", "tool"].includes(String(entry.category)) && typeof entry.operation === "string" && entry.operation.length <= MAX_OPERATION_CHARACTERS && typeof entry.message === "string" && entry.message.length <= MAX_MESSAGE_CHARACTERS && finiteInteger(entry.durationMs);
  })) return false;
  return true;
}

export class TaskDiagnostics {
  private readonly startedAtMs: number;
  private updatedAtMs: number;
  private completedAtMs?: number;
  private outcome: DiagnosticOutcome = "running";
  private active?: ActiveOperation;
  private activeBeforeApproval?: ActiveOperation;
  private activeTool?: ActiveTool;
  private modelStartedAt?: number;
  private modelOperation?: string;
  private approvalStartedAt?: number;
  private model = { attempts: 0, completed: 0, failures: 0, retries: 0, inputTokens: 0, outputTokens: 0, totalMs: 0, slowestMs: 0, slowestOperation: undefined as string | undefined };
  private tools = { calls: 0, failures: 0, totalMs: 0, slowestMs: 0, slowestOperation: undefined as string | undefined };
  private approvals = { requests: 0, denied: 0, waitMs: 0 };
  private toolStats = new Map<string, { calls: number; failures: number; totalMs: number }>();
  private compactions = 0;
  private lastProgressAtMs: number;
  private operationsSinceProgress = 0;
  private consecutiveFailures = 0;
  private seenOperations = new Set<string>();
  private distinctOperations = 0;
  private failures: DiagnosticFailure[] = [];

  constructor(private readonly task: string, private readonly now: () => number = Date.now, restored?: TaskDiagnosticSnapshot) {
    if (restored) {
      this.startedAtMs = Date.parse(restored.startedAt);
      this.updatedAtMs = Date.parse(restored.updatedAt);
      this.completedAtMs = restored.completedAt ? Date.parse(restored.completedAt) : undefined;
      this.outcome = restored.outcome;
      this.model = { ...restored.model, slowestOperation: restored.model.slowestOperation };
      this.tools = { calls: restored.tools.calls, failures: restored.tools.failures, totalMs: restored.tools.totalMs, slowestMs: restored.tools.slowestMs, slowestOperation: restored.tools.slowestOperation };
      this.approvals = { ...restored.approvals };
      this.toolStats = new Map(restored.tools.byName.map((row) => [row.name, { calls: row.calls, failures: row.failures, totalMs: row.totalMs }]));
      this.compactions = restored.compactions;
      this.lastProgressAtMs = Date.parse(restored.progress.lastAt);
      this.operationsSinceProgress = restored.progress.operationsSince;
      this.consecutiveFailures = restored.progress.consecutiveFailures;
      this.distinctOperations = restored.progress.distinctOperations;
      this.failures = restored.failures.map((failure) => ({ ...failure }));
      return;
    }
    this.startedAtMs = this.now();
    this.updatedAtMs = this.startedAtMs;
    this.lastProgressAtMs = this.startedAtMs;
  }

  beginModel(operation: string, attempt: number): void {
    const now = this.touch();
    const name = bounded(operation, MAX_OPERATION_CHARACTERS);
    this.model.attempts++;
    if (attempt > 1) this.model.retries++;
    this.modelStartedAt = now;
    this.modelOperation = name;
    this.active = { kind: "model", operation: name, startedAt: now };
  }

  finishModel(usage: { inputTokens: number; outputTokens: number } | undefined, success: boolean, error = "Model request failed"): void {
    const now = this.touch();
    const durationMs = this.modelStartedAt === undefined ? 0 : Math.max(0, now - this.modelStartedAt);
    const operation = this.modelOperation ?? "model request";
    this.model.totalMs += durationMs;
    if (durationMs >= this.model.slowestMs) {
      this.model.slowestMs = durationMs;
      this.model.slowestOperation = operation;
    }
    if (success) {
      this.model.completed++;
      this.model.inputTokens += Math.max(0, Math.trunc(usage?.inputTokens ?? 0));
      this.model.outputTokens += Math.max(0, Math.trunc(usage?.outputTokens ?? 0));
    } else {
      this.model.failures++;
      this.operationsSinceProgress++;
      this.consecutiveFailures++;
      this.addFailure("model", operation, error, durationMs);
    }
    this.modelStartedAt = undefined;
    this.modelOperation = undefined;
    if (this.active?.kind === "model") this.active = undefined;
  }

  beginTool(name: string, input: Record<string, unknown>): void {
    const now = this.touch();
    const operation = describeOperation(name, input);
    this.activeTool = { name: bounded(name, 100), operation: operation.text, signature: operation.signature, startedAt: now, sensitiveValues: operation.sensitiveValues };
    this.active = { kind: "tool", operation: operation.text, startedAt: now };
  }

  finishTool(outcome: boolean | DiagnosticToolOutcome, result: string): void {
    const now = this.touch();
    const tool = this.activeTool ?? { name: "unknown", operation: "unknown tool", signature: "unknown", startedAt: now, sensitiveValues: [] };
    const durationMs = Math.max(0, now - tool.startedAt);
    this.tools.calls++;
    this.tools.totalMs += durationMs;
    if (durationMs >= this.tools.slowestMs) {
      this.tools.slowestMs = durationMs;
      this.tools.slowestOperation = tool.operation;
    }
    const aggregate = this.toolStats.get(tool.name) ?? { calls: 0, failures: 0, totalMs: 0 };
    aggregate.calls++;
    aggregate.totalMs += durationMs;
    this.toolStats.set(tool.name, aggregate);
    this.operationsSinceProgress++;
    const normalizedOutcome = typeof outcome === "boolean" ? (outcome ? "success" : "failure") : outcome;
    if (normalizedOutcome === "success") {
      this.consecutiveFailures = 0;
      if (!this.seenOperations.has(tool.signature)) {
        this.seenOperations.add(tool.signature);
        this.distinctOperations++;
        this.markProgress();
      }
    } else if (normalizedOutcome === "failure") {
      this.tools.failures++;
      aggregate.failures++;
      this.consecutiveFailures++;
      this.addFailure("tool", tool.operation, result, durationMs, tool.sensitiveValues);
    }
    this.activeTool = undefined;
    if (this.active?.kind === "tool") this.active = undefined;
  }

  beginApproval(operation: string): void {
    const now = this.touch();
    this.approvals.requests++;
    this.approvalStartedAt = now;
    this.activeBeforeApproval = this.active;
    this.active = { kind: "approval", operation: bounded(redactText(operation, this.activeTool?.sensitiveValues), MAX_OPERATION_CHARACTERS), startedAt: now };
  }

  finishApproval(approved: boolean): void {
    const now = this.touch();
    if (this.approvalStartedAt !== undefined) this.approvals.waitMs += Math.max(0, now - this.approvalStartedAt);
    if (!approved) this.approvals.denied++;
    this.approvalStartedAt = undefined;
    this.active = this.activeBeforeApproval;
    this.activeBeforeApproval = undefined;
  }

  recordCompaction(): void {
    this.compactions++;
    this.touch();
  }

  cancelActive(): void {
    const now = this.touch();
    if (this.approvalStartedAt !== undefined) this.approvals.waitMs += Math.max(0, now - this.approvalStartedAt);
    if (this.modelStartedAt !== undefined) {
      const durationMs = Math.max(0, now - this.modelStartedAt);
      this.model.totalMs += durationMs;
      if (durationMs >= this.model.slowestMs) {
        this.model.slowestMs = durationMs;
        this.model.slowestOperation = this.modelOperation;
      }
      this.modelStartedAt = undefined;
      this.modelOperation = undefined;
    }
    if (this.activeTool) {
      const durationMs = Math.max(0, now - this.activeTool.startedAt);
      this.tools.calls++;
      this.tools.totalMs += durationMs;
      const aggregate = this.toolStats.get(this.activeTool.name) ?? { calls: 0, failures: 0, totalMs: 0 };
      aggregate.calls++;
      aggregate.totalMs += durationMs;
      this.toolStats.set(this.activeTool.name, aggregate);
      if (durationMs >= this.tools.slowestMs) {
        this.tools.slowestMs = durationMs;
        this.tools.slowestOperation = this.activeTool.operation;
      }
      this.activeTool = undefined;
    }
    this.active = undefined;
    this.activeBeforeApproval = undefined;
    this.approvalStartedAt = undefined;
  }

  recordProgress(): void {
    this.markProgress();
  }

  complete(outcome: Exclude<DiagnosticOutcome, "running">): void {
    const now = this.touch();
    this.outcome = outcome;
    this.completedAtMs = now;
    this.active = undefined;
    this.markProgress();
  }

  snapshot(): TaskDiagnosticSnapshot {
    const now = this.now();
    const phase = this.active
      ? { kind: this.active.kind, operation: this.active.operation, activeMs: Math.max(0, now - this.active.startedAt) }
      : { kind: "idle" as const, activeMs: 0 };
    const health = this.health(now, phase.kind, phase.activeMs);
    return {
      version: 1,
      task: bounded(redactText(this.task), MAX_TASK_CHARACTERS),
      startedAt: iso(this.startedAtMs),
      updatedAt: iso(Math.max(this.updatedAtMs, now)),
      ...(this.completedAtMs === undefined ? {} : { completedAt: iso(this.completedAtMs) }),
      outcome: this.outcome,
      durationMs: Math.max(0, (this.completedAtMs ?? now) - this.startedAtMs),
      phase,
      health,
      model: { ...this.model },
      tools: {
        ...this.tools,
        byName: [...this.toolStats.entries()]
          .map(([name, stats]) => ({ name, ...stats }))
          .sort((left, right) => right.totalMs - left.totalMs || right.calls - left.calls || left.name.localeCompare(right.name))
          .slice(0, MAX_TOOL_NAMES),
      },
      approvals: { ...this.approvals },
      compactions: this.compactions,
      progress: { lastAt: iso(this.lastProgressAtMs), operationsSince: this.operationsSinceProgress, distinctOperations: this.distinctOperations, consecutiveFailures: this.consecutiveFailures },
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }

  private touch(): number {
    const now = this.now();
    this.updatedAtMs = Math.max(this.updatedAtMs, now);
    return now;
  }

  private markProgress(): void {
    const now = this.touch();
    this.lastProgressAtMs = now;
    this.operationsSinceProgress = 0;
  }

  private addFailure(category: DiagnosticFailure["category"], operation: string, message: string, durationMs: number, sensitiveValues: string[] = []): void {
    const firstLine = redactText(message, sensitiveValues).split(/\r?\n/, 1)[0] ?? "Failure";
    this.failures.push({ at: iso(this.now()), category, operation: bounded(redactText(operation, sensitiveValues), MAX_OPERATION_CHARACTERS), message: bounded(firstLine, MAX_MESSAGE_CHARACTERS), durationMs });
    if (this.failures.length > MAX_FAILURES) this.failures.shift();
  }

  private health(now: number, phase: DiagnosticPhaseKind, activeMs: number): TaskDiagnosticSnapshot["health"] {
    if (phase === "approval") return { state: "waiting", reason: "waiting_for_approval", recommendation: "Wait for the user decision; this is not a task stall." };
    if (this.consecutiveFailures >= 3) return { state: "stalled", reason: "repeated_failures", recommendation: "Diagnose the shared cause and switch strategy before retrying." };
    const sinceProgress = Math.max(0, now - this.lastProgressAtMs);
    if (this.operationsSinceProgress >= 8 && sinceProgress >= 120_000) return { state: "stalled", reason: "no_new_evidence", recommendation: "Summarize existing evidence, stop repeated investigation, and choose the next untried action." };
    if (phase === "model" && activeMs >= 60_000) return { state: "attention", reason: "slow_model", recommendation: "The model request is still active; consider cancellation only if it exceeds the user's tolerance." };
    if (phase === "tool" && activeMs >= 60_000) return { state: "attention", reason: "slow_tool", recommendation: "The tool is still active; inspect details or cancel if it is no longer useful." };
    if (this.consecutiveFailures > 0 || (this.operationsSinceProgress >= 4 && sinceProgress >= 60_000)) return { state: "attention", reason: this.consecutiveFailures > 0 ? "recent_failures" : "limited_progress", recommendation: "Review the recent failure or confirm that the current strategy is producing new evidence." };
    return { state: "healthy" };
  }
}

export function restoreTaskDiagnostics(value: unknown): TaskDiagnostics | undefined {
  if (!validSnapshot(value)) return undefined;
  const restored: TaskDiagnosticSnapshot = structuredClone(value);
  restored.phase = { kind: "idle", activeMs: 0 };
  if (restored.outcome === "running") restored.outcome = "interrupted";
  return new TaskDiagnostics(restored.task, () => Date.parse(restored.updatedAt), restored);
}

function duration(value: number): string {
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function healthLabel(snapshot: TaskDiagnosticSnapshot, language: UiLanguage): string {
  return ({
    healthy: localize(language, "正常", "healthy"),
    waiting: localize(language, "等待审批", "waiting for approval"),
    attention: localize(language, "需要关注", "attention"),
    stalled: localize(language, "可能停滞", "possibly stalled"),
  } as const)[snapshot.health.state];
}

function outcomeLabel(outcome: DiagnosticOutcome, language: UiLanguage): string {
  const labels: Record<DiagnosticOutcome, [string, string]> = {
    running: ["运行中", "running"],
    completed: ["已完成", "completed"],
    unverified: ["完成但未验证", "completed without verification"],
    failed: ["失败", "failed"],
    cancelled: ["已取消", "cancelled"],
    interrupted: ["已中断", "interrupted"],
  };
  return localize(language, ...labels[outcome]);
}

function phaseLabel(phase: DiagnosticPhaseKind, language: UiLanguage): string {
  const labels: Record<DiagnosticPhaseKind, [string, string]> = {
    idle: ["空闲", "idle"],
    model: ["模型请求", "model request"],
    tool: ["工具执行", "tool execution"],
    approval: ["等待审批", "approval wait"],
  };
  return localize(language, ...labels[phase]);
}

function reasonLabel(reason: string, language: UiLanguage): string {
  const labels: Record<string, [string, string]> = {
    waiting_for_approval: ["正在等待用户审批", "waiting for user approval"],
    repeated_failures: ["连续出现相同类型的失败", "repeated failures"],
    no_new_evidence: ["多次操作没有产生新证据", "no new evidence"],
    slow_model: ["模型请求耗时较长", "slow model request"],
    slow_tool: ["工具执行耗时较长", "slow tool execution"],
    recent_failures: ["最近出现失败", "recent failures"],
    limited_progress: ["近期进展有限", "limited recent progress"],
  };
  const label = labels[reason];
  return label ? localize(language, ...label) : reason;
}

function recommendationLabel(snapshot: TaskDiagnosticSnapshot, language: UiLanguage): string | undefined {
  if (!snapshot.health.reason) return undefined;
  const labels: Record<string, [string, string]> = {
    waiting_for_approval: ["请完成当前审批；等待审批不属于任务停滞。", "Complete the current approval; approval wait is not a task stall."],
    repeated_failures: ["先分析共同原因并切换策略，再继续重试。", "Diagnose the shared cause and switch strategy before retrying."],
    no_new_evidence: ["汇总已有证据，停止重复调查，并选择尚未尝试的下一步。", "Summarize existing evidence, stop repeated investigation, and choose the next untried action."],
    slow_model: ["模型请求仍在运行；仅在超过可接受等待时间时考虑取消。", "The model request is still active; cancel only if it exceeds the acceptable wait."],
    slow_tool: ["工具仍在运行；可查看详情，确认无继续价值时再取消。", "The tool is still active; inspect details and cancel only when it is no longer useful."],
    recent_failures: ["检查最近一次失败，确认当前策略是否仍然有效。", "Review the latest failure and confirm that the current strategy is still effective."],
    limited_progress: ["确认当前策略是否正在产生新证据，必要时调整下一步。", "Confirm that the current strategy is producing new evidence and adjust the next step if needed."],
  };
  const label = labels[snapshot.health.reason];
  return label ? localize(language, ...label) : snapshot.health.recommendation;
}

export function formatTaskDiagnosticSummary(snapshot: TaskDiagnosticSnapshot, language: UiLanguage): string {
  const tokens = snapshot.model.inputTokens + snapshot.model.outputTokens;
  return localize(language,
    `${tokens.toLocaleString()} tokens · 模型 ${duration(snapshot.model.totalMs)} · 工具 ${duration(snapshot.tools.totalMs)} · 失败 ${snapshot.model.failures + snapshot.tools.failures} · ${healthLabel(snapshot, language)}`,
    `${tokens.toLocaleString()} tokens · model ${duration(snapshot.model.totalMs)} · tools ${duration(snapshot.tools.totalMs)} · ${snapshot.model.failures + snapshot.tools.failures} failure(s) · ${healthLabel(snapshot, language)}`);
}

export function formatTaskDiagnostics(snapshot: TaskDiagnosticSnapshot | undefined, language: UiLanguage): string {
  if (!snapshot) return localize(language, "当前会话暂无任务诊断。", "No task diagnostics are available in this session.");
  const failures = snapshot.model.failures + snapshot.tools.failures;
  const lines = language === "zh-CN" ? [
    "任务诊断",
    `任务：${snapshot.task}`,
    `状态：${outcomeLabel(snapshot.outcome, language)} · ${healthLabel(snapshot, language)} · 已运行 ${duration(snapshot.durationMs)}`,
    `当前阶段：${phaseLabel(snapshot.phase.kind, language)}${snapshot.phase.operation ? ` · ${snapshot.phase.operation}` : ""}${snapshot.phase.activeMs ? ` · ${duration(snapshot.phase.activeMs)}` : ""}`,
    `Token：输入 ${snapshot.model.inputTokens.toLocaleString()} / 输出 ${snapshot.model.outputTokens.toLocaleString()} / 合计 ${(snapshot.model.inputTokens + snapshot.model.outputTokens).toLocaleString()}`,
    `模型：${snapshot.model.attempts} 次尝试 / ${snapshot.model.completed} 次成功 / ${snapshot.model.retries} 次重试 / ${snapshot.model.failures} 次失败 · ${duration(snapshot.model.totalMs)}`,
    `工具：${snapshot.tools.calls} 次调用 / 失败 ${snapshot.tools.failures} · ${duration(snapshot.tools.totalMs)}`,
    `审批：${snapshot.approvals.requests} 次 / 拒绝 ${snapshot.approvals.denied} · 等待 ${duration(snapshot.approvals.waitMs)}`,
    `进展：${snapshot.progress.operationsSince} 次操作未产生新证据 · 连续失败 ${snapshot.progress.consecutiveFailures} · 压缩 ${snapshot.compactions} 次`,
  ] : [
    "Task diagnostics",
    `Task: ${snapshot.task}`,
    `State: ${outcomeLabel(snapshot.outcome, language)} · ${healthLabel(snapshot, language)} · elapsed ${duration(snapshot.durationMs)}`,
    `Current phase: ${phaseLabel(snapshot.phase.kind, language)}${snapshot.phase.operation ? ` · ${snapshot.phase.operation}` : ""}${snapshot.phase.activeMs ? ` · ${duration(snapshot.phase.activeMs)}` : ""}`,
    `Tokens: ${snapshot.model.inputTokens.toLocaleString()} input / ${snapshot.model.outputTokens.toLocaleString()} output / ${(snapshot.model.inputTokens + snapshot.model.outputTokens).toLocaleString()} total`,
    `Model: ${snapshot.model.attempts} attempt(s) / ${snapshot.model.completed} completed / ${snapshot.model.retries} retries / ${snapshot.model.failures} failures · ${duration(snapshot.model.totalMs)}`,
    `Tools: ${snapshot.tools.calls} call(s) / Failures: ${snapshot.tools.failures} · ${duration(snapshot.tools.totalMs)}`,
    `Approvals: ${snapshot.approvals.requests} / denied ${snapshot.approvals.denied} · waited ${duration(snapshot.approvals.waitMs)}`,
    `Progress: ${snapshot.progress.operationsSince} operation(s) without new evidence · ${snapshot.progress.consecutiveFailures} consecutive failure(s) · ${snapshot.compactions} compaction(s)`,
  ];
  if (snapshot.health.reason) lines.push(localize(language, `诊断依据：${reasonLabel(snapshot.health.reason, language)}`, `Diagnostic reason: ${reasonLabel(snapshot.health.reason, language)}`));
  const recommendation = recommendationLabel(snapshot, language);
  if (recommendation) lines.push(localize(language, `建议：${recommendation}`, `Recommendation: ${recommendation}`));
  if (snapshot.model.slowestOperation) lines.push(localize(language, `最慢模型：${duration(snapshot.model.slowestMs)} · ${snapshot.model.slowestOperation}`, `Slowest model: ${duration(snapshot.model.slowestMs)} · ${snapshot.model.slowestOperation}`));
  if (snapshot.tools.slowestOperation) lines.push(localize(language, `最慢工具：${duration(snapshot.tools.slowestMs)} · ${snapshot.tools.slowestOperation}`, `Slowest tool: ${duration(snapshot.tools.slowestMs)} · ${snapshot.tools.slowestOperation}`));
  if (snapshot.tools.byName.length) lines.push(localize(language, "工具耗时：", "Tool time:"), ...snapshot.tools.byName.slice(0, 8).map((row) => `  ${row.name}: ${row.calls} × · ${duration(row.totalMs)}${row.failures ? ` · ${localize(language, `失败 ${row.failures}`, `${row.failures} failed`)}` : ""}`));
  if (failures) lines.push(localize(language, "最近失败：", "Recent failures:"), ...snapshot.failures.slice(-6).map((failure) => `  ${failure.category} · ${failure.operation} · ${failure.message}`));
  return lines.join("\n");
}
