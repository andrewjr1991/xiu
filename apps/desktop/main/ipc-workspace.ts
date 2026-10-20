import type { IpcSenderLike } from "./security-policy.js";
import type { DesktopWorkspaceController } from "./workspace-controller.js";
import type { DesktopTaskController } from "./task-controller.js";
import type { DesktopTerminalController } from "./terminal-controller.js";
import type { DesktopProviderRecoveryController } from "./provider-recovery-controller.js";
import { desktopChannels, type DesktopWorkspaceSnapshot, type OpenRecentWorkspaceRequest, type RemoveRecentWorkspaceRequest, type TrustWorkspaceRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for opening, switching, closing, removing and trusting
 * workspaces. Switching away from a workspace always stops its terminal
 * sessions and detaches the task controller first, and a running task blocks
 * the switch; `index.ts` supplies the controllers, the writer queue and the
 * native directory picker as `ctx`.
 */
export interface WorkspaceIpcContext<Event extends IpcSenderLike = IpcSenderLike> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  serializeWriterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  workspaces: Pick<DesktopWorkspaceController, "snapshot" | "selectWorkspace" | "clearSelection" | "openRecent" | "removeRecent" | "trustCurrent">;
  tasks: Pick<DesktopTaskController, "canChangeWorkspace" | "detach">;
  terminals: Pick<DesktopTerminalController, "stopAll">;
  providerRecovery: Pick<DesktopProviderRecoveryController, "invalidateContext">;
  /** Native directory picker; resolves undefined when the user cancels. */
  chooseWorkspaceDirectory: () => Promise<string | undefined>;
  /** Pushes the snapshot to the renderer and returns it. */
  emitSnapshot: (snapshot: DesktopWorkspaceSnapshot) => DesktopWorkspaceSnapshot;
}

export const workspaceIpcChannels = [
  desktopChannels.snapshot, desktopChannels.chooseWorkspace, desktopChannels.closeWorkspace,
  desktopChannels.openRecentWorkspace, desktopChannels.removeRecentWorkspace, desktopChannels.trustWorkspace,
] as const;

export function registerWorkspaceIpc<Event extends IpcSenderLike>(ctx: WorkspaceIpcContext<Event>): void {
  ctx.handleIpc(desktopChannels.snapshot, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.workspaces.snapshot();
  });
  ctx.handleIpc(desktopChannels.chooseWorkspace, async (event) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    if (!ctx.tasks.canChangeWorkspace()) throw new Error("任务仍在运行，请先停止并等待任务结束。");
    const selected = await ctx.chooseWorkspaceDirectory();
    if (selected === undefined) return ctx.workspaces.snapshot();
    ctx.terminals.stopAll("工作区已切换，终端会话已关闭。");
    ctx.tasks.detach();
    return ctx.emitSnapshot(await ctx.workspaces.selectWorkspace(selected));
  }));
  ctx.handleIpc(desktopChannels.closeWorkspace, async (event) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    ctx.terminals.stopAll("工作区已关闭，终端会话已结束。");
    ctx.tasks.detach();
    return ctx.emitSnapshot(await ctx.workspaces.clearSelection());
  }));
  ctx.handleIpc(desktopChannels.openRecentWorkspace, async (event, request: OpenRecentWorkspaceRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    ctx.terminals.stopAll("工作区已切换，终端会话已关闭。");
    ctx.tasks.detach();
    return ctx.emitSnapshot(await ctx.workspaces.openRecent(request));
  }));
  ctx.handleIpc(desktopChannels.removeRecentWorkspace, async (event, request: RemoveRecentWorkspaceRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const snapshot = await ctx.workspaces.snapshot();
    const selected = snapshot.recent.find((item) => item.id === request?.workspaceId);
    if (!selected) throw new Error("最近项目不存在或已经移除。");
    if (request?.confirmed !== true) throw new Error("移除最近项目需要明确确认。");
    const removingCurrent = snapshot.workspace?.id === request.workspaceId;
    if (removingCurrent) {
      if (!ctx.tasks.canChangeWorkspace()) throw new Error("任务仍在运行，请先停止并等待任务结束。");
      ctx.terminals.stopAll("工作区已移除，终端会话已关闭。");
      ctx.tasks.detach();
    }
    return ctx.emitSnapshot(await ctx.workspaces.removeRecent(request, request.confirmed));
  }));
  ctx.handleIpc(desktopChannels.trustWorkspace, async (event, request: TrustWorkspaceRequest) => {
    ctx.assertTrustedSender(event);
    ctx.providerRecovery.invalidateContext();
    return ctx.emitSnapshot(await ctx.workspaces.trustCurrent(request));
  });
}
