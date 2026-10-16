const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A Chromium textarea exposes an editable UIA node but its HWND does not implement EM_SETSEL.
// Assert DOM selection/copy events, so an ignored native message cannot pass as successful input.
module.exports = async function keyboardSmoke(native) {
  app.setAccessibilitySupportEnabled(true);
  const window = new BrowserWindow({ show: true, width: 500, height: 300, title: 'Xiu isolated Chromium editor' });
  try {
    console.log('Chromium fixture: load');
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>Xiu isolated Chromium editor</title><textarea aria-label="Fallback editor">fallback editor text</textarea><button>Focus target</button><script>window.copies=0;window.saves=0;document.addEventListener("copy",()=>window.copies++);document.addEventListener("keydown",e=>{if(e.ctrlKey&&e.key.toLowerCase()==="s"){e.preventDefault();window.saves++;}});</script>'));
    console.log('Chromium fixture: discover');
    window.show();
    window.focus();
    await delay(100);
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
    const windows = await native.list();
    const target = windows.find(w => w.handle === handle && w.pid === process.pid);
    assert.ok(target, JSON.stringify({ handle, pid: process.pid, visible: window.isVisible(), windows: windows.filter(w => w.pid === process.pid || w.handle === handle) }));
    await native.request({ ...target, action: 'activate' });
    await window.webContents.executeJavaScript('document.querySelector("textarea").focus();true');
    await delay(250);
    const until = async expression => {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await window.webContents.executeJavaScript(expression)) return;
        await delay(50);
      }
      throw new Error('Chromium fixture did not observe: ' + expression);
    };
    console.log('Chromium fixture: select-all');
    await native.request({ ...target, action: 'key', key: 'Ctrl+A' });
    await until('(()=>{const t=document.querySelector("textarea");return t.selectionStart===0&&t.selectionEnd===t.value.length;})()');
    console.log('Chromium fixture: copy');
    await native.request({ ...target, action: 'key', key: 'Ctrl+C' });
    await until('window.copies===1');
    console.log('Chromium fixture: app-level save');
    await window.webContents.executeJavaScript('document.querySelector("button").focus();true');
    await delay(100);
    await native.request({ ...target, action: 'key', key: 'Ctrl+S' });
    await until('window.saves===1');
    await assert.rejects(native.request({ ...target, action: 'key', key: 'Ctrl+A' }), /editor-control-required|编辑控件/);
    console.log('Chromium editor keyboard fallback and non-editor rejection passed.');
  } finally { window.destroy(); }
};
