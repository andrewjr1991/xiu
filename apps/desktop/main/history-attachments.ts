import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RuntimeEvent } from "../../../src/runtime/protocol.js";
import type { DesktopAttachment } from "../shared/protocol.js";

const managedUpload = (file: string) => /^\.xiu\/attachments\/[^/\\\x00-\x1f:]+$/.test(file) && ![".", ".."].includes(path.posix.basename(file));
const canonical = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

/** Restore only managed uploads, never arbitrary paths found in history text. */
export function historyAttachmentReferences(events: RuntimeEvent[], messages: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const event of events) {
    if (event.type !== "task.started" && event.type !== "task.steered") continue;
    const short = String(event.type === "task.started" ? event.payload.taskPreview : event.payload.text);
    const candidates = messages.filter(text => text.startsWith(short));
    const text = candidates.length === 1 ? candidates[0]! : short;
    const references: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*@(?:("[^"\r\n]+")|(\.xiu\/attachments\/[^\s]+))\s*$/.exec(line);
      if (!match) continue;
      let file: string;
      try { file = match[1] ? JSON.parse(match[1]) as string : match[2]!; } catch { continue; }
      if (managedUpload(file) && !references.includes(file)) references.push(file);
      if (references.length >= 10) break;
    }
    if (references.length) result[event.eventId] = references;
  }
  return result;
}

export async function restoreHistoryAttachments(workspace: string, references: Record<string, string[]>, thumbnail: (data: Buffer) => string | undefined): Promise<Record<string, DesktopAttachment[]>> {
  const result: Record<string, DesktopAttachment[]> = {};
  const root = await fs.realpath(workspace);
  let bytes = 0, count = 0;
  for (const [eventId, files] of Object.entries(references)) {
    const items: DesktopAttachment[] = [];
    for (const file of files) {
      if (!managedUpload(file)) continue;
      const reference = /\s/.test(file) ? `@${JSON.stringify(file)}` : `@${file}`;
      const item: DesktopAttachment = { reference, path: file, name: path.posix.basename(file), bytes: 0, kind: /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(file) ? "image" : "file" };
      try {
        if (++count > 100) throw Error("History attachment display limit");
        let candidate = root;
        for (const segment of file.split("/")) {
          candidate = path.join(candidate, segment);
          const stat = await fs.lstat(candidate);
          if (stat.isSymbolicLink() || canonical(await fs.realpath(candidate)) !== canonical(candidate)) throw Error("Unsafe upload");
        }
        const handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 25 * 1024 * 1024 || bytes + stat.size > 50 * 1024 * 1024) throw Error("Unavailable upload");
          const current = await fs.lstat(candidate);
          if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || canonical(await fs.realpath(candidate)) !== canonical(candidate)) throw Error("Changed upload path");
          item.bytes = stat.size;
          if (item.kind === "image") {
            bytes += stat.size;
            const data = Buffer.alloc(stat.size);
            const read = await handle.read(data, 0, data.length, 0);
            const after = await handle.stat();
            if (read.bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error("Changed upload");
            const preview = thumbnail(data);
            if (preview && preview.length <= 128 * 1024) item.previewDataUrl = preview;
          }
        } finally { await handle.close(); }
      } catch { item.unavailable = true; }
      items.push(item);
    }
    if (items.length) result[eventId] = items;
  }
  return result;
}
