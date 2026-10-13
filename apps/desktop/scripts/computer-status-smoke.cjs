const { app, BrowserWindow, nativeTheme } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiu-status-smoke-'));
app.setPath('userData', root); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50); } throw new Error('Status fixture timeout'); }
app.whenReady().then(async () => {
  const outfile = path.join(root, 'status.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../main/computer-status-window.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const { ComputerStatusWindow } = require(outfile);
  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme;
    let paused = false, stopped = false;
    const status = new ComputerStatusWindow(() => { stopped = true; status.close(); }, () => { paused = !paused; status.update('已暂停', 'Fixture application', 'Fixture vision', paused); });
    status.update('正在观察', 'Fixture application', '<script>fixture only</script>');
    status.update('分析画面', 'Fixture application', '<script>fixture only</script>');
    const window = BrowserWindow.getAllWindows()[0];
    await until(() => window.isVisible());
    const prefs = window.webContents.getLastWebPreferences();
    assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.preload, undefined);
    assert.equal(window.isFocused(), false);
    const layout = await window.webContents.executeJavaScript(`({text:document.body.innerText, scripts:document.scripts.length, color:getComputedStyle(document.body).backgroundColor, fits:document.body.scrollWidth<=innerWidth&&document.body.scrollHeight<=innerHeight})`);
    assert.match(layout.text, /分析画面/); assert.match(layout.text, /<script>fixture only<\/script>/); assert.equal(layout.scripts, 0); assert.equal(layout.fits, true);
    assert.equal(layout.color, theme === 'dark' ? 'rgb(32, 34, 38)' : 'rgb(250, 250, 250)');
    await window.webContents.executeJavaScript(`document.querySelector('a[href="xiu-computer-pause://toggle"]').click();true`);
    await until(() => paused);
    await until(async () => await window.webContents.executeJavaScript(`document.body.innerText.includes('继续')`));
    await window.webContents.executeJavaScript(`document.querySelector('a[href="xiu-computer-stop://stop"]').click();true`);
    await until(() => stopped); assert.equal(window.isDestroyed(), true);
  }
  console.log('Floating status: dark/light, stage updates, no focus stealing, layout, escaping, isolation, pause and stop passed.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
