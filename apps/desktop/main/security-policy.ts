import path from "node:path";

export const secureWebPreferences = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  safeDialogs: true,
  spellcheck: false,
});

export function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "xiu-app:" && url.host === "bundle";
  } catch {
    return false;
  }
}

/** The parts of Electron's IpcMainInvokeEvent the trust check reads; kept structural so tests need no Electron. */
export interface IpcSenderLike { sender: { id: number }; senderFrame?: { url: string } | null }

/**
 * Privileged channels accept only the main window's own renderer, loaded from
 * the bundled `xiu-app://bundle` origin. `trustedContentsId` is that window's
 * webContents id, or undefined when no main window exists, which rejects all.
 */
export function assertTrustedIpcSender(event: IpcSenderLike, trustedContentsId: number | undefined): void {
  const url = event.senderFrame?.url ?? "";
  if (trustedContentsId === undefined || event.sender.id !== trustedContentsId || !isTrustedRendererUrl(url)) {
    throw new Error("Rejected IPC from an untrusted renderer.");
  }
}

export function resolveRendererAsset(rendererRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname); }
  catch { return undefined; }
  if (decoded.includes("\0")) return undefined;
  const target = path.resolve(rendererRoot, `.${decoded}`);
  const relative = path.relative(rendererRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return target;
}
