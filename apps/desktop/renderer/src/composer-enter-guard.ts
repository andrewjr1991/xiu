/**
 * Some IMEs dispatch compositionend immediately before the Enter that commits
 * their candidate. Keep that key out of task submission even when Chromium has
 * already cleared isComposing. This is deliberately bounded: a missing keyup
 * must not eat the user's next deliberate Enter indefinitely.
 */
export const COMPOSITION_END_GRACE_MS = 50;

interface ComposerKey {
  key: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export function createComposerEnterGuard(now: () => number = () => performance.now()) {
  let composing = false;
  let compositionEndedAt = Number.NEGATIVE_INFINITY;
  let imeEnterHeld = false;

  const reset = () => {
    composing = false;
    compositionEndedAt = Number.NEGATIVE_INFINITY;
    imeEnterHeld = false;
  };

  return {
    compositionStart() {
      composing = true;
      compositionEndedAt = Number.NEGATIVE_INFINITY;
      imeEnterHeld = false;
    },
    compositionEnd() {
      composing = false;
      compositionEndedAt = now();
    },
    /** Pass the native event so React's normalized key does not hide keyCode 229. */
    shouldSubmit(event: ComposerKey): boolean {
      const enter = event.key === "Enter";
      const ime = composing || event.isComposing === true || event.keyCode === 229;
      if (ime) {
        if (enter || event.code === "Enter" || event.code === "NumpadEnter") imeEnterHeld = true;
        return false;
      }
      if (!enter) {
        // A new ordinary keystroke is independent of the completed composition.
        compositionEndedAt = Number.NEGATIVE_INFINITY;
        imeEnterHeld = false;
        return false;
      }
      const sinceEnd = now() - compositionEndedAt;
      if ((sinceEnd >= 0 && sinceEnd < COMPOSITION_END_GRACE_MS) || (imeEnterHeld && event.repeat)) {
        imeEnterHeld = true;
        return false;
      }
      compositionEndedAt = Number.NEGATIVE_INFINITY;
      imeEnterHeld = false;
      return !event.shiftKey;
    },
    keyUp() {
      // Key release after candidate acceptance also permits an immediate second
      // Enter. During composition it must not terminate the composition itself.
      if (!composing) {
        compositionEndedAt = Number.NEGATIVE_INFINITY;
        imeEnterHeld = false;
      }
    },
    // No timers/listeners survive a blur, workspace change, or unmount.
    reset,
  };
}
