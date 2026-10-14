// Run by package-windows.mjs: node --import tsx prepare-bundled-uv.mts <output directory> <cache directory>
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadUvWheel, extractUv, uvDownloader, UV_VERSION, UV_WHEELS, verifyUvWheel } from "../../../src/uv-install.js";

const [output, cache] = process.argv.slice(2);
if (!output || !cache) throw new Error("Usage: prepare-bundled-uv.mts <output directory> <cache directory>");
const wheel = UV_WHEELS["win32-x64"]!;
const cached = path.join(cache, path.basename(wheel.path));
let bytes = await readFile(cached).catch(() => undefined);
try {
  if (bytes) verifyUvWheel(bytes, wheel);
} catch {
  bytes = undefined;
}
if (!bytes) {
  bytes = await downloadUvWheel(wheel, uvDownloader(process.env.XIU_BUILD_PROXY));
  await mkdir(cache, { recursive: true });
  await writeFile(`${cached}.partial`, bytes);
  await rename(`${cached}.partial`, cached);
}
await rm(output, { recursive: true, force: true });
await extractUv(bytes, wheel, output, "win32");
console.log(`Bundled uv ${UV_VERSION} (win32-x64) prepared in ${output}.`);
