const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
// A detached Windows GUI launch can lose its parent's output pipe. Treat that
// as a failed test run and exit, instead of triggering Electron error dialogs.
for (const stream of [process.stdout, process.stderr]) stream.on("error", (error) => {
  if (error.code === "EPIPE") app.exit(1);
  else throw error;
});
const { createSmokeWindow, evaluate, waitFor, settleLayout, resizeViewport, focusForKeyboard } = require("./ui-smoke-helpers.cjs");

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

const clickText = (window, text, selector = "button") => evaluate(window, `(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find((item)=>item.textContent.trim().includes(${JSON.stringify(text)})); if(!el) throw new Error('Missing ${text}'); el.click(); return true; })()`);
const chooseOption = async (window, selector, label) => {
  await settleLayout(window);
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitFor(window, `Boolean(document.querySelector('.xiu-select-menu'))`, `custom menu for ${label}`);
  await waitFor(window, `[...document.querySelectorAll('.xiu-select-menu [role="option"]')].some(el => el.textContent.includes(${JSON.stringify(label)}))`, `custom menu option ${label}`);
  assert(await evaluate(window, `(() => { const r=document.querySelector('.xiu-select-menu').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()`), "Custom menu should remain inside the viewport.");
  if (label === '执行轮次 1') await fs.promises.writeFile(path.join(smokeRoot, "workbench-menu-1366.png"), (await window.webContents.capturePage()).toPNG());
  await clickText(window, label, '.xiu-select-menu [role="option"]');
};
const openTool = async (window, label) => {
  await evaluate(window, `document.querySelector('[aria-label="打开标签页"]').click()`);
  await clickText(window, label, '.workbench-launcher button');
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const composerSelector = ".composer textarea";
const setComposerText = (window, text) => evaluate(window, `(() => {
  const el = document.querySelector(${JSON.stringify(composerSelector)});
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); return true;
})()`);

// Synthetic composition verifies renderer wiring only. It does not stand in for
// the Windows/macOS/Linux native candidate-window acceptance matrix.
const checkComposerIme = async (window, label) => {
  await focusForKeyboard(window, composerSelector, label);
  await resizeViewport(window, 1366, 768, `${label} focused desktop viewport`);
  const text = `${label}中文候选词`;
  await setComposerText(window, text);
  const before = await evaluate(window, `window.xiuSmoke.calls().filter(call => call === 'task:create' || call === 'task:steer').length`);
  const result = await evaluate(window, `(() => {
    const el = document.querySelector(${JSON.stringify(composerSelector)});
    const compose = type => el.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: '中文' }));
    const key = (type, extra = {}) => el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...extra }));
    // Candidate selection with normal ordering and with missing native flags.
    compose('compositionstart'); key('keydown', { isComposing: true }); compose('compositionend'); key('keyup');
    compose('compositionstart'); key('keydown'); compose('compositionend'); key('keyup');
    // Native and legacy fallbacks also protect input when lifecycle events are absent.
    key('keydown', { isComposing: true }); key('keyup');
    key('keydown', { keyCode: 229 }); key('keyup');
    key('keydown', { key: 'Process', keyCode: 229 }); key('keyup');
    // WebKit/IME ordering: compositionend can arrive before the committing Enter.
    compose('compositionstart'); compose('compositionend'); key('keydown'); key('keyup');
    const shiftEnterAllowed = key('keydown', { shiftKey: true }); key('keyup', { shiftKey: true });
    return { value: el.value, shiftEnterAllowed };
  })()`);
  const after = await evaluate(window, `window.xiuSmoke.calls().filter(call => call === 'task:create' || call === 'task:steer').length`);
  assert(after === before, `${label}: IME confirmation accidentally created or steered a task.`);
  assert(result.value === text, `${label}: IME confirmation cleared the draft.`);
  assert(result.shiftEnterAllowed, `${label}: Shift+Enter default newline was cancelled.`);
  assert(await evaluate(window, `!document.querySelector('.pending-message')`), `${label}: IME confirmation created a pending task message.`);

  // Empty text lets us inspect Enter cancellation without actually starting a
  // task. A reset must allow normal submission immediately, with no cooldown.
  await setComposerText(window, "");
  const cleaned = await evaluate(window, `(() => {
    const el = document.querySelector(${JSON.stringify(composerSelector)});
    const begin = () => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const end = () => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const enter = () => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    begin(); el.blur(); el.focus(); const blur = enter();
    begin(); end(); window.dispatchEvent(new Event('blur')); const windowBlur = enter();
    begin(); end(); el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true })); const release = enter();
    return { blur, windowBlur, release };
  })()`);
  assert(cleaned.blur && cleaned.windowBlur && cleaned.release, `${label}: stale IME state swallowed a deliberate Enter after focus/key release cleanup: ${JSON.stringify(cleaned)}.`);

  await setComposerText(window, "第一行");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers: ["shift"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["shift"] });
  await waitFor(window, `document.querySelector(${JSON.stringify(composerSelector)}).value.includes('\\n')`, `${label} Shift+Enter inserts a newline`);
  assert(await evaluate(window, `window.xiuSmoke.calls().filter(call => call === 'task:create' || call === 'task:steer').length === ${before}`), `${label}: Shift+Enter unexpectedly submitted the task.`);
  console.log(`UI smoke: ${label} IME lifecycle/native fallbacks, end-before-Enter, cleanup, and Shift+Enter ready`);
};

