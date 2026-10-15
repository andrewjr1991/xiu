import { build } from "esbuild";
import { mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import "./build-computer-bridge.mjs";

const localPath = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const desktopVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

await rm(new URL("../dist/main/", import.meta.url), { recursive: true, force: true });
await rm(new URL("../dist/preload/", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist/main/", import.meta.url), { recursive: true });
await mkdir(new URL("../dist/preload/", import.meta.url), { recursive: true });

await build({
  entryPoints: [localPath("../main/index.ts")],
  outfile: localPath("../dist/main/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  define: { __XIU_MCP_CLIENT_VERSION__: JSON.stringify(desktopVersion) },
  external: ["electron", "@napi-rs/keyring", "node-pty", "typescript"],
  banner: { js: 'import { createRequire as __xiuCreateRequire } from "node:module"; const require = __xiuCreateRequire(import.meta.url);' },
  sourcemap: true,
});

await build({
  entryPoints: [localPath("../preload/index.ts")],
  outfile: localPath("../dist/preload/index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
});

await build({
  entryPoints: [localPath("../../../src/background-worker.ts")],
  outfile: localPath("../dist/main/background-worker.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
});

// SHA-256 of every file electron-builder unpacks next to app.asar (see
// `asarUnpack`), shipped inside the asar as dist/main/unpacked-manifest.json so
// the main process can verify the unpacked copies before starting them (S6).
const distUrl = new URL("../dist/", import.meta.url);
const nativeExecutables = (await readdir(new URL("native/", distUrl)).catch(() => [])).filter((name) => name.endsWith(".exe")).sort().map((name) => `native/${name}`);
const files = {};
for (const relative of ["main/background-worker.mjs", ...nativeExecutables]) {
  files[relative] = createHash("sha256").update(await readFile(new URL(relative, distUrl))).digest("hex");
}
await writeFile(new URL("main/unpacked-manifest.json", distUrl), `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
