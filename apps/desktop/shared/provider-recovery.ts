import type { ProviderConfigurationDiagnostics, ProviderConfigurationRecoveryPreview } from "../../../src/provider-registry.js";

export type DesktopProviderRecoveryRequest = { action: "snapshot" }
  | { action: "preview"; contextId: string; backupId: string }
  | { action: "recover" | "cancel"; contextId: string; token: string };

export interface DesktopProviderRecoverySnapshot {
  contextId: string;
  diagnostics: ProviderConfigurationDiagnostics;
  preview?: ProviderConfigurationRecoveryPreview;
  restartRequired: boolean;
  completedAction?: "restore-backup" | "keep-current";
}
