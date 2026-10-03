import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "dist/main/index.js",
  "dist/main/background-worker.mjs",
  "dist/preload/index.cjs",
  "dist/renderer/index.html",
];
for (const file of required) await access(path.join(root, file));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (!metadata.build.files.includes("!node_modules/@xiu-ai/cli{,/**/*}")) {
  throw new Error("Packaging must exclude the linked CLI repository; shared core is bundled.");
}
const main = await readFile(path.join(root, "dist/main/index.js"), "utf8");
if (/(?:from\s*|import\s*\(|require\s*\()\s*["']@xiu-ai\/cli(?:\/|["'])/.test(main)) {
  throw new Error("Desktop main still depends on the excluded CLI package.");
}
const html = await readFile(path.join(root, "dist/renderer/index.html"), "utf8");
if (!/Content-Security-Policy/.test(html)) throw new Error("Renderer CSP is missing.");
if (/https?:\/\//i.test(html)) throw new Error("Renderer HTML references remote content.");
if (/script-src[^;]*(?:unsafe-inline|unsafe-eval)/i.test(html)) throw new Error("Renderer CSP permits unsafe scripts.");
console.log("Desktop build smoke passed.");
