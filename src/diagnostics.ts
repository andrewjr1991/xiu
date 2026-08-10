import { createHash } from "node:crypto";
import { localize, type UiLanguage } from "./i18n.js";
import { PROVIDER_ROUTING_PHASES, type ProviderRoutingPhase } from "./provider-routing.js";

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
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheHits?: number;
  };
  tools: {
    calls: number;
    failures: number;
    totalMs: number;
    slowestMs: number;
    slowestOperation?: string;
    byName: Array<{ name: string; calls: number; failures: number; totalMs: number }>;
  };
  approvals: { requests: number; denied: number; waitMs: number; checks?: number; automatic?: number; remembered?: number };
  providerFailovers?: {
    switches: number;
    events: Array<{ at: string; fromProviderId: string; fromModel: string; toProviderId: string; toModel: string; reason: string }>;
  };
  providerRoutes?: {
    switches: number;
    skipped: number;
    phaseCalls?: Partial<Record<ProviderRoutingPhase, number>>;
    phaseEvents?: Array<{ at: string; phase: ProviderRoutingPhase; providerId: string; model: string; reason: string }>;
    events: Array<{
      at: string;
      phase: ProviderRoutingPhase;
      outcome: "switched" | "skipped";
      fromProviderId: string;
      fromModel: string;
      toProviderId: string;
      toModel?: string;
      reason: string;
    }>;
  };
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
  const optionalApprovalNumbers = [approvals.checks, approvals.automatic, approvals.remembered].filter((value) => value !== undefined);
  const optionalCacheNumbers = [model.cacheReadInputTokens, model.cacheCreationInputTokens, model.cacheHits].filter((value) => value !== undefined);
  const progressNumbers = [progress.operationsSince, progress.distinctOperations, progress.consecutiveFailures];
  if (![...modelNumbers, ...toolNumbers, ...approvalNumbers, ...optionalApprovalNumbers, ...optionalCacheNumbers, ...progressNumbers, item.compactions].every((number) => finiteInteger(number))) return false;
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
  if (item.providerFailovers !== undefined) {
    const failovers = item.providerFailovers as Record<string, unknown>;
    if (!finiteInteger(failovers.switches) || !Array.isArray(failovers.events) || failovers.events.length > 12 || !failovers.events.every((event) => {
      if (!event || typeof event !== "object") return false;
      const entry = event as Record<string, unknown>;
      return validDate(entry.at)
        && [entry.fromProviderId, entry.fromModel, entry.toProviderId, entry.toModel, entry.reason].every((field) => typeof field === "string" && field.length <= MAX_MESSAGE_CHARACTERS);
    })) return false;
  }
  if (item.providerRoutes !== undefined) {
    const routes = item.providerRoutes as Record<string, unknown>;
    if (!finiteInteger(routes.switches) || !finiteInteger(routes.skipped) || !Array.isArray(routes.events) || routes.events.length > 20 || !routes.events.every((event) => {
      if (!event || typeof event !== "object") return false;
      const entry = event as Record<string, unknown>;
      return validDate(entry.at)
        && ["planning", "implementation", "verification"].includes(String(entry.phase))
        && ["switched", "skipped"].includes(String(entry.outcome))
        && [entry.fromProviderId, entry.fromModel, entry.toProviderId, entry.reason].every((field) => typeof field === "string" && field.length <= MAX_MESSAGE_CHARACTERS)
        && (entry.toModel === undefined || (typeof entry.toModel === "string" && entry.toModel.length <= MAX_MESSAGE_CHARACTERS));
    })) return false;
    if (routes.phaseCalls !== undefined) {
      if (!routes.phaseCalls || typeof routes.phaseCalls !== "object" || Array.isArray(routes.phaseCalls)) return false;
      for (const [phase, count] of Object.entries(routes.phaseCalls as Record<string, unknown>)) {
        if (!["planning", "implementation", "verification"].includes(phase) || !finiteInteger(count)) return false;
      }
    }
    if (routes.phaseEvents !== undefined && (!Array.isArray(routes.phaseEvents) || routes.phaseEvents.length > 20 || !routes.phaseEvents.every((event) => {
      if (!event || typeof event !== "object") return false;
      const entry = event as Record<string, unknown>;
      return validDate(entry.at)
        && ["planning", "implementation", "verification"].includes(String(entry.phase))
        && [entry.providerId, entry.model, entry.reason].every((field) => typeof field === "string" && field.length <= MAX_MESSAGE_CHARACTERS);
    }))) return false;
  }
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
  private model = { attempts: 0, completed: 0, failures: 0, retries: 0, inputTokens: 0, outputTokens: 0, totalMs: 0, slowestMs: 0, slowestOperation: undefined as string | undefined, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheHits: 0 };
  private tools = { calls: 0, failures: 0, totalMs: 0, slowestMs: 0, slowestOperation: undefined as string | undefined };
  private approvals = { requests: 0, denied: 0, waitMs: 0, checks: 0, automatic: 0, remembered: 0 };
  private providerFailovers: NonNullable<TaskDiagnosticSnapshot["providerFailovers"]> = { switches: 0, events: [] };
  private providerRoutes: NonNullable<TaskDiagnosticSnapshot["providerRoutes"]> = { switches: 0, skipped: 0, phaseCalls: {}, phaseEvents: [], events: [] };
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
      this.model = { ...restored.model, slowestOperation: restored.model.slowestOperation, cacheReadInputTokens: restored.model.cacheReadInputTokens ?? 0, cacheCreationInputTokens: restored.model.cacheCreationInputTokens ?? 0, cacheHits: restored.model.cacheHits ?? 0 };
      this.tools = { calls: restored.tools.calls, failures: restored.tools.failures, totalMs: restored.tools.totalMs, slowestMs: restored.tools.slowestMs, slowestOperation: restored.tools.slowestOperation };
      this.approvals = {
        ...restored.approvals,
        checks: restored.approvals.checks ?? restored.approvals.requests,
        automatic: restored.approvals.automatic ?? 0,
        remembered: restored.approvals.remembered ?? 0,
      };
      this.providerFailovers = restored.providerFailovers ? structuredClone(restored.providerFailovers) : { switches: 0, events: [] };
      this.providerRoutes = restored.providerRoutes
        ? { ...structuredClone(restored.providerRoutes), phaseCalls: { ...(restored.providerRoutes.phaseCalls ?? {}) }, phaseEvents: [...(restored.providerRoutes.phaseEvents ?? [])] }
        : { switches: 0, skipped: 0, phaseCalls: {}, phaseEvents: [], events: [] };
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

  finishModel(usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined, success: boolean, error = "Model request failed"): void {
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
      const cacheRead = Math.max(0, Math.trunc(usage?.cacheReadInputTokens ?? 0));
      this.model.cacheReadInputTokens += cacheRead;
      this.model.cacheCreationInputTokens += Math.max(0, Math.trunc(usage?.cacheCreationInputTokens ?? 0));
      if (cacheRead > 0) this.model.cacheHits++;
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
    this.approvals.checks++;
    this.approvalStartedAt = now;
    this.activeBeforeApproval = this.active;
    this.active = { kind: "approval", operation: bounded(redactText(operation, this.activeTool?.sensitiveValues), MAX_OPERATION_CHARACTERS), startedAt: now };
  }

  finishApproval(approved: boolean, source: "prompted" | "automatic" | "remembered" = "prompted"): void {
    const now = this.touch();
    if (source === "prompted") {
      this.approvals.requests++;
      if (this.approvalStartedAt !== undefined) this.approvals.waitMs += Math.max(0, now - this.approvalStartedAt);
    } else if (source === "automatic") this.approvals.automatic++;
    else this.approvals.remembered++;
    if (!approved) this.approvals.denied++;
    this.approvalStartedAt = undefined;
    this.active = this.activeBeforeApproval;
    this.activeBeforeApproval = undefined;
  }

  recordCompaction(): void {
    this.compactions++;
    this.touch();
  }

  recordProviderFailover(fromProviderId: string, fromModel: string, toProviderId: string, toModel: string, reason: string): void {
    this.providerFailovers.switches++;
    this.providerFailovers.events.push({
      at: iso(this.touch()),
      fromProviderId: bounded(fromProviderId, 100),
      fromModel: bounded(fromModel, 200),
      toProviderId: bounded(toProviderId, 100),
      toModel: bounded(toModel, 200),
      reason: bounded(redactText(reason), MAX_MESSAGE_CHARACTERS),
    });
    if (this.providerFailovers.events.length > 12) this.providerFailovers.events.shift();
    this.markProgress();
  }

  recordProviderRoute(phase: ProviderRoutingPhase, fromProviderId: string, fromModel: string, toProviderId: string, toModel: string | undefined, outcome: "switched" | "skipped", reason: string): void {
    if (outcome === "switched") this.providerRoutes.switches++;
    else this.providerRoutes.skipped++;
    this.providerRoutes.events.push({
      at: iso(this.touch()), phase, outcome,
      fromProviderId: bounded(fromProviderId, 100), fromModel: bounded(fromModel, 200),
      toProviderId: bounded(toProviderId, 100),
      ...(toModel ? { toModel: bounded(toModel, 200) } : {}),
      reason: bounded(redactText(reason), MAX_MESSAGE_CHARACTERS),
    });
    if (this.providerRoutes.events.length > 20) this.providerRoutes.events.shift();
    this.markProgress();
  }

  recordProviderPhase(phase: ProviderRoutingPhase, providerId: string, model: string, reason: string): void {
    const phaseCalls = (this.providerRoutes.phaseCalls ??= {});
    phaseCalls[phase] = (phaseCalls[phase] ?? 0) + 1;
    const events = (this.providerRoutes.phaseEvents ??= []);
    const previous = events.at(-1);
    if (!previous || previous.phase !== phase || previous.providerId !== providerId || previous.model !== model || previous.reason !== reason) {
      events.push({ at: iso(this.touch()), phase, providerId: bounded(providerId, 100), model: bounded(model, 200), reason: bounded(reason, MAX_MESSAGE_CHARACTERS) });
      if (events.length > 20) events.shift();
    }
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
      providerFailovers: structuredClone(this.providerFailovers),
      providerRoutes: structuredClone(this.providerRoutes),
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

function routingPhaseLabel(phase: ProviderRoutingPhase, language: UiLanguage): string {
  const labels: Record<ProviderRoutingPhase, [string, string]> = {
    planning: ["规划", "planning"],
    implementation: ["实现", "implementation"],
    verification: ["验证", "verification"],
  };
  return localize(language, ...labels[phase]);
}

function routingReasonLabel(reason: string, language: UiLanguage): string {
  const labels: Record<string, [string, string]> = {
    plan_mode: ["Plan 模式", "Plan mode"],
    initial_analysis: ["首轮分析", "initial analysis"],
    completion_gate: ["完成门禁要求验证", "completion gate requires verification"],
    verification_step: ["当前计划步骤属于验证", "active plan step is verification"],
    implementation: ["继续实施任务", "continuing implementation"],
  };
  const label = labels[reason];
  return label ? localize(language, ...label) : reason;
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
  const recoverable = snapshot.outcome === "completed" && failures > 0;
  const averageInput = snapshot.model.completed ? Math.round(snapshot.model.inputTokens / snapshot.model.completed) : 0;
  const toolSuccessRate = snapshot.tools.calls ? Math.round(((snapshot.tools.calls - snapshot.tools.failures) / snapshot.tools.calls) * 100) : 100;
  const cacheHits = snapshot.model.cacheHits ?? 0;
  const cacheRead = snapshot.model.cacheReadInputTokens ?? 0;
  const cacheCreation = snapshot.model.cacheCreationInputTokens ?? 0;
  const cacheHitRate = snapshot.model.completed ? Math.round((cacheHits / snapshot.model.completed) * 100) : 0;
  const lines = language === "zh-CN" ? [
    "任务诊断",
    `任务：${snapshot.task}`,
    `状态：${outcomeLabel(snapshot.outcome, language)}${recoverable ? `（过程中有 ${failures} 次可恢复失败）` : ""} · ${healthLabel(snapshot, language)} · 已运行 ${duration(snapshot.durationMs)}`,
    `当前阶段：${phaseLabel(snapshot.phase.kind, language)}${snapshot.phase.operation ? ` · ${snapshot.phase.operation}` : ""}${snapshot.phase.activeMs ? ` · ${duration(snapshot.phase.activeMs)}` : ""}`,
    `Token（所有模型请求累计量，重复上下文会重复计入）：输入 ${snapshot.model.inputTokens.toLocaleString()} / 输出 ${snapshot.model.outputTokens.toLocaleString()} / 合计 ${(snapshot.model.inputTokens + snapshot.model.outputTokens).toLocaleString()} · 平均输入 ${averageInput.toLocaleString()}/次`,
    `模型：${snapshot.model.attempts} 次尝试 / ${snapshot.model.completed} 次成功 / ${snapshot.model.retries} 次重试 / ${snapshot.model.failures} 次失败 · ${duration(snapshot.model.totalMs)}`,
    `Prompt Cache：命中请求 ${cacheHits}/${snapshot.model.completed}（${cacheHitRate}%） · 读取 ${cacheRead.toLocaleString()} tokens · 写入 ${cacheCreation.toLocaleString()} tokens（仅 Provider 回报）`,
    `工具：${snapshot.tools.calls} 次调用 / 成功率 ${toolSuccessRate}% / 失败 ${snapshot.tools.failures} · ${duration(snapshot.tools.totalMs)}`,
    `审批：实际提示 ${snapshot.approvals.requests} 次 / 自动放行 ${snapshot.approvals.automatic ?? 0} / 会话规则放行 ${snapshot.approvals.remembered ?? 0} / 策略检查 ${snapshot.approvals.checks ?? snapshot.approvals.requests} · 拒绝 ${snapshot.approvals.denied} · 人工等待 ${duration(snapshot.approvals.waitMs)}`,
    `进展：${snapshot.progress.operationsSince} 次操作未产生新证据 · 连续失败 ${snapshot.progress.consecutiveFailures} · 压缩 ${snapshot.compactions} 次`,
  ] : [
    "Task diagnostics",
    `Task: ${snapshot.task}`,
    `State: ${outcomeLabel(snapshot.outcome, language)}${recoverable ? ` (${failures} recoverable failure(s) during execution)` : ""} · ${healthLabel(snapshot, language)} · elapsed ${duration(snapshot.durationMs)}`,
    `Current phase: ${phaseLabel(snapshot.phase.kind, language)}${snapshot.phase.operation ? ` · ${snapshot.phase.operation}` : ""}${snapshot.phase.activeMs ? ` · ${duration(snapshot.phase.activeMs)}` : ""}`,
    `Tokens (cumulative across model requests; repeated context is counted each time): ${snapshot.model.inputTokens.toLocaleString()} input / ${snapshot.model.outputTokens.toLocaleString()} output / ${(snapshot.model.inputTokens + snapshot.model.outputTokens).toLocaleString()} total · ${averageInput.toLocaleString()} average input/request`,
    `Model: ${snapshot.model.attempts} attempt(s) / ${snapshot.model.completed} completed / ${snapshot.model.retries} retries / ${snapshot.model.failures} failures · ${duration(snapshot.model.totalMs)}`,
    `Prompt cache: ${cacheHits}/${snapshot.model.completed} request(s) hit (${cacheHitRate}%) · ${cacheRead.toLocaleString()} tokens read · ${cacheCreation.toLocaleString()} tokens written (provider-reported only)`,
    `Tools: ${snapshot.tools.calls} call(s) / ${toolSuccessRate}% success / Failures: ${snapshot.tools.failures} · ${duration(snapshot.tools.totalMs)}`,
    `Approvals: ${snapshot.approvals.requests} prompt(s) / ${snapshot.approvals.automatic ?? 0} automatic / ${snapshot.approvals.remembered ?? 0} remembered / ${snapshot.approvals.checks ?? snapshot.approvals.requests} policy check(s) / denied ${snapshot.approvals.denied} · human wait ${duration(snapshot.approvals.waitMs)}`,
    `Progress: ${snapshot.progress.operationsSince} operation(s) without new evidence · ${snapshot.progress.consecutiveFailures} consecutive failure(s) · ${snapshot.compactions} compaction(s)`,
  ];
  if (snapshot.health.reason) lines.push(localize(language, `诊断依据：${reasonLabel(snapshot.health.reason, language)}`, `Diagnostic reason: ${reasonLabel(snapshot.health.reason, language)}`));
  const recommendation = recommendationLabel(snapshot, language);
  if (recommendation) lines.push(localize(language, `建议：${recommendation}`, `Recommendation: ${recommendation}`));
  if (snapshot.model.slowestOperation) lines.push(localize(language, `最慢模型：${duration(snapshot.model.slowestMs)} · ${snapshot.model.slowestOperation}`, `Slowest model: ${duration(snapshot.model.slowestMs)} · ${snapshot.model.slowestOperation}`));
  if (snapshot.tools.slowestOperation) lines.push(localize(language, `最慢工具：${duration(snapshot.tools.slowestMs)} · ${snapshot.tools.slowestOperation}`, `Slowest tool: ${duration(snapshot.tools.slowestMs)} · ${snapshot.tools.slowestOperation}`));
  if (snapshot.providerFailovers?.switches) {
    lines.push(localize(language, `Provider 故障转移：${snapshot.providerFailovers.switches} 次`, `Provider failovers: ${snapshot.providerFailovers.switches}`));
    lines.push(...snapshot.providerFailovers.events.slice(-6).map((event) => `  ${event.fromProviderId}/${event.fromModel} -> ${event.toProviderId}/${event.toModel} · ${event.reason}`));
  }
  if (snapshot.providerRoutes && (snapshot.providerRoutes.switches || snapshot.providerRoutes.skipped)) {
    lines.push(localize(language,
      `阶段路由：切换 ${snapshot.providerRoutes.switches} 次 · 跳过 ${snapshot.providerRoutes.skipped} 次`,
      `Stage routing: ${snapshot.providerRoutes.switches} switch(es) · ${snapshot.providerRoutes.skipped} skipped`));
    lines.push(...snapshot.providerRoutes.events.slice(-8).map((event) =>
      `  ${event.phase} · ${event.fromProviderId}/${event.fromModel} -> ${event.toProviderId}${event.toModel ? `/${event.toModel}` : ""} · ${event.outcome} · ${event.reason}`));
  }
  if (snapshot.providerRoutes?.phaseCalls && Object.values(snapshot.providerRoutes.phaseCalls).some(Boolean)) {
    lines.push(localize(language, "阶段调用：", "Stage calls:") + PROVIDER_ROUTING_PHASES.map((phase) => `${routingPhaseLabel(phase, language)} ${snapshot.providerRoutes?.phaseCalls?.[phase] ?? 0}`).join(" · "));
    if (snapshot.providerRoutes.phaseEvents?.length) {
      lines.push(localize(language, "阶段变化：", "Stage transitions:"), ...snapshot.providerRoutes.phaseEvents.slice(-8).map((event) =>
        `  ${routingPhaseLabel(event.phase, language)} · ${event.providerId}/${event.model} · ${routingReasonLabel(event.reason, language)}`));
    }
  }
  if (snapshot.tools.byName.length) lines.push(localize(language, "工具耗时：", "Tool time:"), ...snapshot.tools.byName.slice(0, 8).map((row) => `  ${row.name}: ${row.calls} × · ${duration(row.totalMs)}${row.failures ? ` · ${localize(language, `失败 ${row.failures}`, `${row.failures} failed`)}` : ""}`));
  if (failures) lines.push(localize(language, "最近失败：", "Recent failures:"), ...snapshot.failures.slice(-6).map((failure) => `  ${failure.category} · ${failure.operation} · ${failure.message}`));
  return lines.join("\n");
}
