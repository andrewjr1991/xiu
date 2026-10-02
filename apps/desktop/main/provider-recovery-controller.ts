import { randomUUID } from "node:crypto";
import { ProviderRegistry, type ProviderConfigurationRecoveryPreview } from "../../../src/provider-registry.js";
import { providerRecoveryError, type ProviderRecoveryRegistry } from "../../../src/commands/provider-recovery.js";
import type { DesktopProviderRecoveryRequest, DesktopProviderRecoverySnapshot } from "../shared/provider-recovery.js";

export interface DesktopProviderRecoveryDependencies {
  registry?: ProviderRecoveryRegistry;
  /** Includes task, terminal, OAuth, permission and host-reconfiguration activity. */
  isBusy: () => boolean;
  contextIdentity?: () => unknown;
  /** Trusted native confirmation; cancellation must never restore. */
  confirm: (preview: ProviderConfigurationRecoveryPreview) => Promise<boolean>;
  onRecovered?: () => void;
}
class RecoveryContextError extends Error {}

/** Accessible before ProviderRegistry.load(), including malformed configuration. */
export class DesktopProviderRecoveryController {
  private readonly registry: ProviderRecoveryRegistry;
  private contextId = randomUUID();
  private pending?: ProviderConfigurationRecoveryPreview;
  /** Serialize recovery requests without blocking task controls during diagnostics. */
  private operation = false;
  private exclusiveRecovery = false;
  private restartRequired = false;
  private completedAction?: ProviderConfigurationRecoveryPreview["action"];
  private observedContext: unknown;

  constructor(private readonly dependencies: DesktopProviderRecoveryDependencies) {
    this.registry = dependencies.registry ?? new ProviderRegistry();
    this.observedContext = dependencies.contextIdentity?.();
  }

  /** Invalidate on workspace/runtime changes, even a same-workspace reopen. */
  invalidateContext(): void { this.contextId = randomUUID(); this.pending = undefined; this.observedContext = this.dependencies.contextIdentity?.(); }

  private refreshContext(): void {
    if (this.observedContext !== this.dependencies.contextIdentity?.()) this.invalidateContext();
  }

  assertCanContinue(): void {
    if (this.restartRequired) throw new RecoveryContextError("Provider 配置恢复操作已完成，请重启 Xiu 后再执行任务或更改配置。");
    if (this.exclusiveRecovery) throw new RecoveryContextError("Provider 恢复操作正在进行，请先完成或取消。");
  }

  private async snapshot(): Promise<DesktopProviderRecoverySnapshot> {
    const diagnostics = await this.registry.configurationDiagnostics();
    this.refreshContext();
    return { contextId: this.contextId, diagnostics, restartRequired: this.restartRequired,
      ...(this.completedAction ? { completedAction: this.completedAction } : {}),
      ...(this.pending ? { preview: structuredClone(this.pending) } : {}) };
  }

  private assertContext(contextId: string): void {
    this.refreshContext();
    if (contextId !== this.contextId) throw new RecoveryContextError("Provider 恢复上下文已变化，请刷新诊断并重新预览。");
    if (this.restartRequired) throw new RecoveryContextError("请重启 Xiu 后再使用 Provider 配置。");
    if (this.dependencies.isBusy()) throw new RecoveryContextError("请先结束任务、关闭终端并取消 OAuth，再恢复 Provider 配置。");
  }

  private async cancel(token: string): Promise<void> {
    await this.registry.confirmConfigurationRecovery(token, false).catch(() => undefined);
  }

  async handle(request: DesktopProviderRecoveryRequest): Promise<DesktopProviderRecoverySnapshot> {
    if (!request || !["snapshot", "preview", "recover", "cancel"].includes(request.action)) throw new RecoveryContextError("无效的 Provider 恢复请求。");
    if (this.operation) throw new RecoveryContextError("Provider 恢复操作正在进行。");
    this.operation = true;
    try {
      if (request.action === "snapshot") {
        const previous = this.pending; this.pending = undefined;
        if (previous) await this.cancel(previous.token);
        return await this.snapshot();
      }
      this.assertContext(request.contextId);
      if (request.action === "preview") {
        this.pending = undefined;
        const preview = await this.registry.previewConfigurationRecovery(request.backupId);
        try { this.assertContext(request.contextId); }
        catch (error) { await this.cancel(preview.token); throw error; }
        this.pending = preview;
        return await this.snapshot();
      }
      const preview = this.pending;
      if (!preview || typeof request.token !== "string" || preview.token !== request.token) throw new RecoveryContextError("恢复预览已失效，请重新预览。");
      this.pending = undefined;
      if (request.action === "cancel") { await this.cancel(preview.token); return await this.snapshot(); }
      // Only native confirmation and its commit need an exclusive host guard.
      // Metadata reads must not prevent Stop, steering or approval decisions.
      this.exclusiveRecovery = true;
      let applied = false;
      try {
        const confirmed = await this.dependencies.confirm(structuredClone(preview));
        this.assertContext(request.contextId);
        if (confirmed !== true) return await this.snapshot();
        await this.registry.confirmConfigurationRecovery(preview.token, true);
        applied = true;
        // Latch before cleanup: no existing host or stale UI may start another task.
        this.restartRequired = true;
        this.completedAction = preview.action;
        this.contextId = randomUUID();
        this.dependencies.onRecovered?.();
        return await this.snapshot();
      } finally { if (!applied) await this.cancel(preview.token); }
    } catch (error) {
      if (error instanceof RecoveryContextError) throw error;
      throw new Error(providerRecoveryError(error));
    } finally { this.exclusiveRecovery = false; this.operation = false; }
  }
}
