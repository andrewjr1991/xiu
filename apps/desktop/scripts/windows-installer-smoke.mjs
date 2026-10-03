import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") throw new Error("Windows installer smoke only runs on Windows.");
const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const installer = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "release", `Xiu-${version}-x64.exe`);
await access(installer);
const temp = await mkdtemp(path.join(os.tmpdir(), "xiu-installer-smoke-"));
const installDir = path.join(temp, "Xiu 验收 App");
const smokeLog = path.join(temp, "startup.log");
const localAppData = path.join(temp, "LocalAppData");
const appData = path.join(temp, "AppData");
const processTemp = path.join(temp, "Temp");
const userData = path.join(temp, "UserData");
await Promise.all([localAppData, appData, processTemp, userData].map((directory) => mkdir(directory, { recursive: true })));
const isolatedEnv = { LOCALAPPDATA: localAppData, APPDATA: appData, TEMP: processTemp, TMP: processTemp };
const run = (file, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true, stdio: "inherit", env: { ...process.env, ...env } });
  const timeout = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} timed out.`)); }, 120_000);
  child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited with ${code}.`)); });
});
const waitForLog = async (file, marker) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { if ((await readFile(file, "utf8")).includes(marker)) return; } catch { /* Wait for startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for installed startup marker: ${marker}`);
};
let passed = false;
try {
  await run(installer, ["/S", `/D=${installDir}`], isolatedEnv);
  const executable = path.join(installDir, "Xiu.exe");
  await access(executable);
  await run(executable, ["--smoke-test", `--user-data-dir=${userData}`], { ...isolatedEnv, XIU_DESKTOP_SMOKE_LOG: smokeLog });
  const startup = await readFile(smokeLog, "utf8");
  if (!startup.includes("load-finished")) throw new Error("Installed Xiu did not finish loading.");

  const sentinel = path.join(userData, "g5c-upgrade-sentinel.txt");
  await writeFile(sentinel, "preserve", "utf8");
  await run(installer, ["/S", `/D=${installDir}`], isolatedEnv);
  await access(executable);
  if ((await readFile(sentinel, "utf8")) !== "preserve") throw new Error("In-place upgrade removed user data.");
  await run(executable, ["--smoke-test", `--user-data-dir=${userData}`], { ...isolatedEnv, XIU_DESKTOP_SMOKE_LOG: smokeLog });

  await writeFile(smokeLog, "", "utf8");
  const interrupted = spawn(executable, [`--user-data-dir=${userData}`], { windowsHide: true, stdio: "ignore", env: { ...process.env, ...isolatedEnv, XIU_DESKTOP_SMOKE_LOG: smokeLog, XIU_DESKTOP_SMOKE_HOLD: "1" } });
  await waitForLog(smokeLog, "load-finished");
  const interruptedExit = new Promise((resolve) => interrupted.once("exit", resolve));
  interrupted.kill();
  await interruptedExit;
  await writeFile(smokeLog, "", "utf8");
  await run(executable, ["--smoke-test", `--user-data-dir=${userData}`], { ...isolatedEnv, XIU_DESKTOP_SMOKE_LOG: smokeLog });
  if (!(await readFile(smokeLog, "utf8")).includes("load-finished")) throw new Error("Installed Xiu did not restart after interruption.");

  const uninstaller = path.join(installDir, "Uninstall Xiu.exe");
  await access(uninstaller);
  await run(uninstaller, ["/S"], isolatedEnv);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try { await access(executable); await new Promise((resolve) => setTimeout(resolve, 100)); }
    catch { passed = true; console.log(JSON.stringify({ passed: true, installer, checks: ["fresh-install", "installed-startup", "in-place-upgrade", "interrupted-restart", "uninstall"] }, null, 2)); break; }
  }
  if (!passed) throw new Error(`Uninstall did not remove Xiu.exe. Acceptance files remain at ${temp}`);
} finally {
  if (passed) await rm(temp, { recursive: true, force: true }).catch(() => {});
}