app.whenReady().then(async () => {
  const window = createSmokeWindow(BrowserWindow, path.join(__dirname, "ui-smoke-preload.cjs"));
  window.webContents.on("console-message", (event) => console.error(`[renderer] ${event.message}`));
  try {
    await window.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"));
    await evaluate(window, `(() => {
      window.xiuSmokeLayoutEvents = [];
      for (const type of ['resize', 'scroll', 'focusin', 'focusout', 'blur']) window.addEventListener(type, (event) => {
        window.xiuSmokeLayoutEvents.push({ type, at: performance.now(), target: event.target?.nodeName,
          className: typeof event.target?.className === 'string' ? event.target.className : undefined,
          width: innerWidth, height: innerHeight, menuOpen: Boolean(document.querySelector('.xiu-select-menu')) });
        window.xiuSmokeLayoutEvents = window.xiuSmokeLayoutEvents.slice(-40);
      }, true);
      return true;
    })()`);
    await waitFor(window, `document.body.innerText.includes('G5C 验收工作区')`, "trusted workspace");
    await resizeViewport(window, 1366, 768, "desktop viewport resize");
    const desktopViewport = await evaluate(window, `({ width: innerWidth, height: innerHeight })`);
    assert(desktopViewport.width === 1366 && desktopViewport.height === 768, `1366x768 desktop viewport was not created: ${JSON.stringify(desktopViewport)}.`);
    console.log("UI smoke: viewport ready");
    await clickText(window, "设置", ".sidebar-footer");
    await waitFor(window, `Boolean(document.querySelector('.settings-page'))`, "settings center");
    await clickText(window, "深色", ".theme-options button");
    await waitFor(window, `document.documentElement.dataset.theme === 'dark'`, "dark theme applied");
    assert(await evaluate(window, `['.workspace-header','.inspector-tabs'].every(selector=>{ const el=document.querySelector(selector); if(!el) return false; const rgb=getComputedStyle(el).backgroundColor.match(/[\\d.]+/g).slice(0,3).map(Number); return Math.max(...rgb)<70; })`), "Dark workspace header and inspector tabs must not retain translucent white surfaces");
    assert(await evaluate(window, `(() => { const root=document.createElement('div'); document.body.append(root); try { return Array.from({length:6},(_,i)=>{ const el=document.createElement('span');el.className='agent-avatar avatar-'+i;root.append(el);const style=getComputedStyle(el);return style.backgroundImage==='none' && Math.max(...style.backgroundColor.match(/\\d+/g).slice(0,3).map(Number))<90 && style.color!==style.backgroundColor; }).every(Boolean); } finally {root.remove();} })()`), "All six dark avatar palettes use matte low-brightness surfaces");
    await waitFor(window, `!document.querySelector('.theme-options button').disabled`, "theme saved");
    window.showInactive();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.app-shell')).backgroundColor === 'rgb(24, 26, 29)'`), "Dark main background");
    await settleLayout(window);
    assert(await evaluate(window, `Array.from(document.querySelectorAll('.setting-row')).every(row => row.getBoundingClientRect().height < 140 && row.firstElementChild.getBoundingClientRect().width > 150)`), "Settings labels retain readable width");
    await fs.promises.writeFile(path.join(smokeRoot, 'settings-dark-1366.png'), (await window.webContents.capturePage()).toPNG());
    await resizeViewport(window, 900, 768, "settings narrow");
    assert(await evaluate(window, `document.documentElement.scrollWidth <= innerWidth && document.querySelector('.settings-page').getBoundingClientRect().right <= innerWidth`), "Settings fit narrow viewport");
    await fs.promises.writeFile(path.join(smokeRoot, 'settings-dark-900.png'), (await window.webContents.capturePage()).toPNG());
    await chooseOption(window, '[aria-label="界面字号"]', '16 px');
    await waitFor(window, `document.documentElement.style.getPropertyValue('--ui-scale') === String(16/14)`, "font preference applied");
    await chooseOption(window, '[aria-label="代码字号"]', '14 px');
    await waitFor(window, `document.documentElement.style.getPropertyValue('--code-size') === '14px'`, "code font applied");
    await chooseOption(window, '[aria-label="布局密度"]', '紧凑');
    await waitFor(window, `document.documentElement.dataset.density === 'compact'`, "compact preference applied");
    await clickText(window, "恢复本页默认设置", ".settings-reset");
    await waitFor(window, `document.documentElement.dataset.density === 'comfortable'`, "appearance reset");
    await clickText(window, "对话与运行", ".settings-nav button");
    await evaluate(window, `document.querySelector('[aria-label="自动跟随最新进展"]').click()`);
    await waitFor(window, `document.querySelector('[aria-label="自动跟随最新进展"]').getAttribute('aria-checked') === 'false'`, "follow preference disabled");
    await waitFor(window, `Boolean(document.querySelector('.return-to-latest'))`, "manual jump available without continuous following");
    await evaluate(window, `document.querySelector('.return-to-latest').click()`);
    assert(await evaluate(window, `Boolean(document.querySelector('.return-to-latest'))`), "Manual jump does not overwrite disabled follow preference");
    await waitFor(window, `!document.querySelector('[aria-label="自动跟随最新进展"]').disabled`, "follow save settled");
    await evaluate(window, `document.querySelector('[aria-label="自动跟随最新进展"]').click()`);
    await waitFor(window, `!document.querySelector('.return-to-latest')`, "follow preference restored");
    await waitFor(window, `!document.querySelector('[aria-label="自动跟随最新进展"]').disabled`, "follow restore saved");
    await chooseOption(window, '[aria-label="发送快捷键"]', 'Ctrl / ⌘ + Enter 发送');
    await waitFor(window, `!document.querySelector('[aria-label="发送快捷键"]').disabled`, "send preference saved");
    await evaluate(window, `document.querySelector('[aria-label="关闭设置"]').click()`);
    const shortcut = await evaluate(window, `(() => { const el=document.querySelector('.composer textarea'); const key=(ctrlKey=false)=>!el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',ctrlKey,bubbles:true,cancelable:true})); return {normal:key(), modified:key(true)}; })()`);
    assert(!shortcut.normal && shortcut.modified, "Configured send shortcut keeps Enter newline and submits modified Enter");
    await clickText(window, "设置", ".sidebar-footer");
    await clickText(window, "对话与运行", ".settings-nav button");
    await chooseOption(window, '[aria-label="发送快捷键"]', 'Enter 发送');
    await clickText(window, "通知", ".settings-nav button");
    assert(await evaluate(window, `document.querySelectorAll('.settings-page [role="switch"]').length === 4`), "Notification controls");
    await clickText(window, "关于", ".settings-nav button");
    await waitFor(window, `document.querySelector('.settings-body').innerText.includes('0.20.6')`, "actual version");
    await clickText(window, "外观", ".settings-nav button");
    await clickText(window, "深色", ".theme-options button");
    await waitFor(window, `!document.querySelector('.theme-options button').disabled`, "dark workbench saved");
    await evaluate(window, `document.querySelector('[aria-label="关闭设置"]').click()`);
    await resizeViewport(window, 1366, 768, "dark workbench wide");
    await fs.promises.writeFile(path.join(smokeRoot, 'workbench-dark-1366.png'), (await window.webContents.capturePage()).toPNG());
    await resizeViewport(window, 900, 768, "dark workbench narrow");
    await fs.promises.writeFile(path.join(smokeRoot, 'workbench-dark-900.png'), (await window.webContents.capturePage()).toPNG());
    await clickText(window, "设置", ".sidebar-footer");
    await clickText(window, "浅色", ".theme-options button");
    await waitFor(window, `document.documentElement.dataset.theme === 'light'`, "light theme restore");
    await evaluate(window, `document.querySelector('[aria-label="关闭设置"]').click()`);
    await resizeViewport(window, 1366, 768, "settings viewport restore");
    const checkManagement = async (label) => {
      await evaluate(window, `document.querySelector('.workspace-toolbar [aria-label="工具与运行设置"]').click()`);
      await waitFor(window, "Boolean(document.querySelector('.management-panel'))", "management mounted");
      await waitFor(window, "!document.querySelector('.management-panel [aria-label=\"检索认证方式\"]').disabled", "web settings ready");
      await chooseOption(window, '.management-panel [aria-label="检索认证方式"]', "自定义服务");
      assert(await evaluate(window, "document.querySelector('.management-panel').textContent.includes('密钥环境变量名')"), "Custom search credential reference field missing.");
      await chooseOption(window, '.management-panel [aria-label="检索认证方式"]', "Xiu 托管搜索");
      assert(await evaluate(window, "!document.querySelector('.management-panel').textContent.includes('密钥环境变量名') && document.querySelector('.management-panel').textContent.includes('首次检索时自动注册设备')"), "Managed mode must hide manual credentials and explain lazy enrollment.");
      await clickText(window, "保存检索配置", '.management-panel button');
      await waitFor(window, "!document.querySelector('.management-panel [aria-label=\"关闭管理面板\"]').disabled", "managed settings saved");
      assert(await evaluate(window, "window.xiuSmoke.calls().includes('management:web:managed')"), "Managed configuration was not saved explicitly.");
      await waitFor(window, "document.querySelector('.management-panel [aria-label=\"检索认证方式\"]').textContent.includes('Xiu 托管搜索') && !document.querySelector('.management-panel').textContent.includes('密钥环境变量名')", "managed selection survives reconfiguration");
      await settleLayout(window);
      await fs.promises.writeFile(path.join(smokeRoot, `managed-search-${label}.png`), (await window.webContents.capturePage()).toPNG());
      await clickText(window, "模型路由", '.management-panel nav button');
      await waitFor(window, "Boolean(document.querySelector('.management-panel [aria-label=\"主渠道\"]'))", "routing fields ready");
      assert(await evaluate(window, "(() => {const r=document.querySelector('.management-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()"), "Management dialog exceeds viewport.");
      await clickText(window, "Skills", '.management-panel nav button');
      await waitFor(window, "[...document.querySelectorAll('.management-panel nav button')].some(el => el.textContent === 'Skills' && el.getAttribute('aria-pressed') === 'true')", "Skills tab selected");
      await clickText(window, "选择文件夹并预览", '.management-panel button');
      await waitFor(window, "Boolean(document.querySelector('[aria-label=\"技能安装预览\"]'))", "skill permission preview");
      await clickText(window, "取消预览", '.management-panel button');
      await clickText(window, "选择 SKILL.md / ZIP 并预览", '.management-panel button');
      await waitFor(window, "Boolean(document.querySelector('[aria-label=\"技能安装预览\"]'))", "skill file preview");
      assert(await evaluate(window, "window.xiuSmoke.calls().includes('skill-prepare:directory') && window.xiuSmoke.calls().includes('skill-prepare:file')"), "Skill picker intent did not reach the bridge.");
      await settleLayout(window);
      await fs.promises.writeFile(path.join(smokeRoot, `skill-import-${label}.png`), (await window.webContents.capturePage()).toPNG());
      await clickText(window, "取消预览", '.management-panel button');
      await clickText(window, "报告与诊断", '.management-panel nav button');
      await waitFor(window, "document.querySelector('.management-panel').textContent.includes('本机执行报告 fixture')", "bounded local report");
      await settleLayout(window);
      await fs.promises.writeFile(path.join(smokeRoot, `management-${label}.png`), (await window.webContents.capturePage()).toPNG());
      await evaluate(window, "document.querySelector('[aria-label=\"关闭管理面板\"]').click()");
      await waitFor(window, "!document.querySelector('.management-panel')", "management closed");
    };
    await checkManagement("1366");
    window.webContents.setZoomFactor(1.25);
    await checkManagement("zoom125");
    window.webContents.setZoomFactor(1);
    const checkInspectorLayout = async () => {
      assert(await evaluate(window, `[...document.querySelectorAll('.inspector-tabs button')].every(el => getComputedStyle(el).whiteSpace === 'nowrap' && getComputedStyle(el).flexShrink === '0')`), "Inspector tabs can wrap or shrink into vertical text.");
      assert(await evaluate(window, `(() => { const el=document.querySelector('.task-console'); return el.scrollWidth <= el.clientWidth + 1; })()`), "Conversation overflows its grid column.");
      assert(await evaluate(window, `parseFloat(getComputedStyle(document.querySelector('[aria-label="搜索变更文件"]')).borderTopLeftRadius) >= 6 && parseFloat(getComputedStyle(document.querySelector('[aria-label="执行轮次"]')).borderTopLeftRadius) >= 6`), "Diff controls lost workbench styling.");
    };
    const checkStableTabs = async () => {
      const splitter = await evaluate(window, `(() => { const r=document.querySelector('.task-splitter').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+100)}; })()`);
      const beforeDrag = await evaluate(window, `document.querySelector('.task-console').getBoundingClientRect().width`);
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:splitter.x,y:splitter.y,button:'left',buttons:1,clickCount:1});
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:splitter.x+40,y:splitter.y,button:'left',buttons:1});
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:splitter.x+40,y:splitter.y,button:'left',buttons:0,clickCount:1});
      window.webContents.debugger.detach();
      await settleLayout(window);
      assert(await evaluate(window, `document.querySelector('.task-console').getBoundingClientRect().width > ${beforeDrag} + 20`), "Dragging divider did not resize the conversation.");
      const width = await evaluate(window, `document.querySelector('.review-inspector').getBoundingClientRect().width`);
      for (const label of ['文件', '终端', '子智能体', '数据', '证据', '变更']) {
        await openTool(window, label);
        assert(await evaluate(window, `Math.abs(document.querySelector('.review-inspector').getBoundingClientRect().width - ${width}) < 1`), "Switching tool tabs changed the pane width.");
      }
      assert(await evaluate(window, `(() => { const pane=document.querySelector('.review-inspector').getBoundingClientRect(); return [...document.querySelectorAll('.workbench-actions button')].every(el => { const r=el.getBoundingClientRect(); return r.left >= pane.left && r.right <= pane.right && r.width > 0; }); })()`), "Overflowing tabs hid fixed workbench controls.");
      await evaluate(window, `document.querySelector('.workbench-tab-strip').scrollLeft=10000`);
      assert(await evaluate(window, `document.querySelector('.workbench-actions').getBoundingClientRect().right <= document.querySelector('.review-inspector').getBoundingClientRect().right`), "Scrolling tabs moved the toolbar offscreen.");
      await evaluate(window, `document.querySelector('[aria-label="收起侧栏"]').click()`);
      await settleLayout(window);
      assert(await evaluate(window, `document.querySelector('.task-overview') ? getComputedStyle(document.querySelector('.inspector-tabs')).display === 'none' : getComputedStyle(document.querySelector('.review-inspector')).display === 'none' && document.querySelector('.review-inspector').getBoundingClientRect().width === 0`), "Collapsed sidebar retains useful summary only, never an empty rail.");
      assert(await evaluate(window, `Boolean(document.querySelector('.workspace-header [aria-label="展开侧栏"]')) && (Boolean(document.querySelector('.task-overview')) || Math.abs(document.querySelector('.task-console').getBoundingClientRect().width-document.querySelector('.task-layout').getBoundingClientRect().width) < 1)`), "Collapsed empty workbench returns all width and moves reopen to header.");
      await fs.promises.writeFile(path.join(smokeRoot, 'workbench-collapsed-' + (await evaluate(window, 'innerWidth')) + '.png'), (await window.webContents.capturePage()).toPNG());
      assert(await evaluate(window, `document.querySelector('.task-console').getBoundingClientRect().width > ${width}`), "Collapsed sidebar did not return space to conversation.");
      await evaluate(window, `document.querySelector('.workspace-header [aria-label="展开侧栏"]').click()`);
      await settleLayout(window);
      assert(await evaluate(window, `Math.abs(document.querySelector('.review-inspector').getBoundingClientRect().width - ${width}) < 1`), "Sidebar expansion lost original width.");
      await evaluate(window, `document.querySelector('.task-splitter').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await settleLayout(window);
    };
    await checkInspectorLayout();
    await fs.promises.writeFile(path.join(smokeRoot, "inspector-ui-1366.png"), (await window.webContents.capturePage()).toPNG());
    await resizeViewport(window, 900, 768, "inspector narrow resize");
    await checkManagement("900");
    await checkInspectorLayout();
    await fs.promises.writeFile(path.join(smokeRoot, "inspector-ui-900.png"), (await window.webContents.capturePage()).toPNG());
    await resizeViewport(window, 1366, 768, "inspector wide restore");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="独立 Diff 面板"]'))`, "independent Diff panel");
    await evaluate(window, `document.querySelector('[aria-label="执行轮次"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    await waitFor(window, `Boolean(document.querySelector('.xiu-select-menu'))`, "keyboard opens menu");
    await evaluate(window, `document.querySelector('.xiu-select-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitFor(window, `!document.querySelector('.xiu-select-menu') && document.activeElement === document.querySelector('[aria-label="执行轮次"]')`, "Escape returns focus");
    await waitFor(window, `document.querySelector('.changes-tree').innerText.includes('example.ts') && document.querySelector('.changes-diff').innerText.includes('new')`, "Diff file tree and lines");
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.diff-lines .diff-line')).display === 'flex'`), "Diff gutter/code alignment was overridden by old preview styles.");
    assert(await evaluate(window, `document.querySelectorAll('.changes-diff .diff-line').length <= 250 && document.querySelector('.changes-diff').innerText.includes('完整 Diff')`), "Complete Diff must paginate rather than truncate or overgrow the DOM.");
    await clickText(window, "末页", ".changes-diff button");
    await waitFor(window, `[...document.querySelectorAll('.changes-diff code')].at(-1)?.textContent.endsWith('x'.repeat(400)) && document.querySelector('.changes-diff').innerText.includes('full-review-tail-canary')`, "full Diff last page and untruncated long line");
    await chooseOption(window, '[aria-label="执行轮次"]', '执行轮次 1');
    await waitFor(window, `document.querySelector('.changes-diff').innerText.includes('round-one-canary')`, "saved execution round Diff");
    await clickText(window, "example.ts", ".changes-tree button");
    await waitFor(window, `document.querySelector('[aria-label="执行轮次"]').textContent.includes('执行轮次 1')`, "file selection preserves historical round");
    await chooseOption(window, '[aria-label="执行轮次"]', '无快照');
    await waitFor(window, `document.querySelector('[aria-label="独立 Diff 面板"]').innerText.includes('该轮没有保存变更快照') && !document.querySelector('.changes-diff')`, "missing round never shows current Diff");
    await chooseOption(window, '[aria-label="执行轮次"]', '当前视图');
    await evaluate(window, `(() => { const input=document.querySelector('[aria-label="搜索变更文件"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'missing-file'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await waitFor(window, `document.querySelector('.changes-tree').innerText.includes('没有匹配的文件')`, "Diff search filter");
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.tree-empty')).fontFamily === getComputedStyle(document.documentElement).fontFamily`), "Empty-state font should match the app.");
    assert(await evaluate(window, `parseFloat(getComputedStyle(document.querySelector('.changes-diff > .empty-note')).paddingLeft) >= 16`), "Diff empty state should have space from the divider.");
    await evaluate(window, `(() => { const input=document.querySelector('[aria-label="搜索变更文件"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,''); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);

    await clickText(window, "MCP 连接与权限", ".sidebar-mcp");
    await waitFor(window, `document.querySelector('.mcp-server-details')`, "MCP compact view");
    assert(await evaluate(window, `!document.querySelector('.mcp-server-details').open`), "MCP details must start collapsed.");
    await evaluate(window, `document.querySelector('.mcp-server-details summary').click()`);
    await waitFor(window, `document.body.innerText.includes('process:execute')`, "MCP permission view");
    const mcpStyles = await evaluate(window, `(() => {
      const sidebar = getComputedStyle(document.querySelector('.sidebar-mcp'));
      const buttons = [...document.querySelectorAll('.mcp-panel button')];
      const backdrop = document.querySelector('.mcp-panel').closest('.dialog-backdrop').getBoundingClientRect();
      return { sidebarBorder: sidebar.borderTopWidth, buttonsBorderless: buttons.every(b => getComputedStyle(b).borderTopWidth === '0px'), top: backdrop.top, text: document.querySelector('.mcp-panel').innerText };
    })()`);
    assert(mcpStyles.sidebarBorder === "0px" && mcpStyles.buttonsBorderless, "MCP buttons retained native borders.");
    assert(mcpStyles.top === 56, "Modal backdrop must leave the entire native titlebar unobscured.");
    assert(!/CLI/.test(mcpStyles.text), "Desktop MCP copy leaked implementation terminology.");
    await clickText(window, "核对并授权", ".mcp-panel button");
    await clickText(window, "确认此权限清单", ".mcp-panel button");
    await waitFor(window, `window.xiuSmoke.calls().includes('mcp:approve:smoke')`, "MCP exact manifest approval");
    await clickText(window, "连接 / 重载", ".mcp-panel button");
    await waitFor(window, `document.querySelector('.mcp-panel').innerText.includes('2 个工具')`, "MCP tool connection");
    await clickText(window, "资源列表", ".mcp-panel button");
    await waitFor(window, `document.querySelector('[aria-label="MCP 外部内容"]').innerText.includes('external-resource-canary')`, "MCP untrusted resource display");
    await clickText(window, "提示词列表", ".mcp-panel button");
    await waitFor(window, `window.xiuSmoke.calls().includes('mcp:browse:prompts')`, "MCP prompt browser");
    await clickText(window, "OAuth 登录", ".mcp-panel button");
    await waitFor(window, `document.querySelector('[aria-label="OAuth 授权状态"]').innerText.includes('https://auth.test')`, "OAuth origin confirmation");
    await clickText(window, "确认并打开浏览器", ".mcp-panel button");
    await waitFor(window, `document.querySelector('[aria-label="OAuth 授权状态"] textarea')?.value.includes('state=ui-test')`, "OAuth browser fallback URL");
    await clickText(window, "取消登录", ".mcp-panel button");
    await waitFor(window, `document.querySelector('[aria-label="OAuth 授权状态"]').innerText.includes('登录已取消')`, "OAuth cancellation");
    await clickText(window, "新增 MCP", ".mcp-actions button");
    await waitFor(window, `Boolean(document.querySelector('.mcp-editor'))`, "MCP add form");
    await evaluate(window, `(() => {const fields=document.querySelectorAll('.mcp-editor input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(fields[0],'ui-added');fields[0].dispatchEvent(new Event('input',{bubbles:true}));setter.call(fields[1],'node');fields[1].dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await clickText(window, "保存配置", ".mcp-editor button");
    await waitFor(window, `window.xiuSmoke.calls().includes('mcp:save:ui-added') && !document.querySelector('.mcp-editor')`, "MCP save without implicit connection");
    await evaluate(window, `[...document.querySelectorAll('.mcp-server-details')].forEach(detail => detail.open = true)`);
    await clickText(window, "编辑 ui-added", ".mcp-panel button");
    await waitFor(window, `document.querySelector('.mcp-editor input')?.disabled`, "MCP immutable edit identity");
    await clickText(window, "保存配置", ".mcp-editor button");
    await waitFor(window, `!document.querySelector('.mcp-editor')`, "MCP edit save");
    await clickText(window, "删除 ui-added", ".mcp-panel button");
    await clickText(window, "确认删除", ".mcp-panel button");
    await waitFor(window, `window.xiuSmoke.calls().includes('mcp:delete:ui-added') && !document.querySelector('.mcp-panel').innerText.includes('ui-added')`, "MCP confirmed deletion");
    await resizeViewport(window, 900, 768, "MCP narrow viewport resize");
    const mcpFits = await evaluate(window, `(() => { const r=document.querySelector('.mcp-panel').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
    assert(mcpFits, "MCP panel escaped the narrow viewport.");
    await resizeViewport(window, 1366, 768, "MCP desktop viewport restore");
    await clickText(window, "断开全部", ".mcp-panel button");
    await waitFor(window, `window.xiuSmoke.calls().includes('mcp:disconnect')`, "MCP disconnect");
    await evaluate(window, `document.querySelector('[aria-label="关闭 MCP"]').click()`);
    console.log("UI smoke: MCP permission/connection lifecycle ready (including 900px viewport)");

    await clickText(window, "请求批准");
    await waitFor(window, `document.querySelector('[role="menu"]')`, "permission menu");
    await clickText(window, "帮我批准");
    await waitFor(window, `window.xiuSmoke.calls().includes('approval-mode:workspace')`, "approval mode selection");
    console.log("UI smoke: approval mode ready");

    await waitFor(window, `document.querySelector('.plan-mode-selector')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('.plan-mode-selector').disabled`, "idle execute mode");
    const executeHeight = await evaluate(window, `document.querySelector('.plan-mode-selector').getBoundingClientRect().height`);
    await evaluate(window, `document.querySelector('.plan-mode-selector').click()`);
    await waitFor(window, `document.querySelector('.plan-mode-selector').getAttribute('aria-pressed') === 'true' && document.querySelector('.plan-mode-note').innerText.includes('完全访问也不例外')`, "Plan read-only guidance");
    assert(await evaluate(window, `document.querySelector('.plan-mode-selector').getBoundingClientRect().height === ${executeHeight}`), "Execute and Plan controls have different heights.");
    await evaluate(window, `document.querySelector('.permission-selector').click()`);
    await clickText(window, "完全访问权限", '.permission-popover button');
    await waitFor(window, `document.querySelector('.permission-selector').classList.contains('mode-full')`, "full access fixture selection");
    assert(await evaluate(window, `document.querySelector('.plan-mode-selector').getAttribute('aria-pressed') === 'true' && Boolean(document.querySelector('.plan-mode-note'))`), "Full Access must not turn off Plan read-only mode.");
    await evaluate(window, `document.querySelector('.plan-mode-selector').click()`);
    await waitFor(window, `document.querySelector('.plan-mode-selector').getAttribute('aria-pressed') === 'false' && !document.querySelector('.plan-mode-note')`, "return to execute mode");
    assert(await evaluate(window, `document.querySelector('.permission-selector').classList.contains('mode-full')`), "Plan mode must not silently change the independent approval mode.");
    await evaluate(window, `document.querySelector('.permission-selector').click()`);
    await clickText(window, "帮我批准", '.permission-popover button');
    await waitFor(window, `document.querySelector('.permission-selector').classList.contains('mode-workspace')`, "restore workspace approval mode");
    console.log("UI smoke: Plan mode toggles with revised context and remains independent of Full Access");

    await clickText(window, "OpenAI", ".model-selector");
    await waitFor(window, `document.querySelector('[aria-label="选择 Provider 和模型"]')`, "provider picker");
    for (const width of [1366, 900]) {
      await resizeViewport(window, width, 768, 'provider actions layout');
      assert(await evaluate(window, `[...document.querySelectorAll('.provider-actions button')].every(el => getComputedStyle(el).whiteSpace === 'nowrap' && el.scrollWidth <= el.clientWidth + 1)`), 'Provider action labels wrap or clip.');
      assert(await evaluate(window, `(() => { const el=document.querySelector('.sidebar-utilities'); return el.getBoundingClientRect().height < 150 && el.getBoundingClientRect().bottom <= innerHeight; })()`), 'Sidebar utility entries are spread apart or outside the viewport.');
      await fs.promises.writeFile(path.join(smokeRoot, 'provider-layout-' + width + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    await resizeViewport(window, 1366, 768, 'provider wide restore');
    await clickText(window, "Agnes", ".provider-nav-row > button");
    await waitFor(window, `document.body.innerText.includes('生图模型') && document.body.innerText.includes('视频模型')`, "media model groups");
    await clickText(window, "agnes-image-2.1-flash", ".capability-model-group .model-list button");
    await waitFor(window, `window.xiuSmoke.calls().includes('provider:agnes/image/agnes-image-2.1-flash')`, "image model selection");
    await clickText(window, "agnes-3.0-flash", ".model-list button");
    await waitFor(window, `window.xiuSmoke.calls().includes('provider:agnes/agnes-3.0-flash')`, "provider selection");
    console.log("UI smoke: provider ready");

    await checkComposerIme(window, "idle composer");
    await setComposerText(window, "执行长任务验收");
    await evaluate(window, `(() => { const el=document.querySelector('.composer textarea'); for (let i=0;i<2;i++) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})); document.querySelector('.send-button').click(); return true; })()`);
    await waitFor(window, `window.xiuSmoke.calls().includes('task:create')`, "keyboard task submission");
    await waitFor(window, `document.body.innerText.includes('写入验收文件')`, "approval card");
    assert(await evaluate(window, `document.querySelector('.plan-mode-selector').disabled`), "Plan mode must be locked while awaiting approval.");
    await clickText(window, "仅本次允许");
    await waitFor(window, `document.querySelector('.stop-button')`, "running stop control");
    await waitFor(window, `window.xiuSmoke.calls().includes('long-task:30-turns')`, "30-turn task timeline");
    await evaluate(window, `window.xiuSmoke.emitWebFixture()`);
    await waitFor(window, `document.querySelector('.web-result-details')`, "compact web result detail");
    assert(await evaluate(window, `document.querySelector('.turn-process') && document.querySelector('.turn-process').open`), "Per-round process starts expanded while running.");
    await evaluate(window, `document.querySelector('.web-result-details').closest('.process-group').open = true`);
    assert(await evaluate(window, `(() => { const group=document.querySelector('.web-result-details').closest('.process-group'); const heading=group.querySelector('summary'); const progress=group.querySelector('.model-progress-summary'); return heading.getBoundingClientRect().height <= 30 && heading.innerText.includes('运行记录') && !heading.innerText.includes('命令、工具与文件操作') && Number(getComputedStyle(heading.querySelector('strong')).fontWeight) <= 500 && (!progress || getComputedStyle(progress).borderTopWidth === '0px'); })()`), 'Process headings are quiet event records, not bold operation counts or nested cards.');
    assert(await evaluate(window, `(() => { const group=document.querySelector('.web-result-details').closest('.process-group'); const rows=[...group.querySelectorAll('.process-row')].filter(row=>row.textContent.includes('current holiday news')); return rows.length === 1 && rows[0].classList.contains('process-tool-finished'); })()`), "Paired web start/result must render as a single completed tool row, with no duplicate start row.");
    assert(await evaluate(window, `document.querySelector('.web-result-details').closest('.process-group').innerText.includes('返回 10 条结果') && !document.querySelector('.web-result-details').open && !document.body.innerText.includes('web-evidence-canary')`), "Web evidence must start collapsed with a compact result count.");
    await clickText(window, "查看检索结果详情", ".web-result-details summary");
    await waitFor(window, `document.body.innerText.includes('web-evidence-canary')`, "web evidence expands without deletion");
    assert(await evaluate(window, `!document.querySelector('.web-result-details').innerText.includes('UNTRUSTED WEB CONTENT') && document.querySelector('.web-result-details').innerText.includes('外部网页资料')`), "Expanded evidence uses a Chinese safety note, retaining source contents.");
    assert(await evaluate(window, `document.querySelector('.web-result-details a')?.getAttribute('href') === 'https://example.com/news'`), "Source Markdown must render a safe HTTPS link.");
    await clickText(window, "查看检索结果详情", ".web-result-details summary");
    assert(await evaluate(window, `document.querySelector('.plan-mode-selector').disabled`), "Plan mode must be locked while running.");
    await evaluate(window, `document.querySelector('.turn-process > summary').click()`);
    await waitFor(window, `!document.querySelector('.turn-process').open`, "manually collapse running process");
    assert(await evaluate(window, `(() => { const status=document.querySelector('.active-task-status'); const composer=document.querySelector('.composer'); document.querySelector('.task-scroll').scrollTop=0; const bounds=status?.getBoundingClientRect(); return status && !status.closest('.task-scroll') && bounds.height > 0 && bounds.bottom <= composer.getBoundingClientRect().top; })()`), "Live status stays visible above the composer outside folded/scrolled process details.");
    await checkComposerIme(window, "active composer");
    await evaluate(window, `document.querySelector('.attach-button').click()`);
    await waitFor(window, `Boolean(document.querySelector('.attachment-tiles.editable'))`, "steering attachment queued");
    await setComposerText(window, "继续检查输入法验收");
    await evaluate(window, `(() => { const el=document.querySelector('.composer textarea'); for (let i=0;i<2;i++) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})); document.querySelector('.send-button').click(); return true; })()`);
    await waitFor(window, `window.xiuSmoke.calls().filter(call => call === 'task:steer').length === 1`, "normal Enter steers active task exactly once");
    assert(await evaluate(window, `window.xiuSmoke.calls().filter(call => call === 'task:create').length === 1`), "Active Enter must steer without creating another task.");
    assert(await evaluate(window, `document.querySelectorAll('.event-task-steered .attachment-tile').length === 1 && !document.querySelector('.event-task-steered .event-text').innerText.includes('.xiu/attachments')`), "Steering attachment belongs to that message and internal references stay hidden.");
    await waitFor(window, `document.querySelector('.timeline .subagent-activity')?.textContent.includes('调查任务验收')`, "chronological conversation subagent status");
    assert(await evaluate(window, `!document.querySelector('.turn-process').open`), "Progress updates must not reopen a manually collapsed process.");
    await evaluate(window, `window.xiuSmoke.emitAlertFixture()`);
    await waitFor(window, `document.querySelector('.turn-alerts') && document.querySelector('.active-task-status')?.textContent.includes('3,783')`, 'compact warnings and actual parameter progress');
    assert(await evaluate(window, `(() => { const alerts=document.querySelector('.turn-alerts'); return !alerts.open && alerts.getBoundingClientRect().height < 80 && alerts.querySelectorAll('.turn-alert').length === 1; })()`), 'Long tool failures start folded and duplicate notice is suppressed.');
    await evaluate(window, `document.querySelector('.turn-alerts > summary').click(); document.querySelector('.turn-alert > summary').click()`);
    assert(await evaluate(window, `(() => { const detail=document.querySelector('.turn-alert-detail'); return detail.getBoundingClientRect().height <= 181 && detail.scrollHeight > detail.clientHeight && detail.textContent.includes('# log-format-canary') && !detail.querySelector('h1'); })()`), 'Full error evidence is scrollable and plain text, not giant Markdown headings.');
    await evaluate(window, `document.querySelector('.turn-alerts > summary').click()`);
    await evaluate(window, `document.querySelector('.turn-process > summary').click()`);
    await waitFor(window, `document.querySelector('.turn-process').open`, "reopen running process");
    assert(await evaluate(window, `document.querySelector('.subagent-activity .agent-avatar')?.getAttribute('aria-label') === '调查员头像'`), "Child activity uses an accessible role avatar.");
    assert(await evaluate(window, `document.querySelector('.subagent-activity .agent-avatar svg') && !document.querySelector('.subagent-activity .agent-avatar svg text')`), "Child avatar uses a vector pattern, not a single role initial.");
    await evaluate(window, `document.querySelector('.task-scroll-content').style.minHeight='1600px'`);
    await waitFor(window, `(() => {const e=document.querySelector('.task-scroll');return e.scrollHeight-e.scrollTop-e.clientHeight < 2;})()`, "resize growth follows latest output");
    await evaluate(window, `(() => {const e=document.querySelector('.task-scroll');e.dispatchEvent(new WheelEvent('wheel',{deltaY:-200,bubbles:true}));e.scrollTop=0;})()`);
    await waitFor(window, `document.querySelector('.return-to-latest')`, "manual upward intent pauses follow");
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.return-to-latest')).gridArea === getComputedStyle(document.querySelector('.task-scroll')).gridArea`), 'Return-to-latest floats over the output, without taking another composer row.');
    await evaluate(window, `document.querySelector('.task-scroll-content').style.minHeight='1900px'`);
    await settleLayout(window);
    assert(await evaluate(window, `document.querySelector('.task-scroll').scrollTop === 0`), "New content must not pull the user away from history.");
    await evaluate(window, `document.querySelector('.return-to-latest').click()`);
    await waitFor(window, `!document.querySelector('.return-to-latest') && (() => {const e=document.querySelector('.task-scroll');return e.scrollHeight-e.scrollTop-e.clientHeight < 2;})()`, "return to latest resumes follow");
    await evaluate(window, `document.querySelector('.task-scroll-content').style.minHeight=''`);
    await evaluate(window, `document.querySelector('.overview-content').open = true`);
    await waitFor(window, `document.querySelector('.subagent-summary')?.innerText.includes('调查任务验收')`, "child summary visible without opening agents tab");
    await evaluate(window, `document.querySelector('[aria-label="收起侧栏"]').click()`);
    await settleLayout(window);
    assert(await evaluate(window, `document.querySelector('.workbench-collapsed .subagent-summary').getBoundingClientRect().width > 0 && getComputedStyle(document.querySelector('.inspector-tabs')).display === 'none'`), "Collapsed tools retain only a useful child summary.");
    for (const width of [900, 1366]) {
      await resizeViewport(window, width, 768);
      await settleLayout(window);
      assert(await evaluate(window, `(() => { const r=document.querySelector('.workspace-toolbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.querySelectorAll('.workspace-toolbar button').length === 4; })()`), "Grouped workspace toolbar fits both viewports.");
      assert(await evaluate(window, `(() => { const r=document.querySelector('.task-overview').getBoundingClientRect(); const c=document.querySelector('.composer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && c.width > 200 && c.bottom <= innerHeight; })()`), "Summary and composer must remain usable in wide and narrow windows.");
      await waitFor(window, `Boolean(document.querySelector('.plan-strip'))`, "compact plan ready");
      const composerTop = await evaluate(window, `document.querySelector('.composer').getBoundingClientRect().top`);
      await evaluate(window, `document.querySelector('.plan-strip').open = true`);
      await settleLayout(window);
      assert(await evaluate(window, `(() => { const r=document.querySelector('.plan-details').getBoundingClientRect(); const s=document.querySelector('.plan-strip summary').getBoundingClientRect(); return s.height <= 36 && r.height <= 262 && r.top >= 0 && r.left >= 0 && r.right <= innerWidth && Math.abs(document.querySelector('.composer').getBoundingClientRect().top - ${composerTop}) < 2; })()`), "Plan details must be bounded and must not push the composer down.");
      await fs.promises.writeFile(path.join(smokeRoot, `compact-plan-${width}.png`), (await window.webContents.capturePage()).toPNG());
      await evaluate(window, `document.querySelector('.plan-strip').open = false`);
      await fs.promises.writeFile(path.join(smokeRoot, `subagent-summary-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    assert(await evaluate(window, `document.querySelector('.task-overview').innerText.includes('smoke-overview-branch') && document.querySelector('.task-overview').innerText.includes('后台进程')`), "Overview exposes workspace environment and background processes.");
    await evaluate(window, `document.querySelector('[aria-label="隐藏任务概览"]').click()`);
    await settleLayout(window);
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.review-inspector')).display === 'none'`), "Hiding overview removes the entire collapsed rail.");
    await evaluate(window, `document.querySelector('.workspace-header [aria-label="展开侧栏"]').click()`);
    await evaluate(window, `document.querySelector('[aria-label="显示任务概览"]').click()`);
    await waitFor(window, `Boolean(document.querySelector('.overview-content'))`, "overview content remounts after showing");
    await evaluate(window, `document.querySelector('.overview-content').open = true`);
    await evaluate(window, `document.querySelector('.subagent-summary-row').click()`);
    await waitFor(window, `Boolean(document.querySelector('.review-pane .subagent-card'))`, "summary opens child details");
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.subagent-activity > button')).borderTopWidth === '0px'`), "Subagent activity must not retain native button borders.");
    await evaluate(window, `document.querySelector('.subagent-activity > button').click()`);
    await waitFor(window, `Boolean(document.querySelector('.review-pane .subagent-card'))`, "status link opens synchronized child list");
    await openTool(window, "子智能体");
    await waitFor(window, `document.querySelector('.review-pane .subagent-card')?.innerText.includes('1.2 秒')`, "subagent duration and status");
    await clickText(window, "查看结果", ".review-pane summary");
    await waitFor(window, `document.querySelector('.review-pane .subagent-card').innerText.includes('child-result-canary')`, "subagent result");
    await openTool(window, "数据");
    await waitFor(window, `['后台进程','工具','产出','来源','验证证据'].every(label=>document.querySelector('.task-data-panel').innerText.includes(label))`, "categorized task data");
    assert(await evaluate(window, `[...document.querySelectorAll('.data-row')].every(el => !el.open)`), "Data details should start collapsed.");
    assert(await evaluate(window, `document.querySelectorAll('.data-row').length >= 4 && !document.querySelector('.task-data-panel').innerText.includes('compact-detail-canary')`), "Saved data should be present but details hidden.");
    await clickText(window, 'read_file', '.data-row summary');
    await waitFor(window, `document.querySelector('.task-data-panel').innerText.includes('compact-detail-canary')`, "saved tool detail expands");
    await clickText(window, 'read_file', '.data-row summary');
    await fs.promises.writeFile(path.join(smokeRoot, "workbench-data-1366.png"), (await window.webContents.capturePage()).toPNG());
    await openTool(window, "网页");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="网页地址"]'))`, "browser address bar");
    await evaluate(window, `(() => { const input=document.querySelector('[aria-label="网页地址"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://example.com/'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(window, `document.querySelector('.browser-toolbar').requestSubmit()`);
    await waitFor(window, `window.xiuSmoke.calls().includes('browser:visible:true')`, "browser view visible");
    await evaluate(window, `window.xiuSmoke.emitBrowser({url:'https://example.com/',title:'Loaded',loading:false,canGoBack:false,canGoForward:false})`);
    await evaluate(window, `(() => { const input=document.querySelector('[aria-label="网页地址"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://next.example/'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(window, `window.xiuSmoke.emitBrowser({url:'https://example.com/',title:'New title',loading:false,canGoBack:false,canGoForward:false})`);
    await waitFor(window, `document.querySelector('[aria-label="网页地址"]').value === 'https://next.example/'`, "page updates preserve address editing");
    await clickText(window, "MCP 连接与权限", ".sidebar-mcp");
    await waitFor(window, `window.xiuSmoke.calls().lastIndexOf('browser:visible:false') > window.xiuSmoke.calls().lastIndexOf('browser:visible:true')`, "trusted dialog hides remote view");
    await evaluate(window, `document.querySelector('.mcp-panel header button').click()`);
    await evaluate(window, `document.querySelector('[aria-label="完整视图"]').click()`);
    assert(await evaluate(window, `getComputedStyle(document.querySelector('.workbench-full')).position === 'fixed'`), "Full view should expand the workbench.");
    await evaluate(window, `document.querySelector('[aria-label="返回分屏"]').click(); document.querySelector('[aria-label="关闭网页"]').click()`);
    await waitFor(window, `!document.querySelector('.browser-pane')`, "browser tab close");
    await clickText(window, "停止", ".stop-button");
    await waitFor(window, `window.xiuSmoke.calls().includes('task:stop')`, "task cancellation");
    await waitFor(window, `!document.querySelector('.plan-mode-selector').disabled`, "Plan mode unlocked after cancellation");

    await openTool(window, "证据");
    await waitFor(window, `document.body.innerText.includes('修改前恢复点')`, "checkpoint evidence");
    await waitFor(window, `document.body.innerText.includes('1 项操作待核验')`, "unknown side-effect recovery gate");
    await clickText(window, "恢复", ".checkpoint-card button");
    await waitFor(window, `window.xiuSmoke.calls().includes('restore:checkpoint-1')`, "checkpoint restore");

    await openTool(window, "终端");
    await waitFor(window, `document.querySelector('.terminal-start')`, "terminal start control");
    await clickText(window, "启动终端", ".terminal-start");
    await waitFor(window, `window.xiuSmoke.calls().includes('terminal:start')`, "terminal start");
    await clickText(window, "关闭", ".terminal-stop");
    await waitFor(window, `window.xiuSmoke.calls().includes('terminal:stop')`, "terminal stop");
    await checkStableTabs();
    await openTool(window, "终端");

    await resizeViewport(window, 900, 768, "terminal narrow viewport resize");
    await checkStableTabs();
    await openTool(window, "终端");
    const narrow = await evaluate(window, `(() => ({ width: innerWidth, consoleDisplay: getComputedStyle(document.querySelector('.task-console')).display, terminalDisplay: getComputedStyle(document.querySelector('.terminal-pane')).display }))()`);
    assert(narrow.width === 900, `Expected 900px viewport, received ${narrow.width}.`);
    assert(narrow.consoleDisplay !== "none", "Switching to terminal must preserve the split conversation.");
    assert(narrow.terminalDisplay !== "none", "Narrow terminal layout hid the terminal.");

    await resizeViewport(window, 1366, 768, "onboarding desktop viewport restore");
    await evaluate(window, `window.xiuSmoke.historyFixture()`);
    await clickText(window, "历史续接验收", ".history-row");
    await waitFor(window, `document.querySelector('.task-scroll').innerText.includes('old-snake-result-canary')`, "old history fixture loaded");
    assert(await evaluate(window, `document.querySelector('.task-scroll').innerText.includes('restored-history-image.png') && document.querySelector('.task-scroll').innerText.includes('附件缺失或不可读取') && Boolean(document.querySelector('.task-scroll .attachment-tile img'))`), "History must restore thumbnails and missing-upload placeholders.");
    await evaluate(window, `document.querySelector('.history-view h2').textContent='很长的历史任务需求，包含完整约束和验收条件。'.repeat(30)`);
    await settleLayout(window);
    assert(await evaluate(window, `(() => { const title=document.querySelector('.history-view h2'); return getComputedStyle(title).textOverflow === 'ellipsis' && title.getBoundingClientRect().height <= 24 && document.querySelector('.task-scroll').scrollWidth <= document.querySelector('.task-scroll').clientWidth; })()`), 'Long history titles stay on one line; full request remains in the conversation.');
    await fs.promises.writeFile(path.join(smokeRoot, 'quiet-history-1366.png'), (await window.webContents.capturePage()).toPNG());
    await setComposerText(window, "请重新安排只读审查");
    await evaluate(window, `document.querySelector('.attach-button').click()`);
    await waitFor(window, `document.querySelector('.attachment-tiles.editable')?.innerText.includes('round-two-image-canary')`, "round two attachment queued");
    // Opening history refreshes the recovery view; the fixture has no recovery.
    await evaluate(window, `document.querySelector('.refresh-button').click()`);
    await waitFor(window, `!document.querySelector('.writer-warning')`, "history fixture ready to continue");
    await evaluate(window, `document.querySelector('.send-button').click()`);
    await waitFor(window, `window.xiuSmoke.calls().includes('task:continue')`, "history continuation dispatched");
    await evaluate(window, `window.xiuSmoke.finishContinuation()`);
    await waitFor(window, `document.querySelector('.task-scroll').innerText.includes('new-review-result-canary')`, "new continuation result retained");
    assert(await evaluate(window, `(() => { const rounds=[...document.querySelectorAll('.conversation-round')]; return rounds.length === 2 && rounds[0].querySelectorAll('.attachment-tile').length === 2 && rounds[0].innerText.includes('restored-history-image.png') && !rounds[0].innerText.includes('round-two-image-canary') && rounds[1].querySelectorAll('.attachment-tile').length === 1 && rounds[1].innerText.includes('round-two-image-canary') && !rounds[1].innerText.includes('restored-history-image.png'); })()`), "Restored uploads persist through continuation; round two uploads never leak into the first round.");
    await settleLayout(window);
    assert(await evaluate(window, `document.querySelector('.task-scroll .turn-process') && [...document.querySelectorAll('.task-scroll .turn-process')].every(el => !el.open)`), "Completed turn defaults to a folded process with final answer visible.");
    await fs.promises.writeFile(path.join(smokeRoot, 'compact-completed-turn.png'), (await window.webContents.capturePage()).toPNG());
    assert(await evaluate(window, `document.querySelector('.task-scroll').innerText.includes('old-snake-result-canary') && document.querySelector('.task-scroll .conversation-round:last-child').innerText.includes('new-review-result-canary') && !document.querySelector('.task-scroll .conversation-round:last-child').innerText.includes('old-snake-result-canary')`), "Continuation preserves old rounds without attributing their answer to the new round.");
    await openTool(window, "子智能体");
    await waitFor(window, `document.querySelector('.review-pane .subagent-card')?.innerText.includes('本轮审查')`, "completed continuation keeps children");
    await clickText(window, "查看结果", ".review-pane summary");
    await waitFor(window, `document.querySelector('.review-pane').innerText.includes('new-child-result-canary')`, "completed child result remains inspectable");
    await evaluate(window, `window.xiuSmoke.failContinuation()`);
    await waitFor(window, `document.querySelector('.conversation-round:last-child [role="status"]')?.textContent.includes('程序验收：失败')`, "authoritative failed completion alongside model reply");
    assert(await evaluate(window, `document.querySelector('.conversation-round:last-child').innerText.includes('模型声称全部通过-canary') && document.querySelector('.conversation-round:last-child [role="status"]').textContent.includes('文件修改后需重跑') && !document.querySelector('.conversation-round:last-child [role="status"] details').open`), "Failed acceptance retains model reply with folded pending verification details.");
    await waitFor(window, `document.querySelector('.plan-pill')?.innerText.includes('验收未通过') || document.querySelector('.composer-area')?.innerText.includes('验收未通过')`, "plan completion is not acceptance success");
    await openTool(window, "变更");
    await evaluate(window, `window.xiuSmoke.nonGitFixture(true); document.querySelector('.refresh-button').click()`);
    await waitFor(window, `[...document.querySelectorAll('.segmented button')].filter(button => button.disabled).length === 2`, "non-Git views are unavailable instead of empty");
    assert(await evaluate(window, `document.querySelector('.review-pane').innerText.includes('需要 Git')`), "Non-Git workspace explains comparison semantics.");
    await evaluate(window, `window.xiuSmoke.nonGitFixture(false); document.querySelector('.refresh-button').click()`);
    await waitFor(window, `[...document.querySelectorAll('.segmented button')].every(button => !button.disabled)`, "Git views remain available");
    assert(await evaluate(window, `document.querySelector('.changes-panel > header .added')?.textContent === '+1059' && document.querySelector('.changes-panel > header .removed')?.textContent === '-1042'`), "Diff totals must use independent statistics, not count the two displayed preview lines.");
    console.log("UI smoke: round-scoped attachment, authoritative acceptance, and non-Git views ready");
    await evaluate(window, `window.xiuSmoke.freshProviders()`);
    await clickText(window, "设置", ".sidebar-footer");
    await clickText(window, "模型与渠道", ".settings-nav button");
    await clickText(window, "管理模型与渠道");
    await waitFor(window, `document.body.innerText.includes('尚未添加渠道')`, "zero-provider setup");
    await clickText(window, "新增渠道", ".provider-add");
    await waitFor(window, `Boolean(document.querySelector('.provider-form .xiu-select:not(:disabled)'))`, "provider form mounted");
    await chooseOption(window, '.provider-form .xiu-select', 'agnes');
    await waitFor(window, `document.querySelector('.provider-form input').value === 'Agnes'`, "Agnes template fields");
    await clickText(window, "保存渠道", ".provider-editor footer button");
    await waitFor(window, `window.xiuSmoke.calls().includes('onboarding:add:agnes')`, "first channel save");
    await waitFor(window, `document.querySelector('.provider-nav-row > button')`, "saved channel stays visible");
    await evaluate(window, `document.querySelector('.provider-nav-row button[title="删除渠道"]').click()`);
    await waitFor(window, `document.querySelector('.provider-delete-confirm')`, "last channel delete confirmation");
    await clickText(window, "删除渠道", ".provider-delete-confirm button");
    await waitFor(window, `document.body.innerText.includes('尚未添加渠道') && window.xiuSmoke.calls().includes('onboarding:delete:agnes')`, "return to zero-provider setup");

    await evaluate(window, `document.querySelector('.provider-header-actions button[aria-label="关闭"]').click()`);
    await waitFor(window, `!document.querySelector('.provider-popover')`, "provider picker closed before recovery");
    // Recovery must stay reachable even when no provider runtime/workspace loads.
    await evaluate(window, `window.xiuSmoke.recoveryWorkspace(false)`);
    await waitFor(window, `document.body.innerText.includes('打开你的第一个工作区')`, "no-workspace recovery entry");
    await clickText(window, "Provider 配置诊断与恢复", ".sidebar-mcp");
    await waitFor(window, `document.querySelector('[aria-label="Provider 配置恢复"]')?.innerText.includes('配置损坏')`, "malformed provider diagnostics");
    await clickText(window, "预览此备份", ".mcp-panel button");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="配置恢复预览"]'))`, "configuration recovery preview");
    // Capture only the synthetic preload fixture, never a real configuration.
    await settleLayout(window);
    await fs.promises.writeFile(path.join(smokeRoot, "recovery-preview-1366.png"), (await window.webContents.capturePage()).toPNG());
    await clickText(window, "取消预览", ".mcp-panel button");
    await waitFor(window, `!document.querySelector('[aria-label="配置恢复预览"]')`, "configuration preview cancellation");
    await clickText(window, "预览此备份", ".mcp-panel button");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="配置恢复预览"]'))`, "fresh configuration preview");
    await clickText(window, "继续并确认", ".mcp-panel button");
    await waitFor(window, `window.xiuSmoke.calls().includes('provider-recovery:native-confirm:false') && !document.querySelector('[aria-label="配置恢复预览"]')`, "native confirmation cancellation");
    await resizeViewport(window, 900, 768, "recovery narrow viewport");
    assert(await evaluate(window, `(() => { const r=document.querySelector('[aria-label="Provider 配置恢复"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`), "Recovery panel must fit narrow viewport.");
    await clickText(window, "预览此备份", ".mcp-panel button");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="配置恢复预览"]'))`, "close cancellation preview");
    await settleLayout(window);
    await fs.promises.writeFile(path.join(smokeRoot, "recovery-preview-900.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate(window, `document.querySelector('[aria-label="关闭配置恢复"]').click()`);
    await waitFor(window, `!document.querySelector('[aria-label="Provider 配置恢复"]')`, "closing recovery cancels preview");
    await clickText(window, "Provider 配置诊断与恢复", ".sidebar-mcp");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="Provider 配置恢复"]')) && !document.querySelector('[aria-label="配置恢复预览"]')`, "recovery reopen has no retained preview");
    await evaluate(window, `window.xiuSmoke.recoveryConfirmation(true)`);
    await clickText(window, "预览此备份", ".mcp-panel button");
    await waitFor(window, `Boolean(document.querySelector('[aria-label="配置恢复预览"]'))`, "confirmed recovery preview");
    await clickText(window, "继续并确认", ".mcp-panel button");
    await waitFor(window, `document.querySelector('[aria-label="Provider 配置恢复"]')?.innerText.includes('恢复已完成')`, "configuration restored restart required");
    await evaluate(window, `document.querySelector('[aria-label="关闭配置恢复"]').click(); window.xiuSmoke.recoveryWorkspace(true)`);
    await waitFor(window, `document.querySelector('.send-button')?.disabled && document.querySelector('.composer textarea')?.disabled`, "restart latch disables new tasks");

    const calls = await evaluate(window, `window.xiuSmoke.calls()`);
    console.log(JSON.stringify({ passed: true, viewports: ["1366x768", "900x768"], workflows: ["custom-select-keyboard-focus", "custom-select-viewport", "empty-state-font", "closable-tool-tabs", "split-full-view", "browser-modal-isolation", "compact-data-expand", "independent-diff", "file-tree-search", "saved-round-selection", "missing-snapshot", "subagent-cards-status-result", "categorized-data", "synthetic-ime-idle-active", "ime-end-before-enter", "ime-blur-keyup-cleanup", "shift-enter-newline", "keyboard-submit-steer", "same-tick-duplicate-submit-steer", "plan-toggle-context", "plan-full-access-independent", "plan-active-lock", "provider-model", "provider-media-model", "approval", "30-turn-task", "stop", "unknown-side-effect-gate", "checkpoint-restore", "terminal-lifecycle", "zero-provider-onboarding", "add-agnes-template", "delete-last-provider", "provider-recovery-before-startup", "provider-recovery-preview-cancel", "provider-recovery-native-cancel", "provider-recovery-restart-latch"], calls }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? String(error));
    try {
      const diagnostics = await evaluate(window, `({ platform: navigator.platform, width: innerWidth, height: innerHeight, documentFocused: document.hasFocus(),
        focused: document.activeElement?.outerHTML?.slice(0, 1000),
        options: [...document.querySelectorAll('.xiu-select-menu [role="option"]')].map(el => el.textContent),
        layoutEvents: window.xiuSmokeLayoutEvents, calls: window.xiuSmoke?.calls() })`);
      console.error('UI smoke failure diagnostics:', JSON.stringify(diagnostics));
      await fs.promises.writeFile(path.join(smokeRoot, 'ui-smoke-failure.json'), JSON.stringify(diagnostics, null, 2));
      await fs.promises.writeFile(path.join(smokeRoot, 'ui-smoke-failure.png'), (await window.webContents.capturePage()).toPNG());
    } catch (diagnosticError) {
      console.error('Could not capture UI smoke diagnostics:', diagnosticError?.message ?? String(diagnosticError));
    }
    app.exit(1);
  }
});
