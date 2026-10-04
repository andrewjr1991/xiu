const { app, BrowserWindow, nativeTheme } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiu-dialog-smoke-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const theme = process.env.XIU_DIALOG_SMOKE_THEME === 'dark' ? 'dark' : 'light';
  nativeTheme.themeSource = theme;
  const outfile = path.join(root, 'dialog.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../main/full-access-dialog.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const { confirmFullAccess, confirmSubagentCancel } = require(outfile);
  const parent = new BrowserWindow({ show: false });
  for (const confirm of [confirmFullAccess, confirmSubagentCancel]) {
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
    if (action === 'accept') fs.writeFileSync(path.resolve(__dirname, '../../../.desktop-build-temp/full-access-dialog.png'), (await child.webContents.capturePage()).toPNG());
    if (action === 'close') child.close();
    else if (action === 'escape') await child.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));true`);
    else await child.webContents.executeJavaScript(`document.getElementById('${action === 'close-button' ? 'close' : action}').click();true`);
    assert.equal(await result, action === 'accept');
    await closed;
  }
  }
  parent.destroy();
  console.log('Full Access and subagent cancellation dialogs: cancel, close, Escape, explicit acceptance and isolation passed.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
