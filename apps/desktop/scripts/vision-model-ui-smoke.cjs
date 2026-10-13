const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createSmokeWindow, evaluate, waitFor, settleLayout, resizeViewport } = require('./ui-smoke-helpers.cjs');
const root = path.resolve(__dirname, '../../../.desktop-build-temp');
app.setPath('userData', fs.mkdtempSync(path.join(root, 'vision-model-ui-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = createSmokeWindow(BrowserWindow, path.join(__dirname, 'ui-smoke-preload.cjs'));
  try {
    await window.loadFile(path.resolve(__dirname, '../dist/renderer/index.html'));
    await waitFor(window, "Boolean(document.querySelector('.composer'))", 'composer');
    await evaluate(window, `window.xiuSmoke.visionModelsFixture(); document.querySelector('.sidebar-footer').click()`);
    await waitFor(window, "Boolean(document.querySelector('.settings-nav'))", 'settings');
    await evaluate(window, `[...document.querySelectorAll('.settings-nav button')].find(el=>el.textContent.includes('模型与渠道')).click()`);
    await waitFor(window, "Boolean(document.querySelector('.provider-popover'))", 'picker');
    assert(await evaluate(window, `Boolean(document.querySelector('.settings-body .provider-manager')) && !document.querySelector('.settings-provider-backdrop')`), 'Management is embedded directly in settings');
    assert(await evaluate(window, `document.querySelector('.capability-model-group').textContent.includes('能力未知')`));
    await evaluate(window, `[...document.querySelectorAll('.provider-actions button')].find(el=>el.textContent.includes('测试全部视觉候选')).click()`);
    await waitFor(window, `document.querySelectorAll('.vision-probe-results > div').length === 4`, 'all four candidate results');
    assert(await evaluate(window, `document.querySelector('.vision-probe-results').textContent.includes('opaque-declared') && document.querySelector('.vision-probe-results').textContent.includes('agnes-3.0-flash')`));
    await evaluate(window, `[...document.querySelectorAll('.provider-actions button')].find(el=>el.textContent.includes('编辑渠道')).click()`);
    await waitFor(window, "Boolean(document.querySelector('.vision-model-editor'))", 'vision editor');
    for (const theme of ['dark', 'light']) {
      for (const width of [1366, 900]) {
        await resizeViewport(window, width, 900, 'vision editor viewport');
        await evaluate(window, `document.documentElement.dataset.motion='reduced'; document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.querySelector('.vision-model-editor .xiu-select').click()`);
        await waitFor(window, "Boolean(document.querySelector('.xiu-select-menu'))", 'full candidate list');
        assert(await evaluate(window, `(() => {const menu=document.querySelector('.xiu-select-menu');const r=menu.getBoundingClientRect();return menu.textContent.includes('agnes-3.0-flash') && menu.textContent.includes('接口声明支持视觉') && menu.textContent.includes('名称推测') && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()`), 'Complete unfiltered candidates, evidence and viewport');
        await settleLayout(window);
        assert(await evaluate(window, `(() => { const host=document.querySelector('.settings-main'); const manager=document.querySelector('.provider-manager'); return host.scrollWidth <= host.clientWidth + 1 && manager.scrollWidth <= manager.clientWidth + 1; })()`), 'Inline settings must not introduce horizontal scrolling');
        await fs.promises.writeFile(path.join(root, `vision-model-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        await evaluate(window, `document.querySelector('.xiu-select-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      }
    }
    await evaluate(window, `document.querySelector('.vision-model-editor .xiu-select').click()`);
    await evaluate(window, `[...document.querySelectorAll('.xiu-select-menu [role=option]')].find(el=>el.textContent.includes('agnes-3.0-flash')).click()`);
    assert(await evaluate(window, `document.querySelector('[aria-label="视觉模型 ID"]').value === 'agnes-3.0-flash'`));
    await evaluate(window, `(() => {const el=document.querySelector('[aria-label="视觉模型 ID"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'manual-vision-id');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await settleLayout(window);
    await evaluate(window, `[...document.querySelectorAll('.vision-model-editor button')].find(el=>el.textContent.includes('测试视觉能力')).click()`);
    await waitFor(window, `document.querySelector('.provider-popover').textContent.includes('manual-vision-id · 测试通过')`, 'manual candidate probe result');
    assert(await evaluate(window, `document.querySelector('.provider-popover').textContent.includes('仅本次测试结果')`));
    await evaluate(window, `document.querySelector('.provider-editor footer .primary-button').click()`);
    await waitFor(window, `window.xiuSmoke.calls().includes('onboarding:add:agnes')`, 'manual model save');
    assert(await evaluate(window, `(async () => (await window.xiuDesktop.providerSnapshot()).profiles[0].capabilityModels.vision === 'manual-vision-id')()`), 'Manual ID must survive save');
    await evaluate(window, `document.querySelector('.provider-manager .model-list button').click()`);
    await waitFor(window, `Boolean(document.querySelector('.provider-manager .model-list button.selected'))`, 'settings selection stays inline');
    await evaluate(window, `[...document.querySelectorAll('.settings-nav button')].find(el=>el.textContent==='外观').click()`);
    await waitFor(window, `!document.querySelector('.provider-manager')`, 'management unmounted on category change');
    await evaluate(window, `[...document.querySelectorAll('.settings-nav button')].find(el=>el.textContent==='模型与渠道').click()`);
    await waitFor(window, `Boolean(document.querySelector('.provider-manager'))`, 'return reloads inline management');
    await evaluate(window, `document.querySelector('[aria-label="关闭设置"]').click()`);
    await waitFor(window, `!document.querySelector('.settings-page')`, 'settings closed');
    await evaluate(window, `document.querySelector('.model-selector').click()`);
    await waitFor(window, `Boolean(document.querySelector('.provider-selection'))`, 'selection-only composer');
    assert(await evaluate(window, `!document.querySelector('.provider-selection .provider-add,.provider-selection .provider-actions,.provider-selection input,.provider-selection button[title="编辑渠道"],.provider-selection button[title="删除渠道"]') && document.querySelectorAll('.provider-selection .model-list button').length > 1`), 'Composer has selections only, with no editing, credentials or tests');
    await evaluate(window, `document.querySelector('.provider-selection .model-list button').click()`);
    await waitFor(window, `!document.querySelector('.provider-selection')`, 'model selected and picker closed');
    console.log('Vision model UI passed: inline management, batch probing, full candidates, evidence labels, dark/light wide/narrow menus, manual save and selection-only composer.');
    window.destroy(); app.exit(0);
  } catch(error) {console.error(error);window.destroy();app.exit(1);}
});
