import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { resizeViewport, settleLayout, waitFor } = require("../apps/desktop/scripts/ui-smoke-helpers.cjs");

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
