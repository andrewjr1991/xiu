import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const workspace = process.cwd();
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "xiu-package-smoke-"));
const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
// By default each smoke run downloads every dependency into its own throw-away cache, which is the
// slowest step of the Windows CI job. CI points XIU_SMOKE_NPM_CACHE at the cache `npm ci` already
// warmed, so the install only fetches what is missing; the package itself still comes from the tarball.
function npmCacheArguments(temporaryRoot) {
  const shared = process.env.XIU_SMOKE_NPM_CACHE;
  return shared ? [`--cache=${path.resolve(shared)}`, "--prefer-offline"] : [`--cache=${path.join(temporaryRoot, "npm-cache")}`];
}
const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : bundledNpmCli;

if (!existsSync(npmCli)) throw new Error("Could not locate the npm CLI used to run the package smoke test");

function runNpm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], { timeout: 360_000, windowsHide: true, ...options });
}

try {
  const sourceManifest = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
  let archive = process.env.XIU_PACKAGE_ARCHIVE ? path.resolve(process.env.XIU_PACKAGE_ARCHIVE) : undefined;
  if (!archive) {
    const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", temporaryRoot], { cwd: workspace, encoding: "utf8" }));
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
      throw new Error("npm pack did not return exactly one package artifact");
    }
    archive = path.join(temporaryRoot, packed[0].filename);
  }

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
    ...npmCacheArguments(temporaryRoot),
    "--fetch-retries=2",
    "--fetch-timeout=60000",
    archive,
  ], { cwd: installRoot, stdio: "inherit" });

  const manifestPath = path.join(installRoot, "node_modules", "@xiu-ai", "cli", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@xiu-ai/cli" || manifest.version !== sourceManifest.version) {
    throw new Error("installed package identity does not match the source version");
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

  // Exercise the installed command, with no real user configuration or outbound requests.
  const diagnosticHome = path.join(temporaryRoot, "identity-home");
  mkdirSync(diagnosticHome, { mode: 0o700 });
  const networkMarker = path.join(temporaryRoot, "identity-network-attempted");
  const preload = path.join(temporaryRoot, "identity-isolation.mjs");
  writeFileSync(preload, `import os from 'node:os';import fs from 'node:fs';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(diagnosticHome)};const deny=()=>{fs.writeFileSync(${JSON.stringify(networkMarker)},'attempted');throw new Error('Unexpected diagnostic network request');};globalThis.fetch=deny;http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny;syncBuiltinESMExports();`, { mode: 0o600 });
  const identity = JSON.parse(execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, cliPath, "--language", "en", "--trust-workspace", "recover", "identity", "json"], {
    cwd: installRoot, encoding: "utf8", windowsHide: true, timeout: 45_000,
  }));
  if (identity.schemaVersion !== 1 || identity.metadataComplete !== true || identity.ownershipVerified !== false || identity.contentValidated !== false || identity.migrationSupported !== false || identity.changesApplied !== false || readdirSync(diagnosticHome).length || existsSync(networkMarker)) {
    throw new Error("Installed identity preview did not meet its read-only, isolated diagnostic contract.");
  }

  console.log(`Package smoke test passed: ${manifest.name}@${manifest.version}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
