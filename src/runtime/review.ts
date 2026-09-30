import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { load } from "cheerio";
import { redactSecrets } from "../secret-redaction.js";
import { resolveWorkspacePath } from "../workspace-path.js";

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 800;
const EXCLUDED_DIRECTORIES = new Set([".git", ".xiu", "node_modules"]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const AUDIO_TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".opus": "audio/ogg", ".aac": "audio/aac", ".flac": "audio/flac" };
const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };

export interface ReviewFileEntry {
  path: string;
  kind: "text" | "markdown" | "html" | "image" | "audio" | "video" | "binary";
  bytes: number;
}

export interface ReviewFilePreview {
  path: string;
  kind: ReviewFileEntry["kind"];
  bytes: number;
  truncated: boolean;
  source?: string;
  safeHtml?: string;
  dataUrl?: string;
  warning?: string;
}

function isSensitivePath(relative: string): boolean {
  const parts = relative.replace(/\\/g, "/").split("/");
  return parts.some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.ssh|\.aws|\.azure|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(part))
    || /\.(?:pem|key|p12|pfx|keystore)$/i.test(relative);
}

function validRelativePath(relative: string): boolean {
  if (!relative || relative.length > 1_000 || relative.includes("\0") || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) return false;
  const parts = relative.replace(/\\/g, "/").split("/");
  return !parts.some((part) => !part || part === "." || part === ".." || EXCLUDED_DIRECTORIES.has(part.toLowerCase())) && !isSensitivePath(relative);
}

async function safeRegularFile(workspace: string, relative: string): Promise<{ root: string; target: string; stat: Stats }> {
  if (!validRelativePath(relative)) throw new Error("该文件不能在审查器中打开。");
  const root = await fs.realpath(workspace);
  const target = resolveWorkspacePath(root, relative);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const item = await fs.lstat(current);
    if (item.isSymbolicLink()) throw new Error("审查器不会跟随符号链接或 Junction。");
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile()) throw new Error("只能预览工作区内的普通文件。");
  return { root, target, stat };
}

function fileKind(relative: string, data?: Buffer): ReviewFileEntry["kind"] {
  const extension = path.extname(relative).toLowerCase();
  if (IMAGE_TYPES[extension]) return "image";
  if (AUDIO_TYPES[extension]) return "audio";
  if (VIDEO_TYPES[extension]) return "video";
  if ([".md", ".markdown"].includes(extension)) return "markdown";
  if ([".html", ".htm"].includes(extension)) return "html";
  if (data?.includes(0)) return "binary";
  return "text";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function markdownToSafeHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let inCode = false;
  const output: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) { output.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    const escaped = escapeHtml(line);
    if (inCode) { output.push(`${escaped}\n`); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(escaped);
    if (heading) output.push(`<h${heading[1]!.length}>${heading[2]}</h${heading[1]!.length}>`);
    else if (/^[-*]\s+/.test(escaped)) output.push(`<p>• ${escaped.replace(/^[-*]\s+/, "")}</p>`);
    else output.push(escaped ? `<p>${escaped}</p>` : "<br>");
  }
  if (inCode) output.push("</code></pre>");
  return output.join("");
}

