import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const workspace = process.cwd();
const expectedPlatform = process.env.XIU_EXPECTED_PLATFORM;
if (expectedPlatform && process.platform !== expectedPlatform) {
  throw new Error(`Platform runner mismatch: expected ${expectedPlatform}, received ${process.platform}`);
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "xiu-platform-空格-"));
const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
// By default each smoke run downloads every dependency into its own throw-away cache, which is the
// slowest step of the Windows CI job. CI points XIU_SMOKE_NPM_CACHE at the cache `npm ci` already
// warmed, so the install only fetches what is missing; the package itself still comes from the tarball.
function npmCacheArguments(temporaryRoot) {
  const shared = process.env.XIU_SMOKE_NPM_CACHE;
  return shared ? [`--cache=${path.resolve(shared)}`, "--prefer-offline"] : [`--cache=${path.join(temporaryRoot, "npm-cache")}`];
}
const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath) ? process.env.npm_execpath : bundledNpmCli;
if (!existsSync(npmCli)) throw new Error("Could not locate npm CLI for platform smoke test");

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], { timeout: 360_000, windowsHide: true, ...options });
}

function runLauncher(launcher, args) {
  if (process.platform === "win32") {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& ${quote(launcher)} ${args.map(quote).join(" ")}`], {
      encoding: "utf8",
      windowsHide: true,
    });
  }
  return execFileSync(launcher, args, { encoding: "utf8" });
}

async function waitForCompletion(background, id) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const item = background.list().find((candidate) => candidate.id === id);
    if (item && !item.running) return item;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged background task did not finish within 20 seconds");
}

try {
  const sourceManifest = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
  let archive = process.env.XIU_PACKAGE_ARCHIVE ? path.resolve(process.env.XIU_PACKAGE_ARCHIVE) : undefined;
  if (!archive) {
    const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", temporaryRoot], { cwd: workspace, encoding: "utf8" }));
    if (!Array.isArray(packed) || packed.length !== 1) throw new Error("npm pack did not return one archive");
    archive = path.join(temporaryRoot, packed[0].filename);
  }

  const installRoot = path.join(temporaryRoot, "安装 路径", "workspace");
  mkdirSync(installRoot, { recursive: true });
  npm(["init", "-y"], { cwd: installRoot, stdio: "ignore" });
  npm([
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    ...npmCacheArguments(temporaryRoot),
    "--fetch-retries=2", "--fetch-timeout=60000",
    archive,
  ], { cwd: installRoot, stdio: "inherit" });
  console.log("Platform smoke: package installed");

  const packageRoot = path.join(installRoot, "node_modules", "@xiu-ai", "cli");
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@xiu-ai/cli" || manifest.version !== sourceManifest.version) throw new Error("Installed package identity does not match the source version");
  const binDirectory = path.join(installRoot, "node_modules", ".bin");
  const launcher = path.join(binDirectory, process.platform === "win32" ? "xiu.cmd" : "xiu");
  if (!existsSync(launcher)) throw new Error(`Installed xiu launcher is missing: ${launcher}`);
  const reportedVersion = runLauncher(launcher, ["--version"]).trim();
  if (reportedVersion !== manifest.version) throw new Error(`Launcher reported ${reportedVersion}; expected ${manifest.version}`);
  console.log("Platform smoke: launcher passed");

  const updates = await import(pathToFileURL(path.join(packageRoot, "dist", "update-check.js")).href);
  const resolution = await updates.inspectXiuCommandResolution({ packageRoot, pathEntries: [binDirectory], platform: process.platform });
  if (!resolution.first?.packageRoot || resolution.first.version !== manifest.version) {
    throw new Error(`Update diagnostics could not resolve the packaged launcher: ${JSON.stringify(resolution.first)}`);
  }
  console.log("Platform smoke: command resolution passed");

  const { BackgroundManager } = await import(pathToFileURL(path.join(packageRoot, "dist", "background.js")).href);
  const backgroundRoot = path.join(temporaryRoot, "后台 状态");
  const background = new BackgroundManager({ workspace: installRoot, storageRoot: backgroundRoot });
  const backgroundCommand = process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' -e "console.log('platform-unicode-通过')"`
    : `${JSON.stringify(process.execPath)} -e "console.log('platform-unicode-通过')"`;
  const started = background.start(backgroundCommand);
  const completed = await waitForCompletion(background, started.id);
  console.log(`Platform smoke: background ended as ${completed.state}`);
  const backgroundOutput = background.readOutput(started.id).text;
  if (completed.state !== "completed") throw new Error(`Packaged background task ended as ${completed.state}: ${backgroundOutput}`);
  if (!backgroundOutput.includes("platform-unicode-通过")) {
    throw new Error("Packaged background task lost Unicode output");
  }

  console.log(`Platform smoke passed: ${process.platform} ${process.arch}, Node ${process.version}, ${manifest.name}@${manifest.version}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
