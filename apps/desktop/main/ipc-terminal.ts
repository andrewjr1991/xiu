import type { IpcSenderLike } from "./security-policy.js";
import type { DesktopTaskController } from "./task-controller.js";
import type { DesktopTerminalController } from "./terminal-controller.js";
import { desktopChannels, type DesktopTerminalResizeRequest, type DesktopTerminalSessionRequest, type DesktopTerminalStartRequest, type DesktopTerminalWriteRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for the interactive terminal: snapshot, start, write,
 * resize and stop. Every handler checks the sender and resolves the trusted
 * workspace; starting a session goes through the main process's single
 * writer queue and the task controller's terminal check (no running Agent
 * task, no Plan read-only mode); `index.ts` supplies those as `ctx`.
 */
export interface TerminalIpcContext<Event extends IpcSenderLike = IpcSenderLike> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  serializeWriterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Throws when no workspace is open and trusted. */
  trustedWorkspacePath: () => string;
  tasks: Pick<DesktopTaskController, "assertCanUseTerminal">;
  terminals: Pick<DesktopTerminalController, "snapshot" | "start" | "write" | "resize" | "stop">;
}

export const terminalIpcChannels = [
  desktopChannels.terminalSnapshot, desktopChannels.terminalStart, desktopChannels.terminalWrite, desktopChannels.terminalResize, desktopChannels.terminalStop,
] as const;

export function registerTerminalIpc<Event extends IpcSenderLike>(ctx: TerminalIpcContext<Event>): void {
  ctx.handleIpc(desktopChannels.terminalSnapshot, async (event) => {
    ctx.assertTrustedSender(event);
    return ctx.terminals.snapshot(ctx.trustedWorkspacePath());
  });
  ctx.handleIpc(desktopChannels.terminalStart, async (event, request?: DesktopTerminalStartRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.serializeWriterStart(async () => {
      const workspace = ctx.trustedWorkspacePath();
      await ctx.tasks.assertCanUseTerminal(workspace);
      return ctx.terminals.start(workspace, request);
    });
  });
  ctx.handleIpc(desktopChannels.terminalWrite, async (event, request: DesktopTerminalWriteRequest) => {
    ctx.assertTrustedSender(event);
    ctx.terminals.write(ctx.trustedWorkspacePath(), request);
  });
  ctx.handleIpc(desktopChannels.terminalResize, async (event, request: DesktopTerminalResizeRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.terminals.resize(ctx.trustedWorkspacePath(), request);
  });
  ctx.handleIpc(desktopChannels.terminalStop, async (event, request: DesktopTerminalSessionRequest) => {
    ctx.assertTrustedSender(event);
    return ctx.terminals.stop(ctx.trustedWorkspacePath(), request?.sessionId);
  });
}
