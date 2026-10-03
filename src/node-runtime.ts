import fs from "node:fs/promises";
import path from "node:path";

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
