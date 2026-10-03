import { useEffect, useRef, useState } from "react";
import type { DesktopBrowserRequest, DesktopBrowserState } from "../../shared/protocol.js";

export function BrowserPane({ visible }: { visible: boolean }) {
  const [state, setState] = useState<DesktopBrowserState>({ url: "", title: "新网页", loading: false, canGoBack: false, canGoForward: false });
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const area = useRef<HTMLDivElement>(null);
  const observedUrl = useRef("");
  async function control(request: DesktopBrowserRequest) {
    try { setError(""); const next = await window.xiuDesktop.browser(request); setState(next); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  useEffect(() => {
    const unsubscribe = window.xiuDesktop.onBrowserState((next) => { setState(next); if (next.url && next.url !== observedUrl.current) setAddress(next.url); observedUrl.current = next.url; });
    void control({ action: "snapshot" });
    return () => { unsubscribe(); void window.xiuDesktop.browser({ action: "close" }).catch(() => undefined); };
  }, []);
  useEffect(() => {
    let frame = 0;
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = area.current?.getBoundingClientRect(); if (!rect) return;
        // Native remote views must never cover trusted dialogs or popup menus.
        const covered = Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], .dialog-backdrop, .permission-popover, .xiu-select-menu, .workbench-launcher'));
        void window.xiuDesktop.browser({ action: "layout", bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible: visible && !covered && Boolean(state.url) }).catch(() => undefined);
      });
    };
    const resize = new ResizeObserver(layout); if (area.current) resize.observe(area.current);
    const mutations = new MutationObserver(layout); mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", layout); window.addEventListener("scroll", layout, true); layout();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", layout); window.removeEventListener("scroll", layout, true); void window.xiuDesktop.browser({ action: "layout", bounds: { x: 0, y: 56, width: 0, height: 0 }, visible: false }).catch(() => undefined); };
  }, [visible, state.url]);
  return <section className="browser-pane" hidden={!visible}>
    <form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); void control({ action: "navigate", url: /^https?:\/\//i.test(address) ? address : `https://${address}` }); }}>
      <button type="button" aria-label="网页后退" disabled={!state.canGoBack} onClick={() => void control({ action: "back" })}>‹</button><button type="button" aria-label="网页前进" disabled={!state.canGoForward} onClick={() => void control({ action: "forward" })}>›</button><button type="button" aria-label="刷新网页" onClick={() => void control({ action: "reload" })}>↻</button>
      <input aria-label="网页地址" placeholder="输入 HTTPS 网址" value={address} onChange={(event) => setAddress(event.target.value)} /><button type="submit">打开</button>
    </form>
    {(error || state.error) && <p className="browser-error">{error || state.error}</p>}
    <div className="browser-surface" ref={area}>{!state.url && <div className="browser-welcome"><span>◎</span><h3>浏览网页</h3><p className="empty-note">输入公开 HTTPS 网址。此页仅供手动浏览，不接入任务工具。</p><p className="empty-note">暂不支持登录提交、下载及本地网页。</p></div>}</div>
  </section>;
}
