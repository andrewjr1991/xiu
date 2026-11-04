const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const assert = require("node:assert/strict");

const fail = (error) => { console.error(error?.message ?? String(error)); app.exit(1); };
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const fixture = path.resolve(process.argv[2] ?? "");
assert(path.basename(fixture).startsWith("xiu-startup-smoke-"));
const stat = fs.lstatSync(fixture);
assert(stat.isDirectory() && !stat.isSymbolicLink());
// Test-process isolation only. Keep the real main entry and its handlers;
// redirect both Node home selectors and Electron preferences before importing it.
os.homedir = () => fixture;
syncBuiltinESMExports();
app.setPath("userData", path.join(fixture, "desktop"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
let inspected = false;
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-finish-load", async () => {
    if (inspected || !contents.getURL().startsWith("xiu-app://bundle/")) return;
    inspected = true;
    try {
      const actual = await contents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000;
        while (!document.querySelector('.app-shell')) {
          if (Date.now() > deadline) throw new Error('Renderer app did not mount');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const workspace = await window.xiuDesktop.snapshot();
        let providerGate = false;
        try { await window.xiuDesktop.providerSnapshot(); }
        catch (error) { providerGate = error.message.includes('trusted workspace'); }
        return { origin: location.origin, node: typeof require, process: typeof process,
          trust: workspace.trust, bridgeVersion: workspace.bridgeVersion, providerGate };
      })()`);
      const foreign = new BrowserWindow({ show: false, webPreferences: {
        preload: path.resolve(__dirname, "../dist/preload/index.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      } });
      try {
        await foreign.loadURL("data:text/html,<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\"><title>Foreign sender fixture</title>");
        actual.foreignSenderGate = await foreign.webContents.executeJavaScript(`(async () => {
          try { await window.xiuDesktop.snapshot(); return false; }
          catch (error) { return error.message.includes('untrusted renderer'); }
        })()`);
      } finally { foreign.destroy(); }
      fs.writeFileSync(path.join(fixture, "result.json"), JSON.stringify(actual), { mode: 0o600 });
      app.exit(0);
    } catch (error) { fail(error); }
  });
});
// Electron's supported synchronous require(ESM) loads registration before ready.
require(path.resolve(__dirname, "../dist/main/index.js"));
