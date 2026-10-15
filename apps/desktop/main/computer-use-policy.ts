/** Pure Computer Use authorization policy, kept free of Electron so it can be unit tested. */
import type { InputTier } from "../shared/computer-use-inputs.js";

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
export function inputNeedsConfirmation(options: { automatic: boolean; origin: "model" | "renderer"; tier?: InputTier }): boolean {
  return !options.automatic || options.origin === "renderer" || options.tier === "confirm";
}

/** Longest edge a frame may have when it reaches a model; vendors downscale above this anyway and reject multi-megabyte images. */
export const FRAME_MAX_EDGE = 1568;
/** Encoded size above which a frame is re-encoded as JPEG even when it needs no downscaling. */
export const FRAME_MAX_BYTES = 4_500_000;

/** Frame pixels per client pixel for a window of the given client size: 1 for ordinary windows, less for large ones. */
export function frameScale(width: number, height: number, maxEdge = FRAME_MAX_EDGE): number {
  const longest = Math.max(width, height);
  return longest > maxEdge ? maxEdge / longest : 1;
}

export function scaledSize(width: number, height: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Control rectangles in frame pixels, so element IDs and image coordinates share one space. */
export function scaleElements<T extends { x: number; y: number; width: number; height: number }>(elements: T[], scale: number): T[] {
  if (scale === 1) return elements;
  return elements.map(element => ({ ...element, x: Math.floor(element.x * scale), y: Math.floor(element.y * scale), width: Math.max(1, Math.round(element.width * scale)), height: Math.max(1, Math.round(element.height * scale)) }));
}

/** A frame coordinate back in client pixels, clamped to the client area. */
export function toClientCoordinate(value: number, scale: number, clientExtent: number): number {
  return Math.min(clientExtent - 1, Math.max(0, Math.round(value / scale)));
}

/** Approximate decoded byte length of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
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
