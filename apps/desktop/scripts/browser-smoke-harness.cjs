const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../../.desktop-build-temp");
app.setPath("userData", fs.mkdtempSync(path.join(root, "browser-smoke-")));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { DesktopBrowserController } = require(process.argv[2]);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const { validatePublicWebUrl } = await import(pathToFileURL(path.join(root, "browser-policy.mjs")).href);
  const controller = new DesktopBrowserController(window, () => {}, (raw) => validatePublicWebUrl(raw, {}, async () => ["93.184.216.34"]));
  try {
    for (const url of ["file:///C:/secret", "http://example.com", "https://localhost/", "https://127.0.0.1/", "https://user:pass@example.com/"]) await assert.rejects(controller.control({ action: "navigate", url }));
    const view = controller.create();
    await view.webContents.session.protocol.handle("https", (request) => request.url.endsWith('/redirect') ? new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }) : new Response('<!doctype html><title>Offline browser</title><h1>Browser canary</h1>', { headers: { "content-type": "text/html; charset=utf-8" } }));
    const loaded = new Promise((resolve) => view.webContents.once("did-finish-load", resolve));
    await controller.control({ action: "navigate", url: "https://example.com/" }); await loaded;
    assert.equal((await controller.control({ action: "snapshot" })).title, "Offline browser");
    assert.deepEqual(await view.webContents.executeJavaScript('({node:typeof require, process:typeof process, bridge:typeof window.xiuDesktop})'), { node: "undefined", process: "undefined", bridge: "undefined" });
    assert.equal(await view.webContents.executeJavaScript('fetch("https://example.com/write",{method:"POST",body:"no"}).then(()=>true,()=>false)'), false);
    assert.equal(await view.webContents.executeJavaScript('window.open("https://example.com/") === null'), true);
    assert.equal(await view.webContents.executeJavaScript('fetch("https://example.com/redirect").then(()=>true,()=>false)'), false);
    assert.equal(await view.webContents.executeJavaScript('new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve(true), () => resolve(false)))'), false);
    const policy = view.webContents.getLastWebPreferences(); assert.equal(policy.sandbox, true); assert.equal(policy.nodeIntegration, false); assert.equal(policy.preload, undefined);
    await controller.control({ action: "layout", bounds: { x: 40, y: 80, width: 200, height: 200 }, visible: true }); assert.equal(view.getVisible(), true);
    await controller.control({ action: "layout", bounds: { x: 40, y: 80, width: 200, height: 200 }, visible: false }); assert.equal(view.getVisible(), false);
    await assert.rejects(controller.control({ action: "layout", bounds: { x: NaN, y: 0, width: 10, height: 10 }, visible: true }));
    const contents = view.webContents;
    const destroyed = new Promise((resolve) => contents.once("destroyed", resolve));
    controller.close(); await destroyed; assert.equal(contents.isDestroyed(), true); assert.equal((await controller.control({ action: "snapshot" })).url, "");
    console.log("Browser smoke passed: offline HTTPS rendering, URL/POST policy, no Node/preload/task bridge, visibility and close lifecycle.");
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); controller.close(); window.destroy(); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });
