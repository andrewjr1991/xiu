import fs from "node:fs/promises";
import path from "node:path";
import { ClipboardAttachmentManager, type ClipboardPasteResult } from "../../../src/clipboard.js";
import type { IpcSenderLike } from "./security-policy.js";
import { desktopChannels, type DesktopAttachmentResult, type DesktopAttachmentUploadRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for conversation attachments and the clipboard: choosing
 * files, pasting, importing dropped bytes and copying a message. Every
 * attachment the renderer sees is re-checked here to be a plain file inside
 * the workspace; `index.ts` supplies the native file chooser, the system
 * clipboard and the Electron image thumbnail as `ctx`.
 */
export interface AttachmentsIpcContext<Event extends IpcSenderLike = IpcSenderLike> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  /** Throws when no workspace is open and trusted. */
  trustedWorkspacePath: () => string;
  /** Native multi-file picker; resolves undefined when cancelled or nothing was chosen. */
  chooseAttachmentFiles: () => Promise<string[] | undefined>;
  writeClipboardText: (text: string) => void;
  /** 180×120 preview of an image file on disk; undefined when it cannot be decoded. */
  imageThumbnail: (absolutePath: string) => string | undefined;
}

export interface AttachmentsIpcIo {
  lstat: (absolutePath: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  manager: (workspace: string) => Pick<ClipboardAttachmentManager, "attachFiles" | "paste" | "attachBytes">;
}

const defaultIo: AttachmentsIpcIo = {
  lstat: (absolutePath) => fs.lstat(absolutePath),
  manager: (workspace) => new ClipboardAttachmentManager(workspace, undefined, "zh-CN"),
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export const attachmentsIpcChannels = [
  desktopChannels.attachmentsChoose, desktopChannels.attachmentsPaste, desktopChannels.copyMessage, desktopChannels.attachmentsImport,
] as const;

/** Turns the attachment manager's workspace-relative paths into renderer attachments, refusing anything outside the workspace or not a plain file. */
export async function presentAttachments(workspace: string, result: ClipboardPasteResult, imageThumbnail: (absolutePath: string) => string | undefined, io: Pick<AttachmentsIpcIo, "lstat"> = defaultIo): Promise<DesktopAttachmentResult> {
  const root = path.resolve(workspace);
  const attachments = await Promise.all(result.attachments.map(async (relative) => {
    const normalized = relative.replace(/\\/g, "/");
    const absolute = path.resolve(root, relative);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (absolute !== root && !absolute.startsWith(prefix)) throw new Error("附件路径超出工作区。");
    const stat = await io.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("附件不是安全的普通文件。");
    const kind = IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase()) ? "image" as const : "file" as const;
    let previewDataUrl: string | undefined;
    if (kind === "image" && stat.size <= 25 * 1024 * 1024) previewDataUrl = imageThumbnail(absolute);
    const reference = /\s/.test(normalized) ? `@${JSON.stringify(normalized)}` : `@${normalized}`;
    return { reference, path: normalized, name: path.basename(relative), bytes: stat.size, kind, ...(previewDataUrl ? { previewDataUrl } : {}) };
  }));
  return { insertText: "", attachments, ...(result.notice ? { notice: result.notice } : {}) };
}

export function registerAttachmentsIpc<Event extends IpcSenderLike>(ctx: AttachmentsIpcContext<Event>, io: AttachmentsIpcIo = defaultIo): void {
  const present = (workspace: string, result: ClipboardPasteResult) => presentAttachments(workspace, result, ctx.imageThumbnail, io);
  ctx.handleIpc(desktopChannels.attachmentsChoose, async (event) => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    const files = await ctx.chooseAttachmentFiles();
    if (!files) return { insertText: "", attachments: [] };
    return present(workspace, await io.manager(workspace).attachFiles(files));
  });
  ctx.handleIpc(desktopChannels.attachmentsPaste, async (event) => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    return present(workspace, await io.manager(workspace).paste());
  });
  ctx.handleIpc(desktopChannels.copyMessage, (event, text: unknown) => {
    ctx.assertTrustedSender(event);
    ctx.trustedWorkspacePath();
    if (typeof text !== "string" || text.length === 0 || text.length > 200_000) throw new Error("复制内容无效或过长。");
    ctx.writeClipboardText(text);
  });
  ctx.handleIpc(desktopChannels.attachmentsImport, async (event, request: DesktopAttachmentUploadRequest) => {
    ctx.assertTrustedSender(event);
    if (!request || !Array.isArray(request.files)) throw new Error("Invalid attachment request.");
    const workspace = ctx.trustedWorkspacePath();
    return present(workspace, await io.manager(workspace).attachBytes(request.files));
  });
}
