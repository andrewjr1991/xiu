import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import yauzl from "yauzl";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;

/** Snapshot a bounded local file; do not trust its initial size alone. */
export async function readSkillImportFile(source: string): Promise<Buffer> {
  const handle = await fs.open(source, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Skill import exceeds the 20 MB safety limit.");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      total += chunk.length;
      if (total > MAX_BYTES) throw new Error("Skill import exceeds the 20 MB safety limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

// ZIP names must be portable to Windows as well as POSIX; reject aliases and ADS.
function archivePath(name: string): string {
  const value = name.endsWith("/") ? name.slice(0, -1) : name;
  const parts = value.split("/");
  if (name.length > 1024 || parts.length > 32 || parts.some((part) => !part || part === "." || part === ".."
    || /[\\:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("ZIP contains an unsafe or non-portable path.");
  }
  return parts.join("/");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Bounded extraction into a new host-owned staging directory, never an install destination. */
export async function extractSkillArchive(source: string, destination: string): Promise<void> {
  const bytes = await readSkillImportFile(source);
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const paths = new Map<string, { name: string; directory: boolean; explicit: boolean }>();
  let total = 0;
  let declared = 0;
  let entries = 0;
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new Error("ZIP exceeds the 1000-entry safety limit.");
    await fs.mkdir(destination, { recursive: true });
    for await (const entry of zip.eachEntry()) {
      if (++entries > MAX_ENTRIES) throw new Error("ZIP exceeds the 1000-entry safety limit.");
      const relative = archivePath(entry.fileName);
      const directory = entry.fileName.endsWith("/");
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0x400)
        || (!directory && Boolean(entry.externalFileAttributes & 0x10))
        || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) {
        throw new Error("ZIP links, special files, encryption or unsupported compression are not allowed.");
      }
      const components = relative.split("/");
      for (let index = 1; index <= components.length; index++) {
        const name = components.slice(0, index).join("/");
        const key = name.toLowerCase();
        const isDirectory = index < components.length || directory;
        const explicit = index === components.length;
        const previous = paths.get(key);
        if (previous && (previous.name !== name || previous.directory !== isDirectory || (explicit && previous.explicit))) {
          throw new Error("ZIP contains duplicate or conflicting paths.");
        }
        paths.set(key, { name, directory: isDirectory, explicit: explicit || Boolean(previous?.explicit) });
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new Error("Invalid ZIP size.");
      declared += entry.uncompressedSize;
      if (declared > MAX_BYTES || (directory && entry.uncompressedSize !== 0)) throw new Error("ZIP exceeds the 20 MB safety limit or has invalid directories.");
      const target = path.join(destination, ...components);
      if (directory) { await fs.mkdir(target, { recursive: true }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      let crc = 0xffffffff;
      let fileBytes = 0;
      const output = await fs.open(target, "wx");
      let stream: Readable | undefined;
      try {
        stream = await zip.openReadStreamPromise(entry);
        for await (const chunk of stream) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += data.length;
          fileBytes += data.length;
          if (total > MAX_BYTES || fileBytes > entry.uncompressedSize) throw new Error("ZIP exceeds its declared size or the 20 MB safety limit.");
          for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
          await output.writeFile(data);
        }
        if (fileBytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error("ZIP integrity check failed.");
      } finally { stream?.destroy(); await output.close(); }
    }
  } finally { zip.close(); }
}
