import chalk from "chalk";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { describeFailure } from "../user-facing-errors.js";
import { selectTerminalOption } from "../interactive-ui.js";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import type { SecurityAuditOutcome } from "../security-audit.js";
import { probeWindowsSystemCredentialStore, type WindowsCredentialProbeResult, type WindowsSystemCredentialStore } from "../system-credential-store.js";
import { askQuestion } from "../terminal-prompts.js";

export interface CredentialCommandContext {
  auditCredential: (action: string, subject: string | undefined, outcome: SecurityAuditOutcome) => Promise<void>;
  config: AgentConfig;
  ensureSystemCredentialStore: () => Promise<WindowsSystemCredentialStore<string, "provider-api-key">>;
  formatCredentialProbe: (probe: WindowsCredentialProbeResult) => string;
  language: UiLanguage;
  printCredentialStatus: () => Promise<void>;
  providerRegistry: ProviderRegistry;
  switchProviderProfile: (profile: ProviderProfile, persist?: boolean, preferredModel?: string, forceCapabilityProbe?: boolean) => Promise<boolean>;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleCredentialCommand(task: string, ctx: CredentialCommandContext): Promise<boolean> {
  const { auditCredential, config, ensureSystemCredentialStore, formatCredentialProbe, language, printCredentialStatus, providerRegistry, switchProviderProfile } = ctx;
  if (task === "/credentials" || task === "/credentials status") {
    try { await printCredentialStatus(); }
    catch (error) { console.error(chalk.red(`${describeFailure(localize(language, "读取凭证状态失败", "Could not read credential status"), error, language)}\n`)); }
    return true;
  }
  if (task === "/credentials probe") {
    const confirmed = await askQuestion(chalk.yellow(localize(language,
      "将在 Windows Credential Manager 写入一个随机临时 Canary，回读验证后立即删除。继续？[y/N] ",
      "A random temporary canary will be written to Windows Credential Manager, verified, and immediately deleted. Continue? [y/N] ")));
    if (!/^(y|yes)$/i.test(confirmed.trim())) {
      await auditCredential("system-probe", "windows", "cancelled");
      console.log(chalk.dim(localize(language, "已取消系统凭证库探测。\n", "System credential probe cancelled.\n")));
      return true;
    }
    const probe = await probeWindowsSystemCredentialStore(true);
    await auditCredential("system-probe", "windows", probe.status.available ? "succeeded" : "failed");
    console.log(`${probe.status.available ? chalk.green(formatCredentialProbe(probe)) : chalk.red(formatCredentialProbe(probe))}\n`);
    return true;
  }
  if (task === "/credentials migrate" || task.startsWith("/credentials migrate ")) {
    const requestedCredential = task.slice("/credentials migrate".length).trim() || undefined;
    try {
      const argument = task.slice("/credentials migrate".length).trim();
      const candidates = providerRegistry.migrationCandidates();
      if (!candidates.length) {
        console.log(chalk.dim(localize(language, "没有可迁移的 Provider 明文 Key。\n", "No legacy Provider API keys are available to migrate.\n")));
        return true;
      }
      let ids: string[];
      if (argument === "--all") ids = candidates.map((item) => item.providerId);
      else if (argument) ids = [argument];
      else {
        const selected = await selectTerminalOption(localize(language, "选择要迁移的 Provider Key", "Choose a Provider key to migrate"), candidates.map((item) => ({ label: item.providerName, description: item.providerId, value: item.providerId })), language);
        if (!selected) { await auditCredential("provider-migrate", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "已取消迁移。\n", "Migration cancelled.\n"))); return true; }
        ids = [selected];
      }
      const names = ids.join(", ");
      const confirmed = await selectTerminalOption(localize(language,
        `将 ${names} 的 Key 复制到 Windows Credential Manager，回读校验后切换引用；暂不删除旧明文。继续？`,
        `Copy keys for ${names} to Windows Credential Manager, verify them, and switch references without deleting plaintext yet?`), [
        { label: localize(language, "继续迁移", "Migrate"), value: "yes" },
        { label: localize(language, "取消", "Cancel"), value: "no" },
      ], language);
      if (confirmed !== "yes") { await auditCredential("provider-migrate", names, "cancelled"); console.log(chalk.dim(localize(language, "已取消迁移。\n", "Migration cancelled.\n"))); return true; }
      const systemCredentialStore = await ensureSystemCredentialStore();
      providerRegistry.attachSystemCredentialStore(systemCredentialStore);
      await providerRegistry.migrateApiKeysToSystem(ids, systemCredentialStore);
      await auditCredential("provider-migrate", names, "succeeded");
      if (ids.includes(config.providerId)) await switchProviderProfile(providerRegistry.get(config.providerId)!, true, config.model);
      console.log(chalk.green(localize(language,
        `已迁移并校验 ${ids.length} 个 Provider Key；运行时已切换到系统凭证库，旧明文仍保留，可用 /credentials cleanup 单独清理。\n`,
        `Migrated and verified ${ids.length} Provider key(s). Runtime now uses the system store; plaintext remains until /credentials cleanup.\n`)));
      console.log(chalk.dim(localize(language,
        "为避免误删，迁移流程不会连带删除旧明文。确认重启后系统凭证可用，再单独运行 /credentials cleanup。\n",
        "To prevent accidental deletion, migration never removes plaintext. After verifying the system credential across a restart, run /credentials cleanup separately.\n")));
    } catch (error) {
      await auditCredential("provider-migrate", requestedCredential, "failed");
      console.error(chalk.red(`${describeFailure(localize(language, "凭证迁移失败；原引用与旧明文保持不变", "Credential migration failed; the original reference and plaintext remain unchanged"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/credentials cleanup" || task.startsWith("/credentials cleanup ")) {
    const requestedCredential = task.slice("/credentials cleanup".length).trim() || undefined;
    try {
      const argument = task.slice("/credentials cleanup".length).trim();
      const candidates = providerRegistry.credentialInfo().filter((item) => item.migration && (item.legacyCopyPresent || item.systemCopyPresent));
      const selected = argument || await selectTerminalOption(localize(language, "选择要清理旧明文的 Provider", "Choose a Provider whose plaintext copy should be removed"), candidates.map((item) => ({ label: item.providerName, description: item.providerId, value: item.providerId })), language);
      if (!selected) { await auditCredential("provider-cleanup", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "没有选择凭证，未做更改。\n", "No credential selected; nothing changed.\n"))); return true; }
      const confirmed = await selectTerminalOption(localize(language, `确认删除 ${selected} 的旧明文 Key？系统副本会先被再次校验。`, `Delete the legacy plaintext key for ${selected}? The system copy will be verified again first.`), [
        { label: localize(language, "删除旧明文", "Delete plaintext"), value: "yes" }, { label: localize(language, "取消", "Cancel"), value: "no" },
      ], language);
      if (confirmed !== "yes") { await auditCredential("provider-cleanup", selected, "cancelled"); console.log(chalk.dim(localize(language, "已取消清理。\n", "Cleanup cancelled.\n"))); return true; }
      const typed = await askQuestion(chalk.yellow(localize(language,
        `这是不可逆操作。请输入 Provider ID “${selected}” 再次确认：`,
        `This cannot be undone. Type the Provider ID "${selected}" to confirm: `)));
      if (typed.trim() !== selected) { await auditCredential("provider-cleanup", selected, "cancelled"); console.log(chalk.dim(localize(language, "Provider ID 不匹配，已取消清理。\n", "Provider ID did not match; cleanup cancelled.\n"))); return true; }
      await providerRegistry.cleanupLegacyApiKey(selected);
      await auditCredential("provider-cleanup", selected, "succeeded");
      console.log(chalk.green(localize(language, "旧明文副本已安全删除。\n", "Legacy plaintext copy safely deleted.\n")));
    } catch (error) { await auditCredential("provider-cleanup", requestedCredential, "failed"); console.error(chalk.red(`${describeFailure(localize(language, "凭证清理失败", "Credential cleanup failed"), error, language)}\n`)); }
    return true;
  }
  if (task === "/credentials rollback" || task.startsWith("/credentials rollback ")) {
    const requestedCredential = task.slice("/credentials rollback".length).trim() || undefined;
    try {
      const argument = task.slice("/credentials rollback".length).trim();
      const candidates = providerRegistry.credentialInfo().filter((item) => item.migration && item.legacyCopyPresent);
      const selected = argument || await selectTerminalOption(localize(language, "选择要回退的 Provider", "Choose a Provider to roll back"), candidates.map((item) => ({ label: item.providerName, description: item.providerId, value: item.providerId })), language);
      if (!selected) { await auditCredential("provider-rollback", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "没有选择凭证，未做更改。\n", "No credential selected; nothing changed.\n"))); return true; }
      const confirmed = await selectTerminalOption(localize(language, `将 ${selected} 切回保留的旧明文 Key，并尝试删除系统副本。继续？`, `Switch ${selected} back to its retained plaintext key and try to delete the system copy?`), [
        { label: localize(language, "确认回退", "Roll back"), value: "yes" }, { label: localize(language, "取消", "Cancel"), value: "no" },
      ], language);
      if (confirmed !== "yes") { await auditCredential("provider-rollback", selected, "cancelled"); console.log(chalk.dim(localize(language, "已取消回退。\n", "Rollback cancelled.\n"))); return true; }
      const systemDeleted = await providerRegistry.rollbackSystemApiKey(selected);
      await auditCredential("provider-rollback", selected, "succeeded");
      if (selected === config.providerId) await switchProviderProfile(providerRegistry.get(selected)!, true, config.model);
      console.log((systemDeleted ? chalk.green : chalk.yellow)(localize(language,
        systemDeleted ? "已切回旧明文 Key，系统副本已删除。\n" : "已切回旧明文 Key，但系统副本未能删除；可稍后使用 /credentials forget 明确清理。\n",
        systemDeleted ? "Rolled back to the legacy key and deleted the system copy.\n" : "Rolled back to the legacy key, but the system copy could not be deleted; use /credentials forget to clean it explicitly.\n")));
    } catch (error) { await auditCredential("provider-rollback", requestedCredential, "failed"); console.error(chalk.red(`${describeFailure(localize(language, "凭证回退失败", "Credential rollback failed"), error, language)}\n`)); }
    return true;
  }
  if (task === "/credentials forget" || task.startsWith("/credentials forget ")) {
    const requestedCredential = task.slice("/credentials forget".length).trim() || undefined;
    try {
      const argument = task.slice("/credentials forget".length).trim();
      const candidates = providerRegistry.credentialInfo().filter((item) => item.legacyCopyPresent || item.systemCopyPresent || item.migration || item.interruptedMigration);
      const selected = argument || await selectTerminalOption(localize(language, "选择要遗忘本地 Key 的 Provider", "Choose a Provider whose local keys should be forgotten"), candidates.map((item) => ({ label: item.providerName, description: `${item.providerId} · ${item.source}`, value: item.providerId })), language);
      if (!selected) { await auditCredential("provider-forget", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "没有选择凭证，未做更改。\n", "No credential selected; nothing changed.\n"))); return true; }
      const confirmed = await selectTerminalOption(chalk.yellow(localize(language,
        `将删除 ${selected} 在系统凭证库和兼容文件中的所有本地 Key；环境变量不会改变。确认？`,
        `Delete every local key for ${selected} from the system store and compatibility file? Environment variables are unchanged.`)), [
        { label: localize(language, "永久遗忘本地 Key", "Forget local keys"), value: "yes" }, { label: localize(language, "取消", "Cancel"), value: "no" },
      ], language);
      if (confirmed !== "yes") { await auditCredential("provider-forget", selected, "cancelled"); console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n"))); return true; }
      const typed = await askQuestion(chalk.yellow(localize(language,
        `这将删除全部本地 Key 副本。请输入 Provider ID “${selected}” 再次确认：`,
        `This deletes every local key copy. Type the Provider ID "${selected}" to confirm: `)));
      if (typed.trim() !== selected) { await auditCredential("provider-forget", selected, "cancelled"); console.log(chalk.dim(localize(language, "Provider ID 不匹配，已取消遗忘。\n", "Provider ID did not match; forget cancelled.\n"))); return true; }
      await providerRegistry.forgetLocalApiKey(selected);
      await auditCredential("provider-forget", selected, "succeeded");
      if (selected === config.providerId) await switchProviderProfile(providerRegistry.get(selected)!, true, config.model);
      console.log(chalk.green(localize(language, "本地 Provider Key 已遗忘。\n", "Local Provider keys forgotten.\n")));
    } catch (error) { await auditCredential("provider-forget", requestedCredential, "failed"); console.error(chalk.red(`${describeFailure(localize(language, "遗忘凭证失败", "Could not forget credential"), error, language)}\n`)); }
    return true;
  }
  return false;
}
