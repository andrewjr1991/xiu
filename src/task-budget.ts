export type TaskBudgetMetric = "tokens" | "modelCalls" | "toolCalls" | "failures" | "wallTimeMs";

export interface TaskBudgetLimits {
  tokens?: number;
  modelCalls?: number;
  toolCalls?: number;
  failures?: number;
  wallTimeMs?: number;
  warningRatio: number;
}

export interface TaskBudgetUsage {
  tokens: number;
  modelCalls: number;
  toolCalls: number;
  failures: number;
  wallTimeMs: number;
}

export interface TaskBudgetSnapshot {
  limits: TaskBudgetLimits;
  usage: TaskBudgetUsage;
  state: "unlimited" | "ok" | "warning" | "exhausted";
  warning: TaskBudgetMetric[];
  exhausted: TaskBudgetMetric[];
}

const METRICS: TaskBudgetMetric[] = ["tokens", "modelCalls", "toolCalls", "failures", "wallTimeMs"];

export function taskBudgetSnapshot(limits: TaskBudgetLimits, usage: TaskBudgetUsage): TaskBudgetSnapshot {
  const configured = METRICS.filter((metric) => limits[metric] !== undefined);
  const exhausted = configured.filter((metric) => usage[metric] >= limits[metric]!);
  const warning = configured.filter((metric) => !exhausted.includes(metric) && usage[metric] >= limits[metric]! * limits.warningRatio);
  return {
    limits: { ...limits }, usage: { ...usage },
    state: configured.length === 0 ? "unlimited" : exhausted.length ? "exhausted" : warning.length ? "warning" : "ok",
    warning, exhausted,
  };
}

export function budgetMetricLabel(metric: TaskBudgetMetric, language: "zh-CN" | "en-US"): string {
  const labels: Record<TaskBudgetMetric, [string, string]> = {
    tokens: ["Token", "tokens"], modelCalls: ["模型调用", "model calls"], toolCalls: ["工具调用", "tool calls"],
    failures: ["失败次数", "failures"], wallTimeMs: ["运行时间", "wall time"],
  };
  return labels[metric][language === "zh-CN" ? 0 : 1];
}

export class TaskBudgetExceededError extends Error {
  readonly code = "TASK_BUDGET_EXHAUSTED";
  constructor(readonly snapshot: TaskBudgetSnapshot) {
    super(`Task budget exhausted: ${snapshot.exhausted.join(", ")}`);
    this.name = "TaskBudgetExceededError";
  }
}
