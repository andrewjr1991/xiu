import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(desktopRoot, "assets", "icon.svg");
const icon = path.join(desktopRoot, "assets", "icon.png");
const windowsIcon = path.join(desktopRoot, "assets", "icon.ico");
const packagedIcon = path.join(desktopRoot, "dist", "assets", "icon.png");

await mkdir(path.dirname(packagedIcon), { recursive: true });
await sharp(source).resize(512, 512).png().toFile(icon);
const icoPng = await sharp(source).resize(256, 256).png().toBuffer();
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt8(0, 6);
icoHeader.writeUInt8(0, 7);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(icoPng.length, 14);
icoHeader.writeUInt32LE(icoHeader.length, 18);
await writeFile(windowsIcon, Buffer.concat([icoHeader, icoPng]));
await sharp(source).resize(512, 512).png().toFile(packagedIcon);
