import { spawn, type ChildProcess } from "node:child_process";
import { verifiedComponentPath } from "./unpacked-integrity.js";
import { fileURLToPath } from "node:url";
import type { ComputerWindow } from "../shared/computer-use.js";

/** Error codes the native helper may report; every code must have a user-facing reason here. */
export const BRIDGE_ERROR_REASONS: Record<string, string> = {
  "sensitive-control-denied": "检测到密码控件，已拒绝截图或输入，请由用户接管。",
  "sensitive-window-denied": "目标属于敏感应用或标题含敏感内容，已拒绝，请由用户接管。",
  "consequential-control-denied": "检测到删除、发送、支付或其他高风险控件，请停止并由用户操作。",
  "control-uninspected": "无法识别目标控件，未发送输入。",
  "element-changed-observe-again": "目标控件已变化，未发送输入，请重新观察。",
  "target-not-foreground": "未取得目标窗口焦点。请手动切换到目标应用后重新观察。",
  "target-occluded": "点击位置被其他窗口遮挡，未发送输入。",
  "release-held-input": "请先松开鼠标和修饰键，再重新观察。",
  "window-resized-observe-again": "窗口尺寸已变化，未发送输入，请重新观察。",
  "window-identity-changed": "窗口身份或标题已变化，请重新授权。",
  "input-blocked-or-partial-do-not-retry": "系统阻止或仅部分执行输入，结果未知，请观察实际反馈。",
  "focus-changed-outcome-unknown": "输入时焦点发生变化，结果未知，请检查实际反馈。",
  "window-capture-not-supported": "此应用不支持窗口截图。",
  "window-capture-too-large": "窗口截图超过大小限制，请缩小窗口后重新观察。",
  "window-unavailable": "目标窗口不可用或已关闭。",
};

export class ComputerBridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ComputerBridgeError"; }
}

export class WindowsComputer {
  private readonly executable: string;
  /** Runs before every spawn; the packaged default compares the unpacked bridge with the asar manifest (S6). */
  private readonly verify: () => void;
  constructor(executable?: string, verify?: () => void) {
    this.executable = executable ?? fileURLToPath(new URL("../native/XiuComputerBridge.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    this.verify = verify ?? (executable ? () => undefined : () => { verifiedComponentPath("native/XiuComputerBridge.exe"); });
  }
  private children = new Set<ChildProcess>();
  stop(): void { for (const child of this.children) child.kill(); this.children.clear(); }
  async request<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (process.platform !== "win32" || signal?.aborted) throw new Error("电脑操作不可用或已取消。");
    return new Promise((resolve, reject) => {
      try { this.verify(); } catch (error) { reject(error); return; }
      const child = spawn(this.executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      this.children.add(child);
      let output = "", settled = false;
      const finish = (error?: Error, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); this.children.delete(child); child.kill(); error ? reject(error) : resolve(value!); };
      const abort = () => finish(new Error("电脑操作已停止；未自动重试。"));
      const timer = setTimeout(() => finish(new Error("目标窗口无响应；结果可能未知，请重新观察，不会重放操作。")), 8000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", () => finish(new Error("Windows 电脑操作组件无法启动。")));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; if (output.length > 12_000_000) finish(new Error("窗口截图超过限制。")); });
      child.once("close", () => {
        try {
          const result = JSON.parse(output);
          const code = typeof result.error === "string" ? result.error : "unknown";
          result.ok ? finish(undefined, result.value as T) : finish(new ComputerBridgeError(code, `${BRIDGE_ERROR_REASONS[code] ?? "窗口不可用或输入被系统拒绝。"} 不会自动重试。`));
        } catch { finish(new Error("电脑操作未返回完整结果；不会自动重试。")); }
      });
      child.stdin.on("error", () => finish(new Error("电脑操作通信中断；不会自动重试。")));
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
  list(): Promise<ComputerWindow[]> { return this.request({ action: "list" }); }
}
