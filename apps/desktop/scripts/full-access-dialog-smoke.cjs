const { app, BrowserWindow, nativeTheme } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiu-dialog-smoke-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
// Under xvfb the viz compositor occasionally fails the first capture (UnknownVizError); the dialog itself is already verified above, so retry the screenshot a bounded number of times.
async function capturePageWithRetry(webContents, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await webContents.capturePage(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`Dialog smoke: capturePage failed (attempt ${attempt}/${attempts}), retrying:`, error && error.message ? error.message : error);
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
}
app.whenReady().then(async () => {
  const theme = process.env.XIU_DIALOG_SMOKE_THEME === 'dark' ? 'dark' : 'light';
  nativeTheme.themeSource = theme;
  const outfile = path.join(root, 'dialog.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../main/full-access-dialog.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const { confirmFullAccess, confirmSubagentCancel, confirmComputerAction, confirmVisionProbe } = require(outfile);
  const parent = new BrowserWindow({ show: false });
  for (const confirm of [confirmFullAccess, parent => confirmFullAccess(parent, 'Fixture vision / model · https://fixture.invalid/v1'), confirmSubagentCancel, parent => confirmVisionProbe(parent, 'Fixture / unknown-model · https://fixture.invalid/v1', new AbortController().signal), parent => confirmVisionProbe(parent, '共 4 个模型，每个最多一次请求（最多 4 次，可能分别计费）。\n' + Array.from({length:4},(_,i)=>`Fixture / model-${i} · https://fixture.invalid/v1`).join('\n'), new AbortController().signal, true), parent => confirmComputerAction(parent, 'Computer Use', '<script>fixture</script>\n' + 'Long bounded authorization detail. '.repeat(100))]) {
  for (const action of ['cancel', 'close', 'escape', 'close-button', 'accept']) {
    console.log('Dialog smoke:', action);
    const result = confirm(parent);
    const child = BrowserWindow.getAllWindows().filter(window => window !== parent).sort((a,b) => b.id-a.id)[0];
    const closed = new Promise(resolve => child.once('closed', resolve));
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Dialog did not show: '+action)), 8000); child.once('show', () => {clearTimeout(timer);resolve();}); });
    assert.equal(child.webContents.getLastWebPreferences().nodeIntegration, false);
    assert.equal(child.webContents.getLastWebPreferences().sandbox, true);
    assert.equal(await child.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'), theme === 'dark' ? 'rgb(32, 34, 38)' : 'rgb(255, 255, 255)');
    assert.equal(await child.webContents.executeJavaScript('document.activeElement.id'), 'cancel');
    assert.equal(await child.webContents.executeJavaScript('document.getElementById("accept").getBoundingClientRect().bottom <= innerHeight'), true);
    if (action === 'accept') fs.writeFileSync(path.resolve(__dirname, '../../../.desktop-build-temp/full-access-dialog.png'), (await capturePageWithRetry(child.webContents)).toPNG());
    if (action === 'close') child.close();
    else if (action === 'escape') await child.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));true`);
    else await child.webContents.executeJavaScript(`document.getElementById('${action === 'close-button' ? 'close' : action}').click();true`);
    assert.equal(await result, action === 'accept');
    await closed;
  }
  const cancellation = new AbortController();
  const pending = confirmComputerAction(parent, 'Stop fixture', 'Abort must dismiss authorization.', cancellation.signal);
  cancellation.abort();
  assert.equal(await pending, false);
  }
  parent.destroy();
  console.log('Full Access and subagent cancellation dialogs: cancel, close, Escape, explicit acceptance and isolation passed.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
