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

/** Native helper error code: the control under the pointer or in focus could not be identified. */
export const UNINSPECTED_CONTROL_CODE = "control-uninspected";

/**
 * The native helper refuses to click or submit when it cannot read the target
 * control (UI Automation failure, cross-process focus, or an actionable control
 * without a name), because the password and consequential-control checks would
 * otherwise silently pass. Only an explicit per-step user confirmation may let
 * that one input through; automatic mode never covers it.
 */
export function isUninspectedControl(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === UNINSPECTED_CONTROL_CODE;
}

/** User-facing note for a frame whose control inspection was not complete. */
export function inspectionNotice(inspection: "complete" | "partial" | "unavailable" | undefined): string | undefined {
  if (inspection === "complete") return undefined;
  if (inspection === "partial") return "本帧控件信息不完整（遍历到达上限），未列出的部分可能含密码框或高风险控件。";
  return "本帧无法读取控件信息，程序不能识别密码框或高风险控件。";
}
