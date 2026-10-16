/**
 * Single source of truth for the Computer Use input vocabulary and its confirmation tiers.
 *
 * Tier 1 inputs run without a per-step dialog inside a user-granted automatic session.
 * Tier 2 inputs are confirmed by the user every time, even in automatic mode, because they
 * move data across the clipboard, save files or drag content between places.
 * Everything else (Win, Alt, Alt+Tab, Alt+F4, Ctrl+Alt+Del, arbitrary combinations) is refused.
 *
 * `apps/desktop/native/ComputerBridge.cs` embeds the same key list; `test/computer-use-inputs.test.ts`
 * fails whenever the two copies diverge, so the helper never accepts a key the main process does not know.
 */

export type ComputerInputKind = "click" | "doubleclick" | "rightclick" | "drag" | "scroll" | "type" | "key";
export type InputTier = "automatic" | "confirm";

/** Keys the helper may press without a per-step dialog in automatic mode. */
export const TIER1_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "F2", "Shift+Home", "Shift+End", "Ctrl+A", "Ctrl+Z"] as const;
/** Keys that always ask the user first: clipboard, save and redo. */
export const TIER2_KEYS = ["Ctrl+C", "Ctrl+V", "Ctrl+S", "Ctrl+Y"] as const;
/** Combinations the helper only sends to a focused Edit/Document control of the target process. */
export const EDITOR_ONLY_KEYS = ["Shift+Home", "Shift+End", "Ctrl+A", "Ctrl+Z", "Ctrl+C", "Ctrl+V", "Ctrl+Y"] as const;

/** Keys a single step may press several times (`repeat`); Enter, Tab, Escape and combinations never repeat. */
export const REPEATABLE_KEYS = ["Backspace", "Delete", "Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"] as const;
export const MAX_KEY_REPEAT = 50;

export const POINTER_KINDS: readonly ComputerInputKind[] = ["click", "doubleclick", "rightclick", "drag", "scroll"];

/** Which tier an input belongs to, or undefined when it is not part of the vocabulary. */
export function inputTier(input: { kind: string; key?: string }): InputTier | undefined {
  switch (input.kind) {
    case "click": case "doubleclick": case "rightclick": case "scroll": case "type": return "automatic";
    case "drag": return "confirm";
    case "key":
      if ((TIER1_KEYS as readonly string[]).includes(input.key ?? "")) return "automatic";
      if ((TIER2_KEYS as readonly string[]).includes(input.key ?? "")) return "confirm";
      return undefined;
    default: return undefined;
  }
}

export function isEditorOnlyKey(key: string): boolean { return (EDITOR_ONLY_KEYS as readonly string[]).includes(key); }
export function isRepeatableKey(key: string): boolean { return (REPEATABLE_KEYS as readonly string[]).includes(key); }
