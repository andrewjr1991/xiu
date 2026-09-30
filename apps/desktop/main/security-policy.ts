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
