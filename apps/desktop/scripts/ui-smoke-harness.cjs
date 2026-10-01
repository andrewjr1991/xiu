const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const smokeRoot = path.resolve(__dirname, "../../..", ".desktop-build-temp");
fs.mkdirSync(smokeRoot, { recursive: true });
const userData = fs.mkdtempSync(path.join(smokeRoot, "ui-smoke-"));
app.setPath("userData", userData);
app.disableHardwareAcceleration();
app.on("will-quit", () => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup: Windows can briefly retain Chromium file handles.
  }
});

const pause = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);
const waitFor = async (window, source, label, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(window, source)) return;
    await pause();
  }
  throw new Error(`Timed out waiting for ${label}.`);
};
const clickText = (window, text, selector = "button") => evaluate(window, `(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find((item)=>item.textContent.trim().includes(${JSON.stringify(text)})); if(!el) throw new Error('Missing ${text}'); el.click(); return true; })()`);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1366, height: 768, useContentSize: true, show: false, webPreferences: { preload: path.join(__dirname, "ui-smoke-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.on("console-message", (event) => console.error(`[renderer] ${event.message}`));
  try {
    await window.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"));
    await waitFor(window, `document.body.innerText.includes('G5C 验收工作区')`, "trusted workspace");
    window.setContentSize(1366, 768);
    await pause(100);
    const desktopViewport = await evaluate(window, `({ width: innerWidth, height: innerHeight })`);
    assert(desktopViewport.width === 1366 && desktopViewport.height === 768, `1366x768 desktop viewport was not created: ${JSON.stringify(desktopViewport)}.`);
    console.log("UI smoke: viewport ready");

    await clickText(window, "每次询问");
    await waitFor(window, `document.querySelector('[role="menu"]')`, "permission menu");
    await clickText(window, "工作区自动");
    await waitFor(window, `window.xiuSmoke.calls().includes('approval-mode:workspace')`, "approval mode selection");
    console.log("UI smoke: approval mode ready");

    await clickText(window, "OpenAI", ".model-selector");
    await waitFor(window, `document.querySelector('[aria-label="选择 Provider 和模型"]')`, "provider picker");
    await clickText(window, "Agnes", ".provider-nav-row > button");
    await waitFor(window, `document.body.innerText.includes('生图模型') && document.body.innerText.includes('视频模型')`, "media model groups");
    await clickText(window, "agnes-image-2.1-flash", ".capability-model-group .model-list button");
    await waitFor(window, `window.xiuSmoke.calls().includes('provider:agnes/image/agnes-image-2.1-flash')`, "image model selection");
    await clickText(window, "agnes-3.0-flash", ".model-list button");
    await waitFor(window, `window.xiuSmoke.calls().includes('provider:agnes/agnes-3.0-flash')`, "provider selection");
    console.log("UI smoke: provider ready");

    await evaluate(window, `(() => { const el=document.querySelector('textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el,'执行长任务验收'); el.dispatchEvent(new Event('input',{bubbles:true})); el.focus(); return true; })()`);
    await evaluate(window, `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`);
    await waitFor(window, `window.xiuSmoke.calls().includes('task:create')`, "keyboard task submission");
    await waitFor(window, `document.body.innerText.includes('写入验收文件')`, "approval card");
    await clickText(window, "仅本次允许");
    await waitFor(window, `document.querySelector('.stop-button')`, "running stop control");
    await waitFor(window, `window.xiuSmoke.calls().includes('long-task:30-turns')`, "30-turn task timeline");
    await clickText(window, "停止", ".stop-button");
    await waitFor(window, `window.xiuSmoke.calls().includes('task:stop')`, "task cancellation");

    await clickText(window, "证据", ".inspector-tabs button");
    await waitFor(window, `document.body.innerText.includes('修改前恢复点')`, "checkpoint evidence");
    await waitFor(window, `document.body.innerText.includes('1 项操作待核验')`, "unknown side-effect recovery gate");
    await clickText(window, "恢复", ".checkpoint-card button");
    await waitFor(window, `window.xiuSmoke.calls().includes('restore:checkpoint-1')`, "checkpoint restore");

    await clickText(window, "终端", ".inspector-tabs button");
    await waitFor(window, `document.querySelector('.terminal-start')`, "terminal start control");
    await clickText(window, "启动终端", ".terminal-start");
    await waitFor(window, `window.xiuSmoke.calls().includes('terminal:start')`, "terminal start");
    await clickText(window, "关闭", ".terminal-stop");
    await waitFor(window, `window.xiuSmoke.calls().includes('terminal:stop')`, "terminal stop");

    window.setContentSize(900, 768);
    await pause(100);
    const narrow = await evaluate(window, `(() => ({ width: innerWidth, consoleDisplay: getComputedStyle(document.querySelector('.task-console')).display, terminalDisplay: getComputedStyle(document.querySelector('.terminal-pane')).display }))()`);
    assert(narrow.width === 900, `Expected 900px viewport, received ${narrow.width}.`);
    assert(narrow.consoleDisplay === "none", "Narrow terminal layout did not hide the task console.");
    assert(narrow.terminalDisplay !== "none", "Narrow terminal layout hid the terminal.");

    window.setContentSize(1366, 768);
    await evaluate(window, `window.xiuSmoke.freshProviders()`);
    await clickText(window, "设置与模型");
    await waitFor(window, `document.body.innerText.includes('尚未添加渠道')`, "zero-provider setup");
    await clickText(window, "新增渠道", ".provider-add");
    await evaluate(window, `(() => { const el=document.querySelector('.provider-form select'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(el,'agnes'); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitFor(window, `document.querySelector('.provider-form input').value === 'Agnes'`, "Agnes template fields");
    await clickText(window, "保存渠道", ".provider-editor footer button");
    await waitFor(window, `window.xiuSmoke.calls().includes('onboarding:add:agnes')`, "first channel save");
    await waitFor(window, `document.querySelector('.provider-nav-row > button')`, "saved channel stays visible");
    await evaluate(window, `document.querySelector('.provider-nav-row button[title="删除渠道"]').click()`);
    await waitFor(window, `document.querySelector('.provider-delete-confirm')`, "last channel delete confirmation");
    await clickText(window, "删除渠道", ".provider-delete-confirm button");
    await waitFor(window, `document.body.innerText.includes('尚未添加渠道') && window.xiuSmoke.calls().includes('onboarding:delete:agnes')`, "return to zero-provider setup");

    const calls = await evaluate(window, `window.xiuSmoke.calls()`);
    console.log(JSON.stringify({ passed: true, viewports: ["1366x768", "900x768"], workflows: ["keyboard-submit", "provider-model", "provider-media-model", "approval", "30-turn-task", "stop", "unknown-side-effect-gate", "checkpoint-restore", "terminal-lifecycle", "zero-provider-onboarding", "add-agnes-template", "delete-last-provider"], calls }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? String(error));
    app.exit(1);
  }
});
