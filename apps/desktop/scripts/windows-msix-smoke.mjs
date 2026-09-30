import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

if (process.platform !== "win32") throw new Error("MSIX smoke requires Windows.");

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const desktopPackage = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
const packageFile = path.join(desktopRoot, "release", `Xiu-${desktopPackage.version}-x64.msix`);

async function findMakeAppx() {
  const kitsRoot = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const versions = (await fs.readdir(kitsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(kitsRoot, version, "x64", "makeappx.exe");
    try { await fs.access(candidate); return candidate; } catch { /* Try the next installed SDK. */ }
  }
  throw new Error("Windows SDK makeappx.exe was not found.");
}

await fs.access(packageFile);
const output = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-msix-smoke-"));
try {
  const makeAppx = await findMakeAppx();
  await execFileAsync(makeAppx, ["unpack", "/p", packageFile, "/d", output, "/o"], { windowsHide: true });
  const manifest = await fs.readFile(path.join(output, "AppxManifest.xml"), "utf8");
  const required = [
    /<Identity\s[^>]*Name="ai\.xiu\.desktop"[^>]*ProcessorArchitecture="x64"[^>]*Publisher='[^']+'/,
    /<Application\s[^>]*Id="Xiu"[^>]*Executable="app\\Xiu\.exe"[^>]*EntryPoint="Windows\.FullTrustApplication"/,
    /runFullTrust/,
  ];
  for (const pattern of required) if (!pattern.test(manifest)) throw new Error(`MSIX manifest is missing required declaration: ${pattern}`);
  const signed = await fs.access(path.join(output, "AppxSignature.p7x")).then(() => true, () => false);
  if (process.env.CSC_LINK && !signed) throw new Error("CSC_LINK was provided but the MSIX has no package signature.");
  await Promise.all([
    fs.access(path.join(output, "app", "Xiu.exe")),
    fs.access(path.join(output, "AppxBlockMap.xml")),
  ]);
  const stat = await fs.stat(packageFile);
  if (stat.size < 10 * 1024 * 1024) throw new Error("MSIX package is unexpectedly small.");
  console.log(JSON.stringify({
    passed: true,
    package: packageFile,
    bytes: stat.size,
    checks: ["makeappx-unpack", "manifest-identity", "x64-full-trust", "packaged-executable", "block-map"],
    signing: signed ? "package signature present" : "unsigned candidate; Microsoft Store or an enterprise-trusted certificate must sign it before normal deployment",
  }, null, 2));
} finally {
  await fs.rm(output, { recursive: true, force: true });
}
