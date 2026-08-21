import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const registryOrigin = "https://registry.npmjs.org";

export async function fetchArtifactMetadata(packageName, version, fetchImpl = fetch) {
  if (packageName !== "@xiu-ai/cli" || version !== "0.17.0") throw new Error("Only the approved v0.17.0 baseline artifact may be fetched.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(`${registryOrigin}/${encodeURIComponent(packageName)}/${version}`, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Registry metadata request failed with HTTP ${response.status}.`);
    const metadata = await response.json();
    if (metadata.name !== packageName || metadata.version !== version || typeof metadata.dist?.integrity !== "string" || !metadata.dist.integrity.startsWith("sha512-")) throw new Error("Registry returned incomplete or mismatched artifact metadata.");
    const tarball = new URL(metadata.dist.tarball);
    if (tarball.protocol !== "https:" || tarball.hostname !== "registry.npmjs.org") throw new Error("Registry returned an untrusted tarball origin.");
    return { packageName, version, integrity: metadata.dist.integrity, tarball: tarball.href };
  } finally {
    clearTimeout(timer);
  }
}

async function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((item) => typeof item === "string" && item.endsWith(".js"));
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  throw new Error("Unable to locate a safe npm-cli.js next to the active Node.js runtime.");
}

function sanitizedInstallEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (/(?:api.?key|token|secret|password|authorization|cookie|credential)/i.test(name)) delete environment[name];
  return environment;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: sanitizedInstallEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Artifact installation timed out after 90 seconds."));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Artifact installation failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}: ${(stderr || stdout).trim().slice(-1000)}`));
    });
  });
}

export async function installVerifiedArtifact(metadata) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-eval-artifact-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const userConfig = path.join(root, "user.npmrc");
    const globalConfig = path.join(root, "global.npmrc");
    await fs.writeFile(userConfig, "", { encoding: "utf8", flag: "wx" });
    await fs.writeFile(globalConfig, "", { encoding: "utf8", flag: "wx" });
    await run(process.execPath, [await npmCliPath(), "install", "--registry=https://registry.npmjs.org/", `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--no-update-notifier", "--fetch-retries=1", "--fetch-timeout=30000", "--save-exact", `${metadata.packageName}@${metadata.version}`], root);
    const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
    const locked = lock.packages?.[`node_modules/${metadata.packageName}`];
    if (locked?.version !== metadata.version || locked?.integrity !== metadata.integrity) throw new Error("Installed package lock does not match Registry version and integrity.");
    const moduleRoot = path.join(root, "node_modules", ...metadata.packageName.split("/"));
    const manifest = JSON.parse(await fs.readFile(path.join(moduleRoot, "package.json"), "utf8"));
    if (manifest.name !== metadata.packageName || manifest.version !== metadata.version) throw new Error("Installed package manifest does not match the approved artifact.");
    return { root, moduleRoot, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
