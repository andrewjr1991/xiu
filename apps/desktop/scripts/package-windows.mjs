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

const cli = path.join(desktopRoot, "node_modules", "electron-builder", "cli.js");
const builderTarget = target === "msix" ? "appx" : target;
const args = [cli, "--win", builderTarget, "--x64", "--config.electronDist=node_modules/electron/dist"];
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
