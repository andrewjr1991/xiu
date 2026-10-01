const pause = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);

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

module.exports = { evaluate, waitFor, settleLayout, resizeViewport };
