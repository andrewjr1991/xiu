import { BrowserWindow, nativeTheme } from "electron";

// A main-process-owned, isolated confirmation. The task renderer cannot resolve it.
export async function confirmFullAccess(parent: BrowserWindow, computerRoute?: string): Promise<boolean> {
  return confirmAction(parent, false, undefined, computerRoute);
}

export async function confirmSubagentCancel(parent: BrowserWindow): Promise<boolean> {
  return confirmAction(parent, true);
}

export async function confirmComputerAction(parent: BrowserWindow, title: string, detail: string, signal?: AbortSignal): Promise<boolean> {
  return confirmAction(parent, false, { title, detail, signal });
}

export async function confirmVisionProbe(parent: BrowserWindow, route: string, signal: AbortSignal, batch = false): Promise<boolean> {
  return confirmAction(parent, false, { title: batch ? "测试全部视觉候选？" : "测试视觉能力？", detail: `${route}\n将发送内置随机数字测试图，不使用你的截图或文件。${batch ? "逐个测试，每个模型只请求一次，不自动重试。" : "只发起一次模型请求。"}可能产生 API 费用；取消不能撤回已发送请求。`, signal, vision: true });
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

async function confirmAction(parent: BrowserWindow, cancelling: boolean, custom?: { title: string; detail: string; signal?: AbortSignal; vision?: boolean }, computerRoute?: string): Promise<boolean> {
  if (custom?.signal?.aborted) return false;
  const window = new BrowserWindow({
    parent, modal: true, width: 560, height: computerRoute ? 600 : custom ? 460 : 390, resizable: false, frame: false,
    minimizable: false, maximizable: false, show: false, autoHideMenuBar: true,
    title: custom ? `Xiu · ${custom.title}` : cancelling ? "Xiu · 取消子任务" : "Xiu · 完全访问权限", backgroundColor: nativeTheme.shouldUseDarkColors ? "#202226" : "#ffffff",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // Custom text is rendered into the static page, escaped, rather than injected as script.
  const heading = custom ? escapeHtml(custom.title) : cancelling ? "停止这个子智能体？" : "开启完全访问权限？";
  const lead = custom
    ? custom.vision ? "测试所选模型的基础图像识别能力。" : "仅操作你明确选择的窗口，不代表授权整个桌面。"
    : cancelling ? "取消后，这个子任务将停止工作；依赖它的任务可能无法继续。" : "Xiu 将自动执行任务操作，包括危险操作，不再逐项请求批准。";
  const warning = custom
    ? escapeHtml(custom.detail).replace(/\n/g, "<br>")
    : cancelling ? "已产生的文件和结果会保留。取消不会撤销修改、删除 Worktree，也不会自动重新执行任务。" : "可访问工作区外的文件、联网并运行本机命令，可能删除文件或修改系统。工作区外修改不保存源码快照，不能保证撤销。";
  const note = custom
    ? custom.vision ? "测试不会授予电脑操作权限，也不代表任务验收通过。关闭、Esc 或取消均不开始测试；不会自动重试。" : "画面可能包含个人信息；确认前请隐藏敏感内容。关闭、Esc 或停止均取消；不会记住授权或自动重试。"
    : cancelling ? "仅停止当前父任务下选中的子任务。整合结果仍需独立确认；取消不授予新的权限。" : "仅本次工作区打开期间有效，重开或重配后撤销。权限不超过当前系统用户；工作区内检查点、Plan 只读、MCP 授权和凭证保护仍独立生效。";
  const acceptLabel = custom ? custom.vision ? "开始测试（可能计费）" : "仅本次允许" : cancelling ? "确认取消子任务" : "开启完全访问";
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>
      *{box-sizing:border-box}body{margin:0;padding:28px;font:14px/1.65 'Segoe UI','Microsoft YaHei',sans-serif;color:#344054;background:#fff;border:1px solid #dce5f0;min-height:100vh}
      #close{position:absolute;right:16px;top:16px;padding:3px 10px;font-size:20px;background:#f5f8fc;color:#65758b}
      .icon{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:#fff1dc;color:#b86e13;font-size:24px}
      h1{margin:14px 0 8px;font-size:21px;color:#172033}p{margin:8px 0;color:#65758b}
      .warning{padding:12px 14px;background:#fff8ec;border:1px solid #f3dfba;border-radius:10px;color:#96621b}
      small{display:block;color:#7c899c;margin-top:12px}footer{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
      button{border:1px solid #dce5f0;border-radius:9px;padding:9px 16px;font:inherit;cursor:pointer;color:#526176;background:#f5f8fc}
      #accept{background:#187fe7;color:white;border-color:#187fe7}button:focus-visible{outline:2px solid #82b9ef;outline-offset:3px}
      ${nativeTheme.shouldUseDarkColors ? "body{background:#202226;color:#e2e5e9;border-color:#3c4149}h1{color:#edf0f4}p,small{color:#bbc1ca}button,#close{background:#30343b;color:#e2e5e9;border-color:#484e59}.warning{background:#352b20;border-color:#665135;color:#edc38e}" : ""}
      ${custom ? "body{height:100vh;display:flex;flex-direction:column;overflow:hidden}.icon{flex-shrink:0}.warning{overflow:auto;min-height:0;overflow-wrap:anywhere}h1,p,small,footer{flex-shrink:0}footer{margin-top:14px}h1{padding-right:12px}" : ""}
    </style><button id="close" aria-label="关闭">×</button><div class="icon">◇</div><h1>${heading}</h1>
    <p>${lead}</p>
    <div class="warning">${warning}</div>
    ${computerRoute ? `<p>同时允许本任务选择普通应用窗口、切到前台并操作，目标截图发送到：</p><div class="warning" style="overflow-wrap:anywhere">${escapeHtml(computerRoute)}</div><p>不再额外确认窗口或普通操作；只截目标窗口。会占用鼠标键盘，请隐藏敏感内容。密码、支付、删除、发布及系统设置流程仍不支持。</p>` : ""}
    <small>${note}</small>
    <footer><button id="cancel">${cancelling ? "继续工作" : "取消"}</button><button id="accept">${acceptLabel}</button></footer></html>`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      custom?.signal?.removeEventListener("abort", abort);
      if (!window.isDestroyed()) window.destroy();
      // Modal teardown must finish before the caller hands focus to the target.
      resolve(accepted);
    };
    const abort = () => finish(false);
    custom?.signal?.addEventListener("abort", abort, { once: true });
    window.once("closed", () => finish(false));
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(async () => {
      if (window.isDestroyed() || parent.isDestroyed()) return finish(false);
      // Install handlers before showing. Enter initially activates Cancel, never Accept.
      const decision = window.webContents.executeJavaScript(`new Promise(resolve => {
        const cancel = document.getElementById('cancel');
        cancel.onclick = () => resolve(false);
        document.getElementById('close').onclick = () => resolve(false);
        document.getElementById('accept').onclick = () => resolve(true);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') resolve(false); });
        cancel.focus();
      })`);
      window.show();
      finish((await decision) === true);
    }).catch(() => finish(false));
  });
}
