const pause = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);

function createSmokeWindow(BrowserWindow, preload) {
  return new BrowserWindow({
    width: 1366, height: 768, useContentSize: true, show: false,
    // macOS constrains visible windows to the display by default. The smoke
    // window must retain its exact test viewport after real keyboard focus.
    // https://www.electronjs.org/docs/latest/api/structures/base-window-options
    enableLargerThanScreen: true,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#fbfcfe", symbolColor: "#65758b", height: 56 },
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
}

async function waitFor(window, source, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    // Never ask Electron's isolated-world bridge to clone a DOM node.
    if (await evaluate(window, `Boolean(${source})`)) return;
    await pause();
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function settleLayout(window) {
  // Reading innerWidth observes the new size before Chromium necessarily sends
  // its queued resize/scroll events. Those events dismiss Select popups. Wait
  // through rendering opportunities, rather than opening a popup in that gap.
  await evaluate(window, `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for layout frames.')), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve(true);
    }));
  })`);
}

async function resizeViewport(window, width, height, label) {
  window.setContentSize(width, height);
  await waitFor(window, `innerWidth === ${width} && innerHeight === ${height}`, label);
  await settleLayout(window);
  // Settling must not conceal a late, incorrect viewport size.
  const actual = await evaluate(window, `({ width: innerWidth, height: innerHeight })`);
  if (actual.width !== width || actual.height !== height) {
    throw new Error(`Viewport changed while settling ${label}: expected ${width}x${height}, received ${actual.width}x${actual.height}.`);
  }
}

async function focusForKeyboard(window, selector, label, timeout = 5000) {
  // A hidden BrowserWindow can retain document.activeElement without receiving
  // native focusin/focusout or sendInputEvent keyboard input. Establish real
  // WebContents focus first; a DOM-only activeElement check is insufficient.
  window.show();
  window.focus();
  window.webContents.focus();
  await waitFor(window, "document.hasFocus()", `${label} focused WebContents`, timeout);
  await evaluate(window, `new Promise((resolve, reject) => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) { reject(new Error('Keyboard target is missing or disabled')); return; }
    const cleanup = () => { clearTimeout(timer); el.removeEventListener('focusin', onFocus); };
    const onFocus = () => {
      cleanup();
      if (document.hasFocus() && document.activeElement === el) resolve(true);
      else reject(new Error('Keyboard target received focusin without document focus'));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for keyboard target focusin')); }, ${timeout});
    el.addEventListener('focusin', onFocus);
    // Require a fresh native event even if a prior hidden .focus() selected it.
    if (document.activeElement === el) el.blur();
    el.focus();
  })`);
}

module.exports = { createSmokeWindow, evaluate, waitFor, settleLayout, resizeViewport, focusForKeyboard };
