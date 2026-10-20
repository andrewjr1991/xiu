import type { WorkspacePluginRequest } from "../../../src/runtime/plugin-service.js";
import type { WorkspaceManagementRequest } from "../../../src/runtime/workspace-management.js";
import type { IpcSenderLike } from "./security-policy.js";
import type { DesktopTaskController } from "./task-controller.js";
import { desktopChannels, type DesktopMcpApproveRequest, type DesktopMcpBrowseRequest, type DesktopMcpManageRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for the workspace management panel: MCP servers,
 * configuration, Skills, plugins and task diagnostics. Every handler checks
 * the sender first, resolves the trusted workspace, and runs writes through
 * the main process's single writer queue after making sure no interactive
 * terminal holds the workspace; `index.ts` supplies those as `ctx`, plus the
 * native file chooser for a local Skill package.
 */
export interface ManagementIpcContext<Event extends IpcSenderLike = IpcSenderLike> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  serializeWriterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Throws when no workspace is open and trusted. */
  trustedWorkspacePath: () => string;
  tasks: Pick<DesktopTaskController, "manageMcp" | "browseMcp" | "mcpSnapshot" | "changeMcp" | "managementSnapshot" | "prepareSkillInstallation" | "cancelSkillInstallation" | "taskDiagnostics" | "changeManagement" | "pluginSnapshot" | "changePlugin">;
  /** Whether the interactive terminal currently holds the workspace. */
  terminalRunning: (workspace: string) => boolean;
  /** Native picker for a local Skill package; resolves undefined when cancelled or without a window. */
  chooseSkillSource: (sourceKind: "directory" | "file") => Promise<string | undefined>;
}

export const managementIpcChannels = [
  desktopChannels.mcpManage, desktopChannels.mcpBrowse, desktopChannels.mcpSnapshot, desktopChannels.mcpReload, desktopChannels.mcpDisconnect, desktopChannels.mcpApprove,
  desktopChannels.managementSnapshot, desktopChannels.skillPrepare, desktopChannels.skillPrepareRemote, desktopChannels.skillCancel, desktopChannels.taskDiagnostics,
  desktopChannels.managementChange, desktopChannels.pluginSnapshot, desktopChannels.pluginChange,
] as const;

export function registerManagementIpc<Event extends IpcSenderLike>(ctx: ManagementIpcContext<Event>): void {
  ctx.handleIpc(desktopChannels.mcpManage, async (event, request: DesktopMcpManageRequest) => {
    ctx.assertTrustedSender(event);
    // Confirmation/cancel must not wait behind a long connection operation.
    if (request?.action === "oauth-decision" || request?.action === "oauth-cancel") return ctx.tasks.manageMcp(ctx.trustedWorkspacePath(), request);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (ctx.terminalRunning(workspace)) throw new Error("请先关闭终端，再管理 MCP。");
      return ctx.tasks.manageMcp(workspace, request);
    });
  });
  ctx.handleIpc(desktopChannels.mcpBrowse, async (event, request: DesktopMcpBrowseRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      if (ctx.terminalRunning(workspace)) throw new Error("请先关闭终端，再读取 MCP 内容。");
      return ctx.tasks.browseMcp(workspace, request);
    });
  });
  ctx.handleIpc(desktopChannels.mcpSnapshot, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.mcpSnapshot(ctx.trustedWorkspacePath());
  });
  for (const [channel, action] of [[desktopChannels.mcpReload, "reload"], [desktopChannels.mcpDisconnect, "disconnect"], [desktopChannels.mcpApprove, "approve"]] as const) {
    ctx.handleIpc(channel, async (event, request?: DesktopMcpApproveRequest) => {
      ctx.assertTrustedSender(event);
      return ctx.serializeWriterStart(async () => {
        const workspace = ctx.trustedWorkspacePath();
        if (ctx.terminalRunning(workspace)) throw new Error("请先关闭交互终端，再更改 MCP 连接。");
        return ctx.tasks.changeMcp(workspace, action, request);
      });
    });
  }
  ctx.handleIpc(desktopChannels.managementSnapshot, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.managementSnapshot(ctx.trustedWorkspacePath());
  });
  ctx.handleIpc(desktopChannels.skillPrepare, async (event, sourceKind: unknown = "directory") => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    if (sourceKind !== "directory" && sourceKind !== "file") throw new Error("无效的技能导入方式。");
    const workspace = ctx.trustedWorkspacePath();
    if (ctx.terminalRunning(workspace)) throw new Error("请先关闭交互终端。");
    return ctx.tasks.prepareSkillInstallation(workspace, () => ctx.chooseSkillSource(sourceKind));
  }));
  ctx.handleIpc(desktopChannels.skillPrepareRemote, async (event, request: { url: string }) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    if (ctx.terminalRunning(workspace)) throw new Error("请先关闭交互终端。");
    return ctx.tasks.prepareSkillInstallation(workspace, async () => request.url, "remote");
  }));
  ctx.handleIpc(desktopChannels.skillCancel, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.cancelSkillInstallation(ctx.trustedWorkspacePath());
  });
  ctx.handleIpc(desktopChannels.taskDiagnostics, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.taskDiagnostics(ctx.trustedWorkspacePath());
  });
  ctx.handleIpc(desktopChannels.managementChange, async (event, request: WorkspaceManagementRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    if (ctx.terminalRunning(workspace)) throw new Error("请先关闭交互终端，再更改配置。");
    return ctx.tasks.changeManagement(workspace, request);
  }));
  ctx.handleIpc(desktopChannels.pluginSnapshot, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.tasks.pluginSnapshot(ctx.trustedWorkspacePath());
  });
  ctx.handleIpc(desktopChannels.pluginChange, async (event, request: WorkspacePluginRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    if (ctx.terminalRunning(workspace)) throw new Error("请先关闭交互终端，再更改插件。");
    return ctx.tasks.changePlugin(workspace, request);
  }));
}
