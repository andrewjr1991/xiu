import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const localPath = (relative) => fileURLToPath(new URL(relative, import.meta.url));

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
  external: ["electron", "@napi-rs/keyring", "typescript"],
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
