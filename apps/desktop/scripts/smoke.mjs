import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "dist/main/index.js",
  "dist/preload/index.cjs",
  "dist/renderer/index.html",
];
for (const file of required) await access(path.join(root, file));
const html = await readFile(path.join(root, "dist/renderer/index.html"), "utf8");
if (!/Content-Security-Policy/.test(html)) throw new Error("Renderer CSP is missing.");
if (/https?:\/\//i.test(html)) throw new Error("Renderer HTML references remote content.");
console.log("Desktop build smoke passed.");
