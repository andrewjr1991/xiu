import type { AgentRunOutcome } from "./agent.js";
import type { ProjectCheck } from "./commands/check.js";
import type { ContextWindowSource } from "./context.js";
import type { CredentialBackendStatus } from "./credential-store.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { TaskRunStatus } from "./task-run.js";

/** The values `/status` shows next to its localized labels, in the user's language rather than as the raw enum. */
export function runOutcomeLabel(outcome: AgentRunOutcome, language: UiLanguage): string {
  const labels: Record<AgentRunOutcome, [string, string]> = {
    idle: ["空闲", "idle"],
    running: ["运行中", "running"],
    completed: ["已完成", "completed"],
    unverified: ["完成但未验证", "completed without verification"],
    failed: ["失败", "failed"],
    cancelled: ["已取消", "cancelled"],
    paused: ["已安全暂停", "safely paused"],
    waiting_user: ["等待用户", "waiting for user"],
  };
  return localize(language, ...labels[outcome]);
}

/** The status column of the run lists (`/report runs`, `xiu report runs`, `/diff runs`), short enough for a 13-column table cell. */
export function taskRunStatusLabel(status: TaskRunStatus, language: UiLanguage): string {
  const labels: Record<TaskRunStatus, [string, string]> = {
    running: ["运行中", "running"],
    paused: ["已暂停", "paused"],
    completed: ["已完成", "completed"],
    failed: ["失败", "failed"],
    cancelled: ["已取消", "cancelled"],
    unverified: ["未验证", "unverified"],
    abandoned: ["已放弃", "abandoned"],
    waiting_user: ["等待用户", "waiting user"],
  };
  const entry = labels[status];
  return entry ? localize(language, ...entry) : status;
}

export function contextLimitModeLabel(mode: string, language: UiLanguage): string {
  return mode === "configured" ? localize(language, "已配置", "configured") : localize(language, "自动", "automatic");
}

export function contextWindowSourceLabel(source: ContextWindowSource | string, language: UiLanguage): string {
  const labels: Record<ContextWindowSource, [string, string]> = {
    official: ["官方数据", "official"],
    api: ["API 返回", "API"],
    configured: ["已配置", "configured"],
    fallback: ["默认值", "fallback"],
  };
  const entry = labels[source as ContextWindowSource];
  return entry ? localize(language, ...entry) : source;
}

/** The reasons `discoverProjectChecks` gives for an unavailable check, in the user's language; an unknown reason is shown as given. */
export function projectCheckReason(check: Pick<ProjectCheck, "name" | "reason" | "reasonCode" | "reasonDetail">, language: UiLanguage): string {
  const name = `${check.reasonDetail ?? ""}${check.name}`;
  switch (check.reasonCode) {
    case "no-package": return localize(language, "工作区根目录没有 package.json。", "No package.json in the workspace root.");
    case "cancelled": return localize(language, "发现已取消。", "Discovery cancelled.");
    case "no-script": return localize(language, `package.json 中没有 ${name} 脚本。`, `No ${name} script in package.json.`);
    case "empty-script": return localize(language, `${name} 脚本必须是非空字符串。`, `The ${name} script must be a non-empty string.`);
    case "not-string": return localize(language, `${name} 脚本必须是字符串。`, `The ${name} script must be a string.`);
    default: return check.reason ?? localize(language, "不可用", "unavailable");
  }
}

/** Reasons a credential backend reports that only restate what its storage column already says. */
const STORAGE_RESTATEMENTS = new Set(["process environment", "local plaintext compatibility storage", "system secure storage"]);

/** One `/credentials` line per backend: kind, availability, entry count, storage, and a reason only when it adds something. */
export function formatCredentialBackendStatus(label: string, backend: CredentialBackendStatus, language: UiLanguage): string {
  const storage = backend.backend === "environment"
    ? localize(language, "进程环境变量", "process environment")
    : backend.secure
    ? localize(language, "系统安全存储", "system secure storage")
    : localize(language, "本机明文兼容存储", "local plaintext compatibility storage");
  const state = backend.available ? localize(language, "可用", "available") : localize(language, "不可用", "unavailable");
  const reason = backend.reason && !STORAGE_RESTATEMENTS.has(backend.reason.trim().toLowerCase()) ? ` · ${backend.reason}` : "";
  return `${label}: ${backend.backend} · ${state} · ${backend.entries} ${localize(language, "项", "item(s)")} · ${storage}${reason}`;
}
