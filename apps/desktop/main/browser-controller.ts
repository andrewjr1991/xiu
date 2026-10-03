import { randomUUID } from "node:crypto";
import { BrowserWindow, session, WebContentsView } from "electron";
import { validatePublicWebUrl } from "../../../src/web-search.js";
import type { DesktopBrowserRequest, DesktopBrowserState } from "../shared/protocol.js";

/** Human-operated, ephemeral HTTPS reader. No preload, task bridge or agent access. */
export class DesktopBrowserController {
  private view?: WebContentsView;
  private state: DesktopBrowserState = this.empty();
  private generation = 0;
  constructor(private readonly window: BrowserWindow, private readonly emit: (state: DesktopBrowserState) => void, private readonly validateUrl = (url: string) => validatePublicWebUrl(url, {})) {}
  private empty(): DesktopBrowserState { return { url: "", title: "新网页", loading: false, canGoBack: false, canGoForward: false }; }
  private update(): DesktopBrowserState {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) this.state = { ...this.state, url: contents.getURL(), title: contents.getTitle().slice(0, 120) || "网页", loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
    this.emit({ ...this.state }); return { ...this.state };
  }
  private create(): WebContentsView {
    const isolated = session.fromPartition(`xiu-browser-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (!['GET', 'HEAD'].includes(details.method)) { callback({ cancel: true }); return; }
      // Check every subresource and redirect, not only the address bar.
      void this.validateUrl(details.url).then(() => callback({ cancel: false }), () => callback({ cancel: true }));
    });
    const view = new WebContentsView({ webPreferences: { session: isolated, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, devTools: false } });
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => { try { const target = new URL(url); if (target.protocol !== "https:" || target.username || target.password) event.preventDefault(); } catch { event.preventDefault(); } });
    contents.on("will-frame-navigate", (event) => { try { const target = new URL(event.url); if (target.protocol !== "https:" || target.username || target.password) event.preventDefault(); } catch { event.preventDefault(); } });
    contents.on("did-start-loading", () => { this.state.error = undefined; this.update(); });
    contents.on("did-stop-loading", () => this.update());
    contents.on("did-navigate", () => this.update());
    contents.on("did-navigate-in-page", () => this.update());
    contents.on("page-title-updated", () => this.update());
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { this.state.error = "网页无法加载，请检查网址或网络。"; this.update(); } });
    this.window.contentView.addChildView(view); view.setVisible(false);
    this.view = view; return view;
  }
  close(): void {
    this.generation++;
    const view = this.view; this.view = undefined;
    if (view) { this.window.contentView.removeChildView(view); const isolated = view.webContents.session; view.webContents.close(); void isolated.clearStorageData().catch(() => undefined); void isolated.clearCache().catch(() => undefined); }
    this.state = this.empty(); this.emit({ ...this.state });
  }
  async control(request: DesktopBrowserRequest): Promise<DesktopBrowserState> {
    if (!request || typeof request !== "object") throw new Error("无效的网页请求。");
    if (request.action === "close") { this.close(); return { ...this.state }; }
    if (request.action === "navigate") {
      if (typeof request.url !== "string" || request.url.length > 4096) throw new Error("请输入有效的 HTTPS 网址。");
      const generation = ++this.generation;
      const url = await this.validateUrl(request.url).catch(() => { throw new Error("仅支持公开 HTTPS 网页，不支持本地地址、凭据网址或其他协议。"); });
      if (generation !== this.generation || this.window.isDestroyed()) return { ...this.state };
      const view = this.view ?? this.create();
      void view.webContents.loadURL(url.href).catch(() => undefined);
    } else if (request.action === "layout") {
      const b = request.bounds;
      if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || typeof request.visible !== "boolean") throw new Error("无效的网页布局。");
      const [width, height] = this.window.getContentSize();
      const x = Math.max(0, Math.min(width, Math.round(b.x))); const y = Math.max(56, Math.min(height, Math.round(b.y)));
      this.view?.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(b.width))), height: Math.max(0, Math.min(height - y, Math.round(b.height))) });
      this.view?.setVisible(request.visible && b.width > 0 && b.height > 0);
    } else if (["back", "forward", "reload"].includes(request.action)) {
      const contents = this.view?.webContents;
      if (contents && !contents.isDestroyed()) {
        if (request.action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        if (request.action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        if (request.action === "reload") contents.reload();
      }
    } else if (request.action !== "snapshot") throw new Error("不支持的网页操作。");
    return this.update();
  }
}
