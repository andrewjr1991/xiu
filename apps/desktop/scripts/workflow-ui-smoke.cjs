const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createSmokeWindow, evaluate, waitFor, settleLayout, resizeViewport } = require("./ui-smoke-helpers.cjs");
const root = path.resolve(__dirname, "../../../.desktop-build-temp");
app.setPath("userData", fs.mkdtempSync(path.join(root, "workflow-ui-")));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = createSmokeWindow(BrowserWindow, path.join(__dirname, "ui-smoke-preload.cjs"));
  try {
    await window.loadFile(path.resolve(__dirname, "../dist/renderer/index.html"));
    await waitFor(window, "Boolean(document.querySelector('.composer'))", "composer");
    await evaluate(window, "window.xiuSmoke.workflowFixture()");
    await waitFor(window, "Boolean(document.querySelector('.user-question'))", "question card");
    await waitFor(window, "document.querySelector('.task-scroll').textContent.includes('long-unbroken-command-')", "long command is present");
    await waitFor(window, "document.querySelector('.plan-strip').textContent.includes('1 / 2')", "plan progress");
    for (const width of [1366, 900]) {
      await resizeViewport(window, width, 768, "workflow viewport");
      await settleLayout(window);
      assert(await evaluate(window, `(() => { const el=document.querySelector('.task-scroll'); return el.scrollWidth <= el.clientWidth + 1; })()`), "Conversation must have no horizontal overflow");
      assert(await evaluate(window, `(() => { const r=document.querySelector('.user-question').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), "Question must be visible inside viewport");
      assert(await evaluate(window, `document.querySelector('.workspace-header').textContent.includes('等待回答') && !document.querySelector('.stop-button')`), "Question pauses model activity");
      await fs.promises.writeFile(path.join(root, `workflow-question-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(window, `(() => { const el=document.querySelector('.user-question textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Windows'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await settleLayout(window);
    await evaluate(window, `document.querySelector('.user-question form').requestSubmit()`);
    await waitFor(window, `window.xiuSmoke.calls().includes('question:answer:Windows') && !document.querySelector('.user-question')`, "answer continuation");
    await evaluate(window, "window.xiuSmoke.computerAcceptanceFixture()");
    await waitFor(window, "Boolean(document.querySelector('.computer-acceptance button'))", "manual acceptance controls");
    assert(await evaluate(window, "getComputedStyle(document.querySelector('.computer-acceptance button')).borderRadius === '10px'"), "Shared styled acceptance controls");
    for (const theme of ['dark', 'light']) {
      await evaluate(window, `document.documentElement.dataset.motion='reduced'; document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await settleLayout(window);
      const colors = await evaluate(window, `(() => {const s=getComputedStyle(document.querySelector('.computer-acceptance button'));return {background:s.backgroundColor,foreground:s.color};})()`);
      const luminance = color => color.match(/\d+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const bg=luminance(colors.background), fg=luminance(colors.foreground);
      assert((Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)>=4.5, `${theme} acceptance button text contrast`);
      if(theme==='dark') assert(bg<.2, `Dark acceptance buttons must not fall back to white: ${JSON.stringify(colors)} ${await evaluate(window, "JSON.stringify({theme:document.documentElement.dataset.theme,tone:getComputedStyle(document.documentElement).getPropertyValue('--tone-edf1f6')})")}`);
      await fs.promises.writeFile(path.join(root, `computer-acceptance-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    assert(await evaluate(window, "document.querySelector('.computer-acceptance').textContent.includes('不等于操作失败')"));
    await evaluate(window, "document.querySelector('.computer-acceptance button').click()");
    await waitFor(window, "document.querySelector('.computer-acceptance strong').textContent === '人工验收通过'", "human pass");
    await evaluate(window, "document.querySelector('.computer-acceptance button:nth-child(2)').click()");
    await waitFor(window, "document.querySelector('.computer-acceptance strong').textContent === '人工验收未通过'", "human rejection");
    await settleLayout(window);
    assert(await evaluate(window, "document.querySelector('.task-scroll').scrollWidth <= document.querySelector('.task-scroll').clientWidth + 1"));
    await fs.promises.writeFile(path.join(root, "computer-acceptance-ui.png"), (await window.webContents.capturePage()).toPNG());
    console.log("Workflow UI passed: 1366/900 no horizontal overflow, visible paused question, bound answer continuation and separate human acceptance/rejection.");
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); await fs.promises.writeFile(path.join(root, "workflow-ui-failure.png"), (await window.webContents.capturePage()).toPNG()); window.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
