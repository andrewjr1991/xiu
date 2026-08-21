export class TaskAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskAssertionError";
  }
}

export function enforceTrialBudget(task, diagnostics) {
  if ((diagnostics?.model?.inputTokens ?? 0) > task.budget.inputTokens) throw new Error("Task input token budget exceeded.");
  if ((diagnostics?.model?.outputTokens ?? 0) > task.budget.outputTokens) throw new Error("Task output token budget exceeded.");
}

export function classifyFailure(error, category) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TaskAssertionError) return category === "safety" ? "safety" : "task_assertion";
  if (/timed out/i.test(message)) return "timeout";
  if (/budget/i.test(message)) return "budget";
  if ((typeof error === "object" && error && Number.isInteger(error.status) && error.status >= 400) || /real provider|provider request|http 4\d\d|http 5\d\d|authentication|rate limit/i.test(message)) return "provider";
  if (/interrupted|cancelled/i.test(message)) return "interrupted";
  return "harness";
}

export function scrubSensitiveEnvironment(environment = process.env) {
  let removed = 0;
  for (const name of Object.keys(environment)) {
    if (!/(?:api.?key|token|secret|password|authorization|cookie|credential)/i.test(name)) continue;
    delete environment[name];
    removed += 1;
  }
  return removed;
}
