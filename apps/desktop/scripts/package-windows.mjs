import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") throw new Error("Windows desktop packaging must run on Windows.");
const target = process.argv[2];
if (target !== "dir" && target !== "nsis" && target !== "msix") throw new Error("Usage: node scripts/package-windows.mjs <dir|nsis|msix>");

const desktopRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..", "..");
const temp = path.join(workspaceRoot, ".desktop-build-temp");
const cache = path.join(workspaceRoot, ".desktop-build-cache");
await Promise.all([mkdir(temp, { recursive: true }), mkdir(cache, { recursive: true })]);

// The installer ships a pinned, SHA-256 verified uv for local free-search (resources/uv).
const uvCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(desktopRoot, "scripts", "prepare-bundled-uv.mts"), path.join(desktopRoot, "bundled", "uv"), cache], {
    cwd: workspaceRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
if (uvCode !== 0) process.exit(uvCode);

const cli = path.join(desktopRoot, "node_modules", "electron-builder", "cli.js");
const builderTarget = target === "msix" ? "appx" : target;
const args = [cli, "--win", builderTarget, "--x64", "--publish", "never", "--config.electronDist=node_modules/electron/dist"];
const localName = process.argv[3];
if (localName) {
  if (target !== "nsis" || !/^Xiu-[0-9A-Za-z.-]+-local-[a-z0-9-]+-x64\.exe$/.test(localName)) throw new Error("Local installer filename must be an explicit Xiu-<version>-local-<name>-x64.exe basename.");
  args.push(`--config.win.artifactName=${localName}`);
}
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, TEMP: temp, TMP: temp, ELECTRON_BUILDER_CACHE: cache },
  });
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
if (code !== 0) process.exit(code);
