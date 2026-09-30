import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(desktopRoot, "assets", "icon.svg");
const icon = path.join(desktopRoot, "assets", "icon.png");
const packagedIcon = path.join(desktopRoot, "dist", "assets", "icon.png");

await mkdir(path.dirname(packagedIcon), { recursive: true });
await sharp(source).resize(512, 512).png().toFile(icon);
await sharp(source).resize(512, 512).png().toFile(packagedIcon);
