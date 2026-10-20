import { restoreHistoryAttachments } from "./history-attachments.js";
import type { IpcSenderLike } from "./security-policy.js";
import type { DesktopTaskController } from "./task-controller.js";
import { desktopChannels, type DesktopCheckpointRestoreRequest, type DesktopFilePreviewRequest, type DesktopMediaPreviewRequest, type DesktopRecoveryAbandonRequest, type DesktopRecoveryRequest, type DesktopReviewRequest, type DesktopTaskHistoryRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for the review inspector and crash recovery: task
 * history, review snapshot, file and media previews, checkpoint restore and
 * resuming or abandoning an interrupted task. Every handler checks the
 * sender and resolves the trusted workspace; the destructive steps
 * (checkpoint restore, recovery) never run without the native confirmation
 * `index.ts` supplies, and recovery first re-reads the workspace review so a
 * stale run id is refused. Image thumbnails are injected because decoding
 * them needs Electron.
 */
export interface ReviewIpcContext<Event extends IpcSenderLike = IpcSenderLike> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  serializeWriterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Throws when no workspace is open and trusted. */
  trustedWorkspacePath: () => string;
  tasks: Pick<DesktopTaskController, "openTaskHistory" | "reviewSnapshot" | "previewFile" | "previewMedia" | "restoreCheckpoint" | "recoverTask" | "abandonRecovery">;
  /** Whether the interactive terminal currently holds the workspace. */
  terminalRunning: (workspace: string) => boolean;
  /** Small thumbnail for a restored history attachment; undefined when the bytes are not an image. */
  historyThumbnail: (data: Buffer) => string | undefined;
  /** Bounded inline preview for a media file; undefined when it cannot be decoded. */
  previewThumbnail: (data: Buffer) => string | undefined;
  /** Native confirmations; each resolves true only when the user confirmed. */
  confirmCheckpointRestore: (request: DesktopCheckpointRestoreRequest) => Promise<boolean>;
  confirmRecoveryResume: (unknownOperations: number) => Promise<boolean>;
  confirmRecoveryAbandon: () => Promise<boolean>;
}

export interface ReviewIpcIo {
  restoreHistoryAttachments: typeof restoreHistoryAttachments;
}

const defaultIo: ReviewIpcIo = { restoreHistoryAttachments };

export const reviewIpcChannels = [
  desktopChannels.taskHistoryOpen, desktopChannels.reviewSnapshot, desktopChannels.filePreview, desktopChannels.mediaPreview,
  desktopChannels.checkpointRestore, desktopChannels.recoveryResume, desktopChannels.recoveryAbandon,
] as const;

export function registerReviewIpc<Event extends IpcSenderLike>(ctx: ReviewIpcContext<Event>, io: ReviewIpcIo = defaultIo): void {
  ctx.handleIpc(desktopChannels.taskHistoryOpen, async (event, request: DesktopTaskHistoryRequest) => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    const history = await ctx.tasks.openTaskHistory(workspace, request);
    const attachments = await io.restoreHistoryAttachments(workspace, history.attachmentReferences ?? {}, ctx.historyThumbnail);
    // Do not send results from a workspace closed/switched while files loaded.
    if (ctx.trustedWorkspacePath() !== workspace) throw new Error("Workspace changed while loading history.");
    return { ...history, attachments };
  });
  ctx.handleIpc(desktopChannels.reviewSnapshot, async (event, request?: DesktopReviewRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.reviewSnapshot(ctx.trustedWorkspacePath(), request?.changeView);
  });
  ctx.handleIpc(desktopChannels.filePreview, async (event, request: DesktopFilePreviewRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.previewFile(ctx.trustedWorkspacePath(), request);
  });
  ctx.handleIpc(desktopChannels.mediaPreview, async (event, request: DesktopMediaPreviewRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.previewMedia(ctx.trustedWorkspacePath(), request, ctx.previewThumbnail);
  });
  ctx.handleIpc(desktopChannels.checkpointRestore, async (event, request: DesktopCheckpointRestoreRequest) => {
    ctx.assertTrustedSender(event);
    const confirmed = await ctx.confirmCheckpointRestore(request);
    return ctx.tasks.restoreCheckpoint(ctx.trustedWorkspacePath(), request, confirmed);
  });
  ctx.handleIpc(desktopChannels.recoveryResume, async (event, request: DesktopRecoveryRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (ctx.terminalRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再恢复 Agent 任务。");
      const review = await ctx.tasks.reviewSnapshot(workspace, "workspace");
      if (!review.recovery || review.recovery.runId !== request?.runId) throw new Error("恢复记录不存在或已经变化。");
      const confirmed = await ctx.confirmRecoveryResume(review.recovery.unknownOperations.length);
      if (!confirmed) throw new Error("已取消恢复。");
      return ctx.tasks.recoverTask(workspace, request, true);
    });
  });
  ctx.handleIpc(desktopChannels.recoveryAbandon, async (event, request: DesktopRecoveryAbandonRequest) => {
    ctx.assertTrustedSender(event);
    const confirmed = await ctx.confirmRecoveryAbandon();
    return ctx.tasks.abandonRecovery(ctx.trustedWorkspacePath(), request, confirmed);
  });
}
