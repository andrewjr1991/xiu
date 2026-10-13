const { app, BrowserWindow }=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const { createSmokeWindow,evaluate,waitFor,settleLayout,resizeViewport }=require('./ui-smoke-helpers.cjs');
const root=path.resolve(__dirname,'../../../.desktop-build-temp');
app.setPath('userData',fs.mkdtempSync(path.join(root,'computer-ui-')));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const window=createSmokeWindow(BrowserWindow,path.join(__dirname,'ui-smoke-preload.cjs'));
  const click=label=>evaluate(window,`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)}));if(!b)throw new Error('Missing button');b.click();})()`);
  try {
    await window.loadFile(path.resolve(__dirname,'../dist/renderer/index.html'));
    await waitFor(window,"document.querySelector('.composer')",'composer');
    await evaluate(window,`document.querySelector('[aria-label="打开标签页"]').click()`);
    await click('电脑操作');
    await waitFor(window,"document.querySelector('.computer-use-panel')",'computer panel');
    assert(await evaluate(window,"!document.querySelector('.computer-debug').open && !!document.querySelector('.computer-goal textarea')"));
    await evaluate(window,"document.querySelector('.computer-debug').open=true");
    await click('刷新可用窗口');
    await waitFor(window,"document.querySelector('.computer-window-list button')",'window choices');
    await click('选择并授权');
    await waitFor(window,"document.querySelector('.computer-manual')",'manual controls');
    await click('刷新截图');
    await waitFor(window,"document.querySelector('.computer-screen img')",'target screenshot');
    for(const theme of ['dark','light']) for(const width of [1366,900]) {
      await evaluate(window,`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await resizeViewport(window,width,768,'computer viewport');await settleLayout(window);
      assert(await evaluate(window,`(()=>{const p=document.querySelector('.computer-use-panel');return p.scrollWidth<=p.clientWidth+1;})()`),'Computer panel overflow');
      assert(await evaluate(window,`getComputedStyle(document.querySelector('.computer-use-actions button')).borderRadius!=='0px'`),'Native unstyled button');
      await fs.promises.writeFile(path.join(root,`computer-window-${theme}-${width}.png`),(await window.webContents.capturePage()).toPNG());
    }
    await evaluate(window,`document.querySelector('.computer-screen').click()`);
    await waitFor(window,"document.querySelector('.computer-screen').disabled",'consumed frame');
    await click('停止并撤销');
    await waitFor(window,"!document.querySelector('.computer-manual')",'revoked state');
    await click('启用自动操作');
    await waitFor(window,"![...document.querySelectorAll('button')].some(b=>b.textContent.includes('启用自动操作'))",'automatic mode');
    await evaluate(window,`(()=>{const field=document.querySelector('.computer-goal textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'检查隔离游戏开始按钮');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(window,"![...document.querySelectorAll('button')].find(b=>b.textContent.includes('开始电脑任务')).disabled",'goal ready');
    await click('开始电脑任务');
    await waitFor(window,"!!document.querySelector('.approval-card')",'goal submitted as Agent task');
    console.log('Computer UI: window selection, styled controls, screenshot, one-shot frame and stop; 1366/900 layout passed.');
    window.destroy();app.exit(0);
  } catch(error){console.error(error);fs.writeFileSync(path.join(root,'computer-ui-failure.png'),(await window.webContents.capturePage()).toPNG());window.destroy();app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1);});
