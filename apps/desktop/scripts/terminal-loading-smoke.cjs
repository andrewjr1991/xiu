const { app, BrowserWindow, net, protocol } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createSmokeWindow, evaluate, waitFor } = require("./ui-smoke-helpers.cjs");

const smokeRoot = path.resolve(__dirname, "../../..", ".desktop-build-temp");
fs.mkdirSync(smokeRoot, { recursive: true });
const userData = fs.mkdtempSync(path.join(smokeRoot, "terminal-loading-"));
app.setPath("userData", userData);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
protocol.registerSchemesAsPrivileged([{
  scheme: "xiu-app", privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);
app.on("will-quit", () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* Chromium may retain handles briefly. */ }
});

app.whenReady().then(async () => {
  // Serve only the exact build files from the same origin and CSP as production.
  const root = path.resolve(__dirname, "../dist/renderer");
  const assets = new Map(fs.readdirSync(root, { recursive: true }).flatMap((name) => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? [[`/${name.split(path.sep).join("/")}`, file]] : [];
  }));
  let failTerminal = true;
  let requests = 0;
  protocol.handle("xiu-app", (request) => {
    const url = new URL(request.url);
    const file = url.host === "bundle" ? assets.get(url.pathname) : undefined;
    if (!file) return new Response("Not found", { status: 404 });
    if (path.basename(file).startsWith("InteractiveTerminal-")) {
      requests++;
      if (failTerminal) return new Response("Unavailable", { status: 503 });
    }
    return net.fetch(pathToFileURL(file).toString()).catch((error) => {
      console.error("Terminal smoke asset read failed:", error.message);
      throw error;
    });
  });
  let window;
  try {
    for (const failure of [true, false]) {
      failTerminal = failure;
      requests = 0;
      window = createSmokeWindow(BrowserWindow, path.join(__dirname, "ui-smoke-preload.cjs"));
      await window.loadURL("xiu-app://bundle/index.html");
      await waitFor(window, `document.body.innerText.includes('G5C 验收工作区')`, "workspace");
      assert.equal(requests, 0, "Terminal must not load on startup.");
      await evaluate(window, `document.querySelector('[aria-label="打开标签页"]').click()`);
      await waitFor(window, `document.querySelector('.workbench-launcher')`, "tool launcher");
      await evaluate(window, `[...document.querySelectorAll('.workbench-launcher button')].find(el => el.textContent.includes('终端')).click()`);
      if (failure) {
        await waitFor(window, `document.querySelector('[role="alert"]')?.textContent.includes('终端组件加载失败')`, "local load error");
        assert(await evaluate(window, `Boolean(document.querySelector('.composer textarea'))`), "Load failure must preserve the conversation.");
        await evaluate(window, `document.querySelector('[aria-label="关闭终端"]').click()`);
        await waitFor(window, `!document.querySelector('[role="alert"]')`, "close failed terminal");
      } else {
        await waitFor(window, `document.querySelector('.terminal-start')`, "loaded terminal");
        assert(!(await evaluate(window, `window.xiuSmoke.calls().includes('terminal:start')`)), "Loading must not start a shell.");
        await evaluate(window, `document.querySelector('.terminal-start').click()`);
        await waitFor(window, `window.xiuSmoke.calls().includes('terminal:start')`, "explicit terminal start");
        await evaluate(window, `document.querySelector('[aria-label="关闭终端"]').click()`);
        await waitFor(window, `window.xiuSmoke.calls().includes('terminal:stop')`, "terminal tab close stops shell");
      }
      assert(requests > 0, "Opening terminal must request its chunk.");
      if (failure) assert(!(await evaluate(window, `window.xiuSmoke.calls().some(call => call.startsWith('terminal:'))`)), "Failed component must not execute terminal operations.");
      assert.equal(await evaluate(window, `typeof require`), "undefined", "Renderer must remain isolated.");
      window.destroy();
      window = undefined;
    }
    console.log("Terminal loading smoke passed: deferred load, same-origin CSP, local failure, explicit start and close.");
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? String(error));
    window?.destroy();
    app.exit(1);
  }
}).catch((error) => { console.error(error?.stack ?? String(error)); app.exit(1); });
