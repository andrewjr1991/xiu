import type { ProviderRegistry, ProviderConfigurationDiagnostics, ProviderConfigurationRecoveryPreview } from "../provider-registry.js";
import { ProviderConfigurationError } from "../provider-config-migration.js";
import { localize, type UiLanguage } from "../i18n.js";

export type ProviderRecoveryRegistry = Pick<ProviderRegistry, "configurationDiagnostics" | "previewConfigurationRecovery" | "confirmConfigurationRecovery">;
export type ProviderRecoveryCommand = { action: "list" } | { action: "preview" | "recover"; backupId: string };
export interface ProviderRecoveryCommandIO {
  language: UiLanguage;
  interactive: boolean;
  write: (text: string) => void;
  ask: (prompt: string) => Promise<string>;
}

export function providerRecoveryError(error: unknown): string {
  // Unknown exceptions can contain file contents, paths or credential material.
  return error instanceof ProviderConfigurationError ? error.message : "Provider recovery did not complete. Refresh configuration diagnostics before retrying.";
}

function formatDiagnostics(value: ProviderConfigurationDiagnostics, language: UiLanguage): string {
  const lines = [localize(language, "Provider 配置诊断（只读）", "Provider configuration diagnostics (read-only)"),
    `${value.state} · schema ${value.sourceVersion ?? "unknown"} · supported ${value.supportedVersion}`,
    value.compatibilityNotice, ...value.issues.map((issue) => `- ${issue}`),
    localize(language, "可验证的受保护备份：", "Verified protected backups:")];
  lines.push(...value.backups.map((backup) => `${backup.id} · schema ${backup.sourceVersion ?? "unknown"} · ${backup.reason} · ${backup.createdAt}`));
  if (!value.backups.length) lines.push(localize(language, "没有可用备份。不会重置或覆盖当前配置。", "No available backup. Current settings will not be reset or overwritten."));
  if (value.issues.includes("interrupted-write-can-keep-current")) lines.push(localize(language,
    "current：保留当前配置，仅清理已确认退出进程的中断写锁（不是恢复备份）。", "current: Keep current settings and clear the verified dead process's interrupted write lock (does not restore a backup)."));
  lines.push("xiu --provider-config-preview <backup-id|current>", "xiu --provider-config-recover <backup-id|current>");
  return lines.join("\n");
}

function formatPreview(value: ProviderConfigurationRecoveryPreview, language: UiLanguage): string {
  return [value.action === "keep-current"
    ? localize(language, "保留当前配置；仅清理中断写锁", "Keep current settings; clear interrupted write lock only")
    : localize(language, `恢复备份 ${value.backupId}`, `Restore backup ${value.backupId}`),
  `${value.action === "keep-current" ? `schema ${value.currentVersion ?? "missing"} (${localize(language, "保持不变", "unchanged")})` : `schema ${value.currentVersion ?? "unknown"} → ${value.sourceVersion}`} · ${localize(language, "预览有效至", "Preview expires")} ${value.expiresAt}`,
  ...value.warnings.map((warning) => `- ${warning}`)].join("\n");
}

/** Separate startup entry: intentionally never loads providers or reads a workspace. */
export async function runProviderRecoveryCommand(registry: ProviderRecoveryRegistry, command: ProviderRecoveryCommand, io: ProviderRecoveryCommandIO): Promise<{ exitCode: number; restartRequired: boolean }> {
  let preview: ProviderConfigurationRecoveryPreview | undefined;
  let restored = false;
  try {
    if (command.action === "list") {
      io.write(formatDiagnostics(await registry.configurationDiagnostics(), io.language));
      return { exitCode: 0, restartRequired: false };
    }
    preview = await registry.previewConfigurationRecovery(command.backupId);
    io.write(formatPreview(preview, io.language));
    if (command.action === "preview") return { exitCode: 0, restartRequired: false };
    if (!io.interactive) {
      io.write(localize(io.language, "恢复需要交互式终端中的明确确认；--yes 和管道输入不会授权恢复。", "Recovery needs explicit confirmation in an interactive terminal; --yes and piped input do not authorize recovery."));
      return { exitCode: 1, restartRequired: false };
    }
    const answer = await io.ask(localize(io.language, "请先关闭其他 Xiu 客户端。输入 RECOVER 确认以上操作，其他输入取消：", "Close other Xiu clients first. Type RECOVER to confirm the operation above; anything else cancels: "));
    if (answer.trim() !== "RECOVER") {
      io.write(localize(io.language, "已取消；配置未更改。", "Cancelled; configuration unchanged."));
      return { exitCode: 0, restartRequired: false };
    }
    await registry.confirmConfigurationRecovery(preview.token, true);
    restored = true;
    io.write(preview.action === "keep-current"
      ? localize(io.language, "已清理中断写锁，当前配置保持不变。请重启 Xiu。", "Interrupted write lock cleared; current settings kept. Restart Xiu.")
      : localize(io.language, "配置备份已恢复。请重启 Xiu；CLI 和桌面需要使用匹配的升级版本。", "Configuration backup restored. Restart Xiu; CLI and desktop must use matching upgraded versions."));
    return { exitCode: 0, restartRequired: true };
  } catch (error) {
    io.write(providerRecoveryError(error));
    return { exitCode: 1, restartRequired: false };
  } finally {
    // False consumes the one-use intent without replacing bytes.
    if (preview && !restored) await registry.confirmConfigurationRecovery(preview.token, false).catch(() => undefined);
  }
}
