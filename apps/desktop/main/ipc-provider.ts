import { readEnvironmentCredential } from "../../../src/credential-store.js";
import type { DesktopProviderController } from "./provider-controller.js";
import type { IpcSenderLike } from "./security-policy.js";
import type { DesktopTaskController } from "./task-controller.js";
import type { VisionProbeController } from "./vision-probe-controller.js";
import { desktopChannels, type DesktopProviderCredentialManageRequest, type DesktopProviderCredentialRequest, type DesktopProviderDeleteRequest, type DesktopProviderModelsRequest, type DesktopProviderSelectRequest, type DesktopProviderTestRequest, type DesktopProviderUpsertRequest } from "../shared/protocol.js";

/**
 * Renderer→main IPC for the Provider settings page: snapshot, model
 * discovery, selection, credentials, connection and vision tests, upsert
 * and delete. Every handler checks the sender first, resolves the trusted
 * workspace, and runs configuration writes through the main process's
 * single writer queue; `index.ts` supplies those as `ctx`.
 */
/** The parts of a BrowserWindow the vision test uses; structural so the root typecheck and tests need no Electron. */
export interface VisionProbeParentWindow {
  once(event: "closed", listener: () => void): unknown;
  removeListener(event: "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
}

export interface ProviderIpcContext<Event extends IpcSenderLike = IpcSenderLike, Window extends VisionProbeParentWindow = VisionProbeParentWindow> {
  handleIpc: (channel: string, listener: (event: Event, ...args: never[]) => unknown) => void;
  assertTrustedSender: (event: Event) => void;
  serializeWriterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Throws when no workspace is open and trusted. */
  trustedWorkspacePath: () => string;
  providers: () => Promise<DesktopProviderController>;
  tasks: Pick<DesktopTaskController, "assertCanReconfigure" | "reload" | "connect">;
  visionProbe: Pick<VisionProbeController, "cancel" | "snapshot" | "run" | "runBatch">;
  mainWindow: () => Window | undefined;
  /** The native confirmation dialog, injected so this module never loads Electron itself. */
  confirmVisionProbe: (parent: Window, route: string, signal: AbortSignal, batch?: boolean) => Promise<boolean>;
}

export const providerIpcChannels = [
  desktopChannels.providerSnapshot, desktopChannels.providerModels, desktopChannels.providerSelect, desktopChannels.providerCredentialSave,
  desktopChannels.providerCredentialManage, desktopChannels.providerTest, desktopChannels.providerVisionCancel, desktopChannels.providerVisionProgress,
  desktopChannels.providerVisionTest, desktopChannels.providerUpsert, desktopChannels.providerDelete,
] as const;

export function registerProviderIpc<Event extends IpcSenderLike, Window extends VisionProbeParentWindow>(ctx: ProviderIpcContext<Event, Window>): void {
  ctx.handleIpc(desktopChannels.providerSnapshot, async (event) => {
    ctx.assertTrustedSender(event);
    ctx.trustedWorkspacePath();
    return (await ctx.providers()).refresh();
  });
  ctx.handleIpc(desktopChannels.providerModels, async (event, request: DesktopProviderModelsRequest) => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    return (await ctx.providers()).discover(workspace, request);
  });
  ctx.handleIpc(desktopChannels.providerSelect, async (event, request: DesktopProviderSelectRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    await ctx.tasks.assertCanReconfigure(workspace);
    const settings = await (await ctx.providers()).select(request);
    return { settings, connection: await ctx.tasks.reload(workspace) };
  }));
  ctx.handleIpc(desktopChannels.providerCredentialSave, async (event, request: DesktopProviderCredentialRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    await ctx.tasks.assertCanReconfigure(workspace);
    const settings = await (await ctx.providers()).saveCredential(request);
    return { settings, connection: await ctx.tasks.reload(workspace) };
  }));
  ctx.handleIpc(desktopChannels.providerCredentialManage, async (event, request: DesktopProviderCredentialManageRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    await ctx.tasks.assertCanReconfigure(workspace);
    const settings = await (await ctx.providers()).manageCredential(request);
    return { settings, connection: await ctx.tasks.reload(workspace) };
  }));
  ctx.handleIpc(desktopChannels.providerTest, async (event, request: DesktopProviderTestRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    await ctx.tasks.assertCanReconfigure(workspace);
    return (await ctx.providers()).test(workspace, request);
  }));
  ctx.handleIpc(desktopChannels.providerVisionCancel, (event) => { ctx.assertTrustedSender(event); ctx.visionProbe.cancel(); });
  ctx.handleIpc(desktopChannels.providerVisionProgress, (event) => { ctx.assertTrustedSender(event); return ctx.visionProbe.snapshot(); });
  ctx.handleIpc(desktopChannels.providerVisionTest, async (event, request: DesktopProviderSelectRequest & { allCandidates?: boolean }) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    const providers = await ctx.providers();
    await providers.refresh();
    const config = providers.visionProbeConfig(workspace, request);
    const models = request.allCandidates === true ? [...new Set(providers.snapshot(request.providerId).capabilityModelsByProvider[request.providerId]?.vision.map(model => model.id) ?? [])] : [request.model];
    if (!models.length || models.length > 200) throw new Error("批量视觉测试需要 1–200 个候选；请先刷新或整理模型列表。");
    const configs = models.map(model => providers.visionProbeConfig(workspace, { providerId: request.providerId, model }));
    // Compared in memory only: credential values are never hashed, stored or logged.
    const fingerprint = () => {
      const current = models.map(model => providers.visionProbeConfig(workspace, { providerId: request.providerId, model }));
      return JSON.stringify([current, readEnvironmentCredential(config.apiKeyEnv), readEnvironmentCredential("AGNES_API_KEY"), readEnvironmentCredential("OPENAI_API_KEY"), readEnvironmentCredential("ANTHROPIC_API_KEY"), process.env.AGNES_BASE_URL]);
    };
    const initial = fingerprint();
    const validate = async () => {
      ctx.assertTrustedSender(event);
      if (ctx.trustedWorkspacePath() !== workspace) throw new Error("工作区已改变，视觉测试取消。");
      await ctx.tasks.assertCanReconfigure(workspace);
      if ((await ctx.tasks.connect(workspace)).runtime.snapshot.planMode) throw new Error("Plan 只读模式不执行付费视觉测试。");
      await providers.refresh();
      if (fingerprint() !== initial) throw new Error("渠道配置已改变，请重新测试。");
    };
    await validate();
    const parent = ctx.mainWindow()!;
    const cancel = () => ctx.visionProbe.cancel();
    parent.once("closed", cancel);
    try { return request.allCandidates === true ? await ctx.visionProbe.runBatch(configs, (route, signal) => ctx.confirmVisionProbe(parent, route, signal, true), validate) : await ctx.visionProbe.run(config, (route, signal) => ctx.confirmVisionProbe(parent, route, signal), validate); }
    finally { if (!parent.isDestroyed()) parent.removeListener("closed", cancel); }
  }));
  ctx.handleIpc(desktopChannels.providerUpsert, async (event, request: DesktopProviderUpsertRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    await ctx.tasks.assertCanReconfigure(workspace);
    const settings = await (await ctx.providers()).upsert(request);
    return { settings, connection: await ctx.tasks.reload(workspace) };
  }));
  ctx.handleIpc(desktopChannels.providerDelete, async (event, request: DesktopProviderDeleteRequest) => ctx.serializeWriterStart(async () => {
    ctx.assertTrustedSender(event);
    const workspace = ctx.trustedWorkspacePath();
    await ctx.tasks.assertCanReconfigure(workspace);
    const settings = await (await ctx.providers()).delete(request);
    return { settings, connection: await ctx.tasks.reload(workspace) };
  }));
}
