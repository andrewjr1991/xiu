import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "xiu-package-smoke-"));
const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : bundledNpmCli;

if (!existsSync(npmCli)) throw new Error("Could not locate the npm CLI used to run the package smoke test");

function runNpm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], { timeout: 180_000, windowsHide: true, ...options });
}

try {
  const packOutput = runNpm(["pack", "--json", "--pack-destination", temporaryRoot], {
    cwd: workspace,
    encoding: "utf8",
  });
  const packed = JSON.parse(packOutput);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error("npm pack did not return exactly one package artifact");
  }

  const archive = path.join(temporaryRoot, packed[0].filename);
  const installRoot = path.join(temporaryRoot, "install");
  mkdirSync(installRoot);
  runNpm(["init", "-y"], { cwd: installRoot, stdio: "ignore" });
  runNpm([
    "install",
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--registry=https://registry.npmjs.org",
    `--cache=${path.join(temporaryRoot, "npm-cache")}`,
    "--fetch-retries=1",
    "--fetch-timeout=60000",
    archive,
  ], { cwd: installRoot, stdio: "inherit" });

  const manifestPath = path.join(installRoot, "node_modules", "@xiu-ai", "cli", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@xiu-ai/cli" || manifest.version !== packed[0].version) {
    throw new Error("installed package identity does not match npm pack output");
  }

  const cliPath = path.join(installRoot, "node_modules", "@xiu-ai", "cli", "dist", "cli.js");
  const reportedVersion = execFileSync(process.execPath, [cliPath, "--version"], {
    cwd: installRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (reportedVersion !== manifest.version) {
    throw new Error(`installed CLI reported ${reportedVersion || "no version"}; expected ${manifest.version}`);
  }

  console.log(`Package smoke test passed: ${manifest.name}@${manifest.version}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
