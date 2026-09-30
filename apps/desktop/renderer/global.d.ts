import type { XiuDesktopBridge } from "../shared/protocol.js";

declare global {
  interface Window {
    xiuDesktop: XiuDesktopBridge;
  }
}

export {};
