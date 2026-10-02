import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createComposerEnterGuard } from "../apps/desktop/renderer/src/composer-enter-guard.js";

const require = createRequire(import.meta.url);
const { resizeViewport, settleLayout, waitFor, focusForKeyboard } = require("../apps/desktop/scripts/ui-smoke-helpers.cjs");

function renderer() {
  let frames: Array<() => void> = [];
  let resizePending = false;
  const events: string[] = [];
  const context = vm.createContext({
    innerWidth: 1366,
    innerHeight: 768,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback: () => void) { frames.push(callback); },
    document: { querySelector: () => ({ nodeName: "BUTTON" }) },
  });
  return {
    context,
    events,
    window: {
      webContents: {
        async executeJavaScript(source: string) {
          const result = await vm.runInContext(source, context);
          // Match Electron's isolated-world result contract.
          assert.notEqual(result?.nodeName, "BUTTON", "DOM nodes must not cross the bridge");
          return result;
        },
      },
      setContentSize(width: number, height: number) {
        context.innerWidth = width;
        context.innerHeight = height;
        resizePending = true;
      },
    },
    frame() {
      // Chromium updates resize/scroll events before animation-frame callbacks.
      if (resizePending) { events.push("resize"); resizePending = false; }
      const callbacks = frames;
      frames = [];
      for (const callback of callbacks) callback();
    },
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("desktop UI viewport waits for queued resize events and rendered layout", async () => {
  const target = renderer();
  let done = false;
  const pending = resizeViewport(target.window, 900, 768, "narrow viewport").then(() => { done = true; });
  await nextTurn();
  assert.equal(target.context.innerWidth, 900);
  assert.deepEqual(target.events, []);
  assert.equal(done, false, "the new dimensions alone must not complete the resize");
  target.frame();
  await nextTurn();
  assert.deepEqual(target.events, ["resize"]);
  assert.equal(done, false, "wait for the layout following resize dispatch");
  target.frame();
  await pending;
  assert.equal(done, true);
});

test("desktop UI viewport rejects a late unexpected size instead of hiding it", async () => {
  const target = renderer();
  const pending = resizeViewport(target.window, 900, 768, "narrow viewport");
  await nextTurn();
  target.frame();
  target.context.innerHeight = 700;
  target.frame();
  await assert.rejects(pending, /expected 900x768, received 900x700/);
});

test("desktop UI layout settling requires two frames even without a resize", async () => {
  const target = renderer();
  let done = false;
  const pending = settleLayout(target.window).then(() => { done = true; });
  await nextTurn();
  assert.equal(done, false);
  target.frame();
  await nextTurn();
  assert.equal(done, false);
  target.frame();
  await pending;
  assert.equal(done, true);
});

test("desktop UI waits return a boolean across the isolated bridge and still fail missing controls", async () => {
  const target = renderer();
  await waitFor(target.window, "document.querySelector('button')", "button");
  await assert.rejects(waitFor(target.window, "false", "missing option", 0), /Timed out waiting for missing option/);
});


function keyboardRenderer(deliverFocusEvents = true) {
  let shown = false;
  let nativeFocused = false;
  const events: string[] = [];
  const guard = createComposerEnterGuard();
  const focusListeners = new Set<() => void>();
  const document = {
    activeElement: undefined as unknown,
    hasFocus: () => nativeFocused,
    querySelector: (_selector: string) => input,
  };
  const input = {
    nodeName: "TEXTAREA",
    disabled: false,
    addEventListener(type: string, listener: () => void) { if (type === "focusin") focusListeners.add(listener); },
    removeEventListener(type: string, listener: () => void) { if (type === "focusin") focusListeners.delete(listener); },
    focus() {
      document.activeElement = input;
      if (nativeFocused && deliverFocusEvents) {
        events.push("focusin");
        for (const listener of [...focusListeners]) listener();
      }
    },
    blur() {
      document.activeElement = undefined;
      // Chromium does not deliver focusout to React's delegated onBlur while
      // its hidden WebContents has never obtained native document focus.
      if (nativeFocused && deliverFocusEvents) { events.push("focusout"); guard.reset(); }
    },
  };
  const context = vm.createContext({ document, setTimeout, clearTimeout });
  return {
    events, document, input, guard, focusListeners,
    setNativeFocused(value: boolean) { nativeFocused = value; },
    window: {
      show() { shown = true; events.push("show"); },
      focus() { assert.equal(shown, true); events.push("window.focus"); },
      webContents: {
        focus() { events.push("webContents.focus"); },
        async executeJavaScript(source: string) { return vm.runInContext(source, context); },
      },
    },
  };
}

test("desktop keyboard smoke obtains real focus before exercising React blur cleanup", async () => {
  const target = keyboardRenderer();
  target.input.focus();
  assert.equal(target.document.activeElement, target.input);
  assert.equal(target.document.hasFocus(), false, "a hidden window can select a textarea without native focus");
  target.guard.compositionStart();
  target.input.blur(); target.input.focus();
  assert.equal(target.guard.shouldSubmit({ key: "Enter" }), false, "the old hidden-window probe never delivered onBlur");
  let ready = false;
  const focus = focusForKeyboard(target.window, ".composer textarea", "composer").then(() => { ready = true; });
  await nextTurn();
  assert.deepEqual(target.events, ["show", "window.focus", "webContents.focus"]);
  assert.equal(ready, false, "activeElement must not satisfy keyboard readiness without document focus");
  target.setNativeFocused(true);
  await focus;
  assert.deepEqual(target.events.slice(-2), ["focusout", "focusin"]);
  assert.equal(target.focusListeners.size, 0);
  target.guard.compositionStart();
  target.input.blur(); target.input.focus();
  assert.equal(target.guard.shouldSubmit({ key: "Enter" }), true, "real focusout resets composition with no timeout or relaxed assertion");
});

test("desktop keyboard smoke requires an actual focus event, not only activeElement and hasFocus", async () => {
  const target = keyboardRenderer(false);
  target.setNativeFocused(true);
  target.input.focus();
  await assert.rejects(focusForKeyboard(target.window, ".composer textarea", "composer", 10), /keyboard target focusin/);
  assert.equal(target.document.activeElement, target.input);
  assert.equal(target.focusListeners.size, 0, "failed readiness must remove its listener");
});

test("desktop keyboard smoke fails closed for a disabled composer", async () => {
  const target = keyboardRenderer();
  target.setNativeFocused(true);
  target.input.disabled = true;
  await assert.rejects(focusForKeyboard(target.window, ".composer textarea", "composer"), /missing or disabled/);
  assert.equal(target.focusListeners.size, 0);
});
