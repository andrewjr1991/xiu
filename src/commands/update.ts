import type { UiLanguage } from "../i18n.js";
import { localize } from "../i18n.js";
import type { XiuSettings } from "../settings.js";
import {
  checkForUpdates,
  diagnoseUpdateInstallation,
  formatUpdateCheck,
  formatUpdateCheckError,
  formatUpdateDoctor,
  formatUpdateNotificationStatus,
  formatUpdateReminder,
  UpdateCheckCache,
  updateDoctorHasHardFailure,
  updateProxyFromEnvironment,
  type CachedUpdateCheck,
  type UpdateCheckCacheReader,
  type UpdateCheckResult,
  type UpdateDoctorResult,
} from "../update-check.js";

export type UpdateMessageKind = "info" | "success" | "warning" | "error";

export interface UpdateMessage {
  kind: UpdateMessageKind;
  text: string;
}

export interface UpdateCommandResult {
  handled: boolean;
  messages: UpdateMessage[];
}

interface UpdateCache extends UpdateCheckCacheReader {
  load(currentVersion: string): Promise<CachedUpdateCheck | undefined>;
  save(result: UpdateCheckResult): Promise<void>;
}

export interface UpdateCommandControllerOptions {
  currentVersion: string;
  language: UiLanguage;
  settings: XiuSettings;
  saveSettings: () => Promise<void>;
  cache?: UpdateCache;
  check?: (timeoutMs?: number) => Promise<UpdateCheckResult>;
  diagnose?: () => Promise<UpdateDoctorResult>;
}

export interface UpdateOneShotOptions {
  currentVersion: string;
  language: UiLanguage;
  cache?: UpdateCache;
  check?: () => Promise<UpdateCheckResult>;
  diagnose?: () => Promise<UpdateDoctorResult>;
}

export interface UpdateOneShotResult {
  message: UpdateMessage;
  exitCode: number;
}

export const UPDATE_COMMAND_USAGE = "/update, /update doctor, /update status, /update notifications on, /update notifications off";

function defaultCheck(currentVersion: string, timeoutMs?: number): Promise<UpdateCheckResult> {
  return checkForUpdates(currentVersion, { proxy: updateProxyFromEnvironment(), ...(timeoutMs ? { timeoutMs } : {}) });
}

function updateFailure(error: unknown, language: UiLanguage): UpdateMessage {
  return {
    kind: "error",
    text: `${localize(language, "版本检查失败", "Update check failed")}: ${formatUpdateCheckError(error, language)}`,
  };
}

export async function runUpdateCheckOnce(options: UpdateOneShotOptions): Promise<UpdateOneShotResult> {
  const cache = options.cache ?? new UpdateCheckCache();
  try {
    const result = await (options.check ?? (() => defaultCheck(options.currentVersion)))();
    await cache.save(result).catch(() => undefined);
    return { message: { kind: "info", text: formatUpdateCheck(result, options.language) }, exitCode: 0 };
  } catch (error) {
    return { message: updateFailure(error, options.language), exitCode: 1 };
  }
}

export async function runUpdateDoctorOnce(options: UpdateOneShotOptions): Promise<UpdateOneShotResult> {
  const cache = options.cache ?? new UpdateCheckCache();
  const result = await (options.diagnose ?? (() => diagnoseUpdateInstallation(options.currentVersion, { cache })))();
  return {
    message: { kind: updateDoctorHasHardFailure(result) ? "error" : "info", text: formatUpdateDoctor(result, options.language) },
    exitCode: updateDoctorHasHardFailure(result) ? 1 : 0,
  };
}

export class UpdateCommandController {
  private readonly cache: UpdateCache;
  private pendingReminder?: UpdateCheckResult;
  private reminderGeneration = 0;
  private remindedVersion?: string;

  constructor(private readonly options: UpdateCommandControllerOptions) {
    this.cache = options.cache ?? new UpdateCheckCache();
  }

  async initialize(): Promise<UpdateMessage[]> {
    if (!this.options.settings.update?.notifications) return [];
    const cached = await this.cache.load(this.options.currentVersion);
    if (cached?.fresh) return this.reminder(cached.result);
    this.scheduleReminderRefresh();
    return [];
  }

  flushPendingReminder(): UpdateMessage[] {
    if (!this.pendingReminder) return [];
    const result = this.pendingReminder;
    this.pendingReminder = undefined;
    return this.reminder(result);
  }

  async execute(command: string): Promise<UpdateCommandResult> {
    if (command !== "/update" && !command.startsWith("/update ")) return { handled: false, messages: [] };
    if (command === "/update status") {
      const cached = await this.cache.load(this.options.currentVersion);
      return { handled: true, messages: [{ kind: "info", text: formatUpdateNotificationStatus(Boolean(this.options.settings.update?.notifications), cached, this.options.language) }] };
    }
    if (command === "/update doctor") {
      const result = await (this.options.diagnose ?? (() => diagnoseUpdateInstallation(this.options.currentVersion, { cache: this.cache })))();
      return { handled: true, messages: [{ kind: updateDoctorHasHardFailure(result) ? "error" : "info", text: formatUpdateDoctor(result, this.options.language) }] };
    }
    if (command === "/update notifications on") {
      this.options.settings.update = { notifications: true };
      await this.options.saveSettings();
      const messages: UpdateMessage[] = [{
        kind: "success",
        text: localize(this.options.language, "更新提醒已启用；将复用 24 小时缓存，并只在安全输入边界显示。", "Update reminders enabled with a 24-hour cache and safe-boundary display only."),
      }];
      const cached = await this.cache.load(this.options.currentVersion);
      if (cached?.fresh) messages.push(...this.reminder(cached.result));
      else this.scheduleReminderRefresh();
      return { handled: true, messages };
    }
    if (command === "/update notifications off") {
      this.options.settings.update = { notifications: false };
      this.reminderGeneration += 1;
      this.pendingReminder = undefined;
      await this.options.saveSettings();
      return {
        handled: true,
        messages: [{
          kind: "success",
          text: localize(this.options.language, "更新提醒已关闭。显式 /update 和 xiu --check-update 仍可使用。", "Update reminders disabled. Explicit /update and xiu --check-update remain available."),
        }],
      };
    }
    if (command !== "/update") {
      return { handled: true, messages: [{ kind: "info", text: `${localize(this.options.language, "用法", "Usage")}: ${UPDATE_COMMAND_USAGE}` }] };
    }
    try {
      const result = await (this.options.check ?? ((timeoutMs) => defaultCheck(this.options.currentVersion, timeoutMs)))();
      await this.cache.save(result).catch(() => undefined);
      if (result.status === "update-available") this.remindedVersion = result.latestVersion;
      return { handled: true, messages: [{ kind: "info", text: formatUpdateCheck(result, this.options.language) }] };
    } catch (error) {
      return { handled: true, messages: [updateFailure(error, this.options.language)] };
    }
  }

  private reminder(result: UpdateCheckResult): UpdateMessage[] {
    if (result.status !== "update-available" || this.remindedVersion === result.latestVersion) return [];
    this.remindedVersion = result.latestVersion;
    return [{ kind: "warning", text: formatUpdateReminder(result, this.options.language) }];
  }

  private scheduleReminderRefresh(): void {
    const generation = ++this.reminderGeneration;
    void (this.options.check ?? ((timeoutMs) => defaultCheck(this.options.currentVersion, timeoutMs)))(3_000)
      .then(async (result) => {
        await this.cache.save(result).catch(() => undefined);
        if (generation === this.reminderGeneration && this.options.settings.update?.notifications) this.pendingReminder = result;
      })
      .catch(() => undefined);
  }
}
