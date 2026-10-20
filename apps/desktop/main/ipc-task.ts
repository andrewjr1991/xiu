import type { IpcSenderLike } from "./security-policy.js";
import type { DesktopTaskController } from "./task-controller.js";
import { desktopChannels, type DesktopApprovalModeRequest, type DesktopComputerAcceptanceRequest, type DesktopPlanModeRequest, type DesktopSubagentCancelRequest, type DesktopTaskContinueRequest, type DesktopTaskDeleteRequest, type DesktopWorkspaceSnapshot, type RuntimeApprovalDecisionRequest, type RuntimeConnectRequest, type RuntimeTaskRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for the Agent task session: connecting to the runtime,
 * creating / continuing / steering / stopping tasks, new conversations, Plan
 * and approval modes, approval decisions, computer-action acceptance,
 * subagent cancellation and task deletion. Every handler checks the sender
 * and resolves the trusted workspace; the writes that start or change a task
 * go through the main process's single writer queue after making sure no
 * interactive terminal holds the workspace. `index.ts` supplies those as
 * `ctx`, plus the native confirmations (Full Access, computer acceptance,
 * subagent cancel) which stay beside the Electron windows they open.
 */
export interface TaskIpcContext<Event extends IpcSenderLike = IpcSenderLike> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  serializeWriterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Throws when no workspace is open and trusted. */
  trustedWorkspacePath: () => string;
  tasks: Pick<DesktopTaskController, "connect" | "createTask" | "continueTask" | "newConversation" | "steerTask" | "stopTask" | "setPlanMode" | "setApprovalMode" | "decideApproval" | "computerAcceptance" | "cancelSubagent" | "deleteTask">;
  /** Whether the interactive terminal currently holds the workspace. */
  terminalRunning: (workspace: string) => boolean;
  /** Stops any controlled computer-use session; called before Plan mode changes. */
  stopComputerUse: () => void;
  workspaceSnapshot: () => Promise<DesktopWorkspaceSnapshot>;
  /** Pushes the snapshot to the renderer and returns it. */
  emitSnapshot: (snapshot: DesktopWorkspaceSnapshot) => DesktopWorkspaceSnapshot;
  /** Native Full Access confirmation; resolves false without a window. */
  confirmFullAccess: () => Promise<boolean>;
  /** Native confirmation of a human computer-action verdict; resolves false without a window. */
  confirmComputerAcceptance: (request: DesktopComputerAcceptanceRequest) => Promise<boolean>;
  /** Native subagent cancel confirmation; resolves false without a window. */
  confirmSubagentCancel: () => Promise<boolean>;
}

export const taskIpcChannels = [
  desktopChannels.runtimeConnect, desktopChannels.taskCreate, desktopChannels.taskContinue, desktopChannels.conversationNew, desktopChannels.taskSteer, desktopChannels.taskStop,
  desktopChannels.planModeSet, desktopChannels.approvalModeSet, desktopChannels.approvalDecide, desktopChannels.computerAcceptance, desktopChannels.subagentCancel, desktopChannels.taskDelete,
] as const;

export function registerTaskIpc<Event extends IpcSenderLike>(ctx: TaskIpcContext<Event>): void {
  ctx.handleIpc(desktopChannels.runtimeConnect, async (event, request?: RuntimeConnectRequest) => {
    ctx.assertTrustedSender(event);
    const after = request?.afterSequence;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error("Invalid runtime sequence.");
    return ctx.tasks.connect(ctx.trustedWorkspacePath(), after);
  });
  ctx.handleIpc(desktopChannels.taskCreate, async (event, request: RuntimeTaskRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (ctx.terminalRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再启动 Agent 任务。");
      return ctx.tasks.createTask(workspace, request?.text, request?.answerTo);
    });
  });
  ctx.handleIpc(desktopChannels.taskContinue, async (event, request: DesktopTaskContinueRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (ctx.terminalRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再继续 Agent 任务。");
      return ctx.tasks.continueTask(workspace, request?.taskId, request?.text);
    });
  });
  ctx.handleIpc(desktopChannels.conversationNew, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(() => ctx.tasks.newConversation(ctx.trustedWorkspacePath()));
  });
  ctx.handleIpc(desktopChannels.taskSteer, async (event, request: RuntimeTaskRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.steerTask(ctx.trustedWorkspacePath(), request?.text);
  });
  ctx.handleIpc(desktopChannels.taskStop, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.stopTask(ctx.trustedWorkspacePath());
  });
  ctx.handleIpc(desktopChannels.planModeSet, async (event, request: DesktopPlanModeRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (ctx.terminalRunning(workspace)) throw new Error("交互终端仍在运行，请先关闭终端再切换 Plan 模式。");
      ctx.stopComputerUse();
      return ctx.tasks.setPlanMode(workspace, request);
    });
  });
  ctx.handleIpc(desktopChannels.approvalModeSet, async (event, request: DesktopApprovalModeRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.setApprovalMode(ctx.trustedWorkspacePath(), request, () => ctx.confirmFullAccess());
  });
  ctx.handleIpc(desktopChannels.approvalDecide, async (event, request: RuntimeApprovalDecisionRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.decideApproval(ctx.trustedWorkspacePath(), request);
  });
  ctx.handleIpc(desktopChannels.computerAcceptance, async (event, request: DesktopComputerAcceptanceRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.computerAcceptance(ctx.trustedWorkspacePath(), request, () => ctx.confirmComputerAcceptance(request));
  });
  ctx.handleIpc(desktopChannels.subagentCancel, async (event, request: DesktopSubagentCancelRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => ctx.tasks.cancelSubagent(ctx.trustedWorkspacePath(), request, () => ctx.confirmSubagentCancel()));
  });
  ctx.handleIpc(desktopChannels.taskDelete, async (event, request: DesktopTaskDeleteRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (request?.confirmed !== true) throw new Error("删除任务需要明确确认。");
      await ctx.tasks.deleteTask(workspace, request, request.confirmed);
      return ctx.emitSnapshot(await ctx.workspaceSnapshot());
    });
  });
}
