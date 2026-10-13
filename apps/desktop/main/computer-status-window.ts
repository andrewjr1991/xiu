import { BrowserWindow, nativeTheme, screen } from "electron";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
/** Main-owned status only: no preload, Node, screenshots, task text or input IPC. */
export class ComputerStatusWindow {
  private window?: BrowserWindow;
  private revision = 0;
  private ready?: Promise<void>;
  constructor(private readonly stop: () => void, private readonly pause: () => void) {}
  update(phase: string, app: string, provider?: string, paused = false): void {
    const revision = ++this.revision;
    if (!this.window || this.window.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      const window = new BrowserWindow({ width: 440, height: 112, x: area.x + 20, y: area.y + area.height - 132,
        show: false, frame: false, resizable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true,
        title: "Xiu · 电脑操作状态", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false } });
      this.window = window;
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => { event.preventDefault(); if (url === "xiu-computer-stop://stop") this.stop(); else if (url === "xiu-computer-pause://toggle") this.pause(); });
      window.once("closed", () => { if (this.window === window) { this.window = undefined; this.ready = undefined; } });
    }
    const window = this.window;
    const dark = nativeTheme.shouldUseDarkColors;
    const html = `<html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}body{margin:0;padding:14px 18px;font:13px/1.5 'Segoe UI','Microsoft YaHei',sans-serif;background:${dark ? '#202226' : '#fafafa'};color:${dark ? '#e2e5e9' : '#344054'};border:1px solid ${dark ? '#41464e' : '#dce5f0'};border-radius:12px}header{display:flex;justify-content:space-between;gap:12px}strong{font-size:14px}p{margin:5px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${dark ? '#bbc1ca' : '#65758b'}}a{padding:3px 12px;border-radius:7px;color:${dark ? '#ffb1ae' : '#ad3430'};background:${dark ? '#382a2b' : '#fbeceb'};text-decoration:none}</style><header><strong>Xiu · ${escapeHtml(phase)}</strong><a href="xiu-computer-stop://stop">停止</a></header><p>${escapeHtml(app)} · 前台操作，请勿同时使用鼠标键盘</p><p>${escapeHtml(provider ?? '仅本地观察')}</p></html>`;
    const content = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><title>Xiu · 电脑操作状态</title>').replace('<a href="xiu-computer-stop://stop">', `<a href="xiu-computer-pause://toggle">${paused ? '继续' : '暂停'}</a><a href="xiu-computer-stop://stop">`);
    // Load the isolated page once; phase changes must not race page navigations.
    this.ready ??= window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
    void this.ready.then(async () => {
      if (revision !== this.revision || this.window !== window || window.isDestroyed()) return;
      await window.webContents.executeJavaScript(`(() => {
        document.querySelector('strong').textContent=${JSON.stringify(`Xiu · ${phase}`)};
        const lines=document.querySelectorAll('p');
        lines[0].textContent=${JSON.stringify(`${app} · 前台操作，请勿同时使用鼠标键盘`)};
        lines[1].textContent=${JSON.stringify(provider ?? '仅本地观察')};
        document.querySelector('a[href="xiu-computer-pause://toggle"]').textContent=${JSON.stringify(paused ? '继续' : '暂停')};
      })()`);
      if (revision === this.revision && this.window === window && !window.isDestroyed()) window.showInactive();
    }).catch(() => { if (revision === this.revision && this.window === window) this.close(); });
  }
  close(): void { this.revision++; const window = this.window; this.window = undefined; this.ready = undefined; if (window && !window.isDestroyed()) window.destroy(); }
}
