import fs from "node:fs/promises";
import path from "node:path";

const MAX_TEXT_DETAIL_BYTES = 1_000_000;
const MAX_PREVIEW_LINES = 4;
const MAX_PREVIEW_WIDTH = 140;

export type WorkspaceFileChangeKind = "created" | "modified" | "deleted";

export interface WorkspaceFileSnapshot {
  path: string;
  exists: boolean;
  bytes: number;
  content?: string;
}

export interface WorkspaceFileChange {
  path: string;
  kind: WorkspaceFileChangeKind;
  additions?: number;
  deletions?: number;
  bytesBefore: number;
  bytesAfter: number;
  preview: string[];
  hunk?: string;
}

export interface WorkspaceChangeNotice {
  tool: string;
  paths: string[];
  description: string;
  files: WorkspaceFileChange[];
}

function safeWorkspacePath(cwd: string, requested: string): string | undefined {
  const root = path.resolve(cwd);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return target;
}

function textLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function clippedLine(prefix: "+" | "-" | "~", line: string): string {
  const visible = line.length ? line.replace(/\t/g, "  ") : "␠";
  return `${prefix} ${visible.length > MAX_PREVIEW_WIDTH ? `${visible.slice(0, MAX_PREVIEW_WIDTH - 3)}...` : visible}`;
}

function unmatchedLines(source: string[], target: string[]): string[] {
  const available = new Map<string, number>();
  for (const line of target) available.set(line, (available.get(line) ?? 0) + 1);
  return source.filter((line) => {
    const count = available.get(line) ?? 0;
    if (!count) return true;
    available.set(line, count - 1);
    return false;
  });
}

function decodeTextDetail(data: Buffer): string | undefined {
  const sample = data.subarray(0, Math.min(data.length, 8192));
  if (sample.includes(0)) return undefined;
  const text = data.toString("utf8");
  const replacements = [...text.slice(0, 8192)].filter((character) => character === "�").length;
  return replacements > 8 ? undefined : text;
}

export function summarizeTextChange(pathname: string, before: WorkspaceFileSnapshot, after: WorkspaceFileSnapshot): WorkspaceFileChange | undefined {
  if (before.exists === after.exists && before.bytes === after.bytes
    && (before.content === after.content || (before.content === undefined && after.content === undefined))) return undefined;
  if (!before.exists && !after.exists) return undefined;
  const kind: WorkspaceFileChangeKind = !before.exists ? "created" : !after.exists ? "deleted" : "modified";
  const oldLines = before.content === undefined ? undefined : textLines(before.content);
  const newLines = after.content === undefined ? undefined : textLines(after.content);
  let additions: number | undefined;
  let deletions: number | undefined;
  let preview: string[] = [];
  let hunk: string | undefined;

  if (!before.exists && newLines) {
    additions = newLines.length;
    deletions = 0;
  } else if (!after.exists && oldLines) {
    additions = 0;
    deletions = oldLines.length;
  } else if (oldLines && newLines) {
    const removed = unmatchedLines(oldLines, newLines);
    const added = unmatchedLines(newLines, oldLines);
    additions = added.length;
    deletions = removed.length;
    preview = [
      ...removed.slice(0, Math.ceil(MAX_PREVIEW_LINES / 2)).map((line) => clippedLine("-", line)),
      ...added.slice(0, Math.floor(MAX_PREVIEW_LINES / 2)).map((line) => clippedLine("+", line)),
    ];
    const oldStart = removed.length ? oldLines.indexOf(removed[0]!) + 1 : 0;
    const newStart = added.length ? newLines.indexOf(added[0]!) + 1 : 0;
    if (oldStart || newStart) hunk = `@@ -${oldStart || oldLines.length} +${newStart || newLines.length} @@`;
    if (!preview.length && before.content !== after.content) preview = [clippedLine("~", "content order or line endings changed")];
  }

  return { path: pathname, kind, additions, deletions, bytesBefore: before.bytes, bytesAfter: after.bytes, preview, ...(hunk ? { hunk } : {}) };
}

export async function captureWorkspaceFiles(cwd: string, paths: string[]): Promise<Map<string, WorkspaceFileSnapshot>> {
  const snapshots = new Map<string, WorkspaceFileSnapshot>();
  for (const pathname of [...new Set(paths)].slice(0, 6)) {
    const target = safeWorkspacePath(cwd, pathname);
    if (!target) continue;
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) continue;
      let content: string | undefined;
      if (stat.size <= MAX_TEXT_DETAIL_BYTES) {
        try { content = decodeTextDetail(await fs.readFile(target)); } catch { content = undefined; }
      }
      snapshots.set(pathname, { path: pathname, exists: true, bytes: stat.size, content });
    } catch {
      snapshots.set(pathname, { path: pathname, exists: false, bytes: 0, content: "" });
    }
  }
  return snapshots;
}

export function buildWorkspaceChangeNotice(
  tool: string,
  description: string,
  paths: string[],
  before: Map<string, WorkspaceFileSnapshot>,
  after: Map<string, WorkspaceFileSnapshot>,
): WorkspaceChangeNotice | undefined {
  const files: WorkspaceFileChange[] = [];
  for (const pathname of paths) {
    const previous = before.get(pathname) ?? { path: pathname, exists: false, bytes: 0, content: "" };
    const current = after.get(pathname) ?? { path: pathname, exists: false, bytes: 0, content: "" };
    const summary = summarizeTextChange(pathname, previous, current);
    if (summary) files.push(summary);
  }
  if (!files.length) return undefined;
  return { tool, paths: files.map((file) => file.path), description, files };
}
