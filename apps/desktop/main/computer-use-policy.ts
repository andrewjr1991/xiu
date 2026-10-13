/** Pure Computer Use authorization policy, kept free of Electron so it can be unit tested. */

export const AUTOMATIC_DURATION_MS = 20 * 60_000;
export const AUTOMATIC_INPUT_LIMIT = 100;
export const MANUAL_DURATION_MS = 10 * 60_000;
export const MANUAL_INPUT_LIMIT = 30;

/** Automatic-mode allowance shared by every window selection within one parent task. */
export interface ComputerTaskBudget { task: string; deadline: number; inputs: number }

export function budgetExhausted(budget: ComputerTaskBudget | undefined, task: string, now: number): boolean {
  return budget?.task === task && (now >= budget.deadline || budget.inputs >= AUTOMATIC_INPUT_LIMIT);
}

/**
 * A merged Full Access grant may skip the per-window dialog only while the
 * task's automatic allowance remains. Once it has expired or its inputs are
 * spent, re-selecting a window must ask the user again; otherwise the model
 * could renew the limit indefinitely by selecting the same window again.
 */
export function mayReuseMergedGrant(options: { automatic: boolean; grantMatches: boolean; budget?: ComputerTaskBudget; task: string; now: number }): boolean {
  return options.automatic && options.grantMatches && !budgetExhausted(options.budget, options.task, options.now);
}

/** Continue the task's allowance when selection was covered by the merged grant; start a new one after an explicit confirmation. */
export function nextTaskBudget(previous: ComputerTaskBudget | undefined, task: string, now: number, explicitlyConfirmed: boolean): ComputerTaskBudget {
  if (!explicitlyConfirmed && previous?.task === task && !budgetExhausted(previous, task, now)) return previous;
  return { task, deadline: now + AUTOMATIC_DURATION_MS, inputs: 0 };
}

/**
 * Automatic mode skips per-step dialogs only for inputs the parent task's model
 * issues. An input that arrives through the renderer IPC is never covered by
 * that grant, so a compromised renderer cannot act inside the model's window.
 */
export function inputNeedsConfirmation(options: { automatic: boolean; origin: "model" | "renderer" }): boolean {
  return !options.automatic || options.origin === "renderer";
}