const ALLOWED_HTML = new Set(["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "code", "blockquote", "strong", "b", "em", "i", "table", "thead", "tbody", "tr", "th", "td"]);
const REMOVE_WITH_CONTENT = "script,style,template,noscript,iframe,frame,object,embed,svg,math,form,input,button,textarea,select,option,link,meta,base,audio,video,source,canvas";

export function sanitizeHtmlPreview(source: string): string {
  const $ = load(source, { xmlMode: false }, false);
  $(REMOVE_WITH_CONTENT).remove();
  $("*").each((_index, element) => {
    if (!("attribs" in element) || !("tagName" in element)) return;
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_HTML.has(tag)) { $(element).replaceWith($(element).contents()); return; }
    for (const attribute of Object.keys(element.attribs ?? {})) $(element).removeAttr(attribute);
  });
  const body = $.root().html() ?? "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;padding:20px;color:#253044;background:#fff;font:14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}pre,code{font-family:ui-monospace,Consolas,monospace}pre{padding:12px;border-radius:10px;background:#f3f6fa;white-space:pre-wrap}table{border-collapse:collapse}td,th{padding:6px 9px;border:1px solid #dfe5ee}blockquote{margin-left:0;padding-left:14px;border-left:3px solid #b8d8fb;color:#667085}</style></head><body>${body}</body></html>`;
}

export async function listReviewFiles(workspace: string): Promise<ReviewFileEntry[]> {
  const root = await fs.realpath(workspace);
  const files: ReviewFileEntry[] = [];
  async function walk(relative: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    const directory = resolveWorkspacePath(root, relative || ".");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) break;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (!validRelativePath(next)) continue;
      const target = (() => {
        try { return resolveWorkspacePath(root, next); }
        catch { return undefined; }
      })();
      if (!target) continue;
      const stat = await fs.lstat(target).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(next);
      else if (stat.isFile()) files.push({ path: next, kind: fileKind(next), bytes: stat.size });
    }
  }
  await walk("");
  return files;
}

export async function previewReviewFile(workspace: string, relative: string): Promise<ReviewFilePreview> {
  const { target, stat } = await safeRegularFile(workspace, relative);
  const extension = path.extname(relative).toLowerCase();
  if (IMAGE_TYPES[extension] && stat.size > MAX_IMAGE_BYTES) return { path: relative, kind: "image", bytes: stat.size, truncated: true, warning: "图片超过 2 MiB，未载入预览。" };
  const mediaType = AUDIO_TYPES[extension] ?? VIDEO_TYPES[extension];
  const mediaKind = AUDIO_TYPES[extension] ? "audio" as const : VIDEO_TYPES[extension] ? "video" as const : undefined;
  if (mediaType && stat.size > MAX_MEDIA_BYTES) return { path: relative, kind: mediaKind!, bytes: stat.size, truncated: true, warning: "媒体文件超过 12 MiB，未载入内嵌预览。" };
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(target);
    if (!opened.isFile() || current.isSymbolicLink() || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new Error("文件在打开预览时发生变化，请刷新后重试。");
    }
    const maximum = IMAGE_TYPES[extension] ? MAX_IMAGE_BYTES : mediaType ? MAX_MEDIA_BYTES : MAX_TEXT_BYTES;
    const size = Math.min(stat.size, maximum);
    const data = Buffer.alloc(size);
    const { bytesRead } = await handle.read(data, 0, size, 0);
    const exact = data.subarray(0, bytesRead);
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("文件在读取预览时发生变化，请刷新后重试。");
    if (IMAGE_TYPES[extension]) return { path: relative, kind: "image", bytes: stat.size, truncated: false, dataUrl: `data:${IMAGE_TYPES[extension]};base64,${exact.toString("base64")}` };
    if (mediaType && mediaKind) return { path: relative, kind: mediaKind, bytes: stat.size, truncated: false, dataUrl: `data:${mediaType};base64,${exact.toString("base64")}` };
    const kind = fileKind(relative, exact);
    if (kind === "binary") return { path: relative, kind, bytes: stat.size, truncated: stat.size > size, warning: "二进制文件不提供文本预览。" };
    const source = redactSecrets(new TextDecoder("utf-8", { fatal: false }).decode(exact));
    const truncated = stat.size > bytesRead;
    return {
      path: relative, kind, bytes: stat.size, truncated, source,
      ...(kind === "markdown" ? { safeHtml: sanitizeHtmlPreview(markdownToSafeHtml(source)) } : {}),
      ...(kind === "html" ? { safeHtml: sanitizeHtmlPreview(source) } : {}),
    };
  } finally { await handle.close(); }
}
