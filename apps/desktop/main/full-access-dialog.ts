import { BrowserWindow } from "electron";

// A main-process-owned, isolated confirmation. The task renderer cannot resolve it.
export async function confirmFullAccess(parent: BrowserWindow): Promise<boolean> {
  return confirmAction(parent, false);
}

export async function confirmSubagentCancel(parent: BrowserWindow): Promise<boolean> {
  return confirmAction(parent, true);
}

async function confirmAction(parent: BrowserWindow, cancelling: boolean): Promise<boolean> {
  const window = new BrowserWindow({
    parent, modal: true, width: 560, height: 390, resizable: false, frame: false,
    minimizable: false, maximizable: false, show: false, autoHideMenuBar: true,
    title: cancelling ? "Xiu · 取消子任务" : "Xiu · 完全访问权限", backgroundColor: "#ffffff",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
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
    </style><button id="close" aria-label="关闭">×</button><div class="icon">◇</div><h1>${cancelling ? "停止这个子智能体？" : "开启完全访问权限？"}</h1>
    <p>${cancelling ? "取消后，这个子任务将停止工作；依赖它的任务可能无法继续。" : "Xiu 将自动执行任务操作，包括危险操作，不再逐项请求批准。"}</p>
    <div class="warning">${cancelling ? "已产生的文件和结果会保留。取消不会撤销修改、删除 Worktree，也不会自动重新执行任务。" : "可访问工作区外的文件、联网并运行本机命令，可能删除文件或修改系统。工作区外修改不保存源码快照，不能保证撤销。"}</div>
    <small>${cancelling ? "仅停止当前父任务下选中的子任务。整合结果仍需独立确认；取消不授予新的权限。" : "仅本次工作区打开期间有效，重开或重配后撤销。权限不超过当前系统用户；工作区内检查点、Plan 只读、MCP 授权和凭证保护仍独立生效。"}</small>
    <footer><button id="cancel">${cancelling ? "继续工作" : "取消"}</button><button id="accept">${cancelling ? "确认取消子任务" : "开启完全访问"}</button></footer></html>`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
      if (!window.isDestroyed()) window.close();
    };
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
