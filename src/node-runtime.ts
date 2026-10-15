import fs from "node:fs/promises";
import path from "node:path";
import { localize, type UiLanguage } from "./i18n.js";

/** Electron's executable is not Node (the production RunAsNode fuse is disabled). */
export async function resolveNodeRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!process.versions.electron) return process.execPath;
  const directories = (environment.PATH ?? environment.Path ?? "").split(path.delimiter).filter(Boolean);
  if (environment.NVM_SYMLINK) directories.push(environment.NVM_SYMLINK);
  if (environment.NVM_HOME) {
    const versions = await fs.readdir(environment.NVM_HOME).catch(() => [] as string[]);
    directories.push(...versions.filter((name) => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((name) => path.join(environment.NVM_HOME!, name)));
  }
  for (const directory of [...new Set(directories)]) {
    const candidate = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
    if (path.resolve(candidate).toLowerCase() === process.execPath.toLowerCase()) continue;
    if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error("XIU_NODE_NOT_FOUND: Install Node.js or add its directory to the user PATH, then restart Xiu.");
}

/** Node 20 reached end of life on 2026-04-30; Xiu 0.22 raises `engines` to 22.12. One line, once per start, nothing else changes. */
export function nodeDeprecationNotice(version: string, language: UiLanguage): string | undefined {
  const major = Number(/^v?(\d+)/.exec(version.trim())?.[1] ?? 0);
  if (major !== 20) return undefined;
  return localize(language,
    `提示：当前 Node.js ${version} 已于 2026-04-30 停止维护。Xiu 0.22 起要求 Node.js 22.12 或更高版本，请尽早升级到 Node 22 LTS 后重新安装 @xiu-ai/cli。`,
    `Notice: Node.js ${version} reached end of life on 2026-04-30. Xiu 0.22 will require Node.js 22.12 or newer; upgrade to Node 22 LTS and reinstall @xiu-ai/cli.`);
}
