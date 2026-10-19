import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localize, type UiLanguage } from "./i18n.js";
import { UV_VERSION, managedUvHome, uvExecutableName } from "./uv-install.js";
import { FREE_SEARCH_VERSION } from "./free-search.js";
import type { ProviderConfigurationDiagnostics } from "./provider-config-migration.js";
import type { ProviderCredentialInfo, ProviderProfile } from "./provider-registry.js";
import { redactSecrets } from "./secret-redaction.js";
import { listSessionsWithIssues } from "./session.js";
import type { XiuSettings } from "./settings.js";
import { TaskRunJournal } from "./task-run.js";
import { isWorkspaceTrusted } from "./trust.js";
import { UpdateCheckCache, diagnoseUpdateInstallation, type UpdateDoctorItem, type UpdateDoctorResult } from "./update-check.js";
import { explainError } from "./user-facing-errors.js";

/**
 * `xiu doctor`: one read-only report that merges the update/installation
 * doctor, provider-configuration diagnostics, the web-search configuration,
 * proxy and certificate settings and (on Windows) the PowerShell language mode.
 *
 * The report is meant to be pasted to a maintainer, so every value that could
 * carry a secret is redacted before it is returned: API keys, environment
 * credentials and proxy passwords never appear. Nothing is modified and no
 * credential is sent anywhere; the only network access is the update doctor's
 * existing registry lookup.
 */

export type DoctorLevel = "pass" | "warning" | "failure" | "info";

export interface DoctorItem {
  id: string;
  level: DoctorLevel;
  labelZh: string;
  labelEn: string;
  summaryZh: string;
  summaryEn: string;
  detailZh?: string;
  detailEn?: string;
}

export interface DoctorSection {
  id: "installation" | "providers" | "web-search" | "proxy" | "windows" | "workspace" | "system";
  titleZh: string;
  titleEn: string;
  items: DoctorItem[];
}

export interface DoctorReport {
  version: string;
  generatedAt: string;
  status: Exclude<DoctorLevel, "info">;
  sections: DoctorSection[];
}

export interface DoctorProviderRegistry {
  load(): Promise<void>;
  list(): ProviderProfile[];
  activeId(): string | undefined;
  activeModel(id: string): string | undefined;
  credentialInfo(): ProviderCredentialInfo[];
  configurationDiagnostics(): Promise<ProviderConfigurationDiagnostics>;
}

export interface PowerShellProbe {
  languageMode?: string;
  executionPolicy?: string;
  error?: string;
}

/** What the workspace's own records look like: counts, what could not be read, and whether an interrupted task is pending. */
export interface WorkspaceRecordsProbe {
  /** False when the workspace is not trusted; its records are then not read at all. */
  trusted: boolean;
  runs: number;
  unreadableRuns: Array<{ runId: string; reason: string }>;
  sessions: number;
  unreadableSessions: Array<{ id: string; reason: string }>;
  interrupted?: { runId: string; status: string; startedAt: string };
  /** The interrupted-run check could not complete; a reason without a path. One-shot runs are refused until it can. */
  interruptedCheckFailure?: string;
  /** The records could not be listed at all; a reason without a path. */
  listingFailure?: string;
}

export interface DoctorOptions {
  version: string;
  settings: XiuSettings;
  registry?: DoctorProviderRegistry;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  osRelease?: string;
  cwd?: string;
  homeDirectory?: string;
  now?: Date;
  updateDoctor?: () => Promise<UpdateDoctorResult>;
  powerShell?: () => Promise<PowerShellProbe>;
  /** Returns the path of a usable uv/uvx that free-search would launch, or undefined. */
  uvAvailable?: () => Promise<string | undefined>;
  /** Extra values that must never appear in the report (API keys already known to the caller). */
  sensitive?: readonly string[];
  /** Replaces the real look at the workspace's task-run journal and session logs. */
  workspaceRecords?: () => Promise<WorkspaceRecordsProbe>;
  /** How `~/.xiu/settings.json` was read (`SettingsStore.inspect()`); omitted, the report says nothing about the file. */
  settingsFile?: { state: "read" | "absent" | "unreadable"; cause?: string };
}

function reasonWithoutPath(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code) return code;
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message.split(/:\s/)[0] ?? message).replace(/\s+/g, " ").slice(0, 80);
}

/**
 * Reads the workspace's task-run journal and session logs the way `/report runs`, `/diff runs` and
 * `/resume` do, counting what is readable and naming what is not. Read-only. An untrusted workspace
 * is not read at all. The interrupted-run check is the strict one a new one-shot run performs, so
 * the report can say in advance that one-shot runs will be refused and why.
 */
export async function probeWorkspaceRecords(cwd: string, options: { trusted?: () => Promise<boolean>; taskRunRoot?: string } = {}): Promise<WorkspaceRecordsProbe> {
  const trusted = await (options.trusted ?? (() => isWorkspaceTrusted(cwd)))().catch(() => false);
  const probe: WorkspaceRecordsProbe = { trusted, runs: 0, unreadableRuns: [], sessions: 0, unreadableSessions: [] };
  if (!trusted) return probe;
  const journal = new TaskRunJournal(cwd, options.taskRunRoot);
  try {
    const [scan, sessions] = await Promise.all([journal.scan(500), listSessionsWithIssues(cwd)]);
    probe.runs = scan.records.length;
    probe.unreadableRuns = scan.unreadable;
    probe.sessions = sessions.sessions.length;
    probe.unreadableSessions = sessions.unreadable;
  } catch (error) {
    probe.listingFailure = reasonWithoutPath(error);
  }
  try {
    const record = await journal.interrupted();
    if (record) probe.interrupted = { runId: record.runId, status: record.status, startedAt: record.startedAt };
  } catch (error) {
    probe.interruptedCheckFailure = reasonWithoutPath(error);
  }
  return probe;
}

function countReasons(items: Array<{ reason: string }>, language: "zh" | "en"): string {
  const counts = new Map<string, number>();
  for (const entry of items) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} ×${count}`).join(language === "zh" ? "、" : ", ");
}

function workspaceSection(probe: WorkspaceRecordsProbe): DoctorSection {
  const section = (items: DoctorItem[]): DoctorSection => ({ id: "workspace", titleZh: "工作区记录", titleEn: "Workspace records", items });
  if (!probe.trusted) {
    return section([item("workspace-trust", "info", ["信任", "Trust"],
      ["工作区尚未信任，未读取它的任务记录与会话日志", "This workspace is not trusted yet, so its task records and session logs were not read"],
      ["交互运行一次 xiu 并确认信任后，这一段才会检查运行记录、会话日志和中断任务。", "Run xiu interactively once and confirm trust; this section then checks run records, session logs and interrupted tasks."])]);
  }
  if (probe.listingFailure) {
    return section([item("workspace-listing", "failure", ["任务记录", "Task records"],
      [`无法列出任务记录或会话日志（${probe.listingFailure}）`, `Task records or session logs could not be listed (${probe.listingFailure})`],
      ["检查 ~/.xiu/task-runs 与工作区 .xiu/sessions 的读取权限；/report runs、/diff runs 与 /resume 在此之前都不可用。", "Check read access to ~/.xiu/task-runs and the workspace's .xiu/sessions; /report runs, /diff runs and /resume are unavailable until then."]),
    ...interruptedItems(probe)]);
  }
  const runs = probe.unreadableRuns.length
    ? item("task-runs", "warning", ["运行记录", "Run records"],
      [`${probe.runs} 条可读，另有 ${probe.unreadableRuns.length} 条无法读取（${countReasons(probe.unreadableRuns, "zh")}）`, `${probe.runs} readable, ${probe.unreadableRuns.length} more could not be read (${countReasons(probe.unreadableRuns, "en")})`],
      ["无法读取的记录不会出现在 /report runs、/diff runs 与桌面近期任务里；它们是 ~/.xiu/task-runs/<工作区摘要>/ 下的 <运行 ID>.json，确认无需保留后可删除。", "Unreadable records do not appear in /report runs, /diff runs or the desktop's recent tasks; they are <run id>.json files under ~/.xiu/task-runs/<workspace digest>/ and can be deleted once you are sure they are not needed."])
    : item("task-runs", "pass", ["运行记录", "Run records"], [`${probe.runs} 条，全部可读`, `${probe.runs}, all readable`]);
  const sessions = probe.unreadableSessions.length
    ? item("sessions", "warning", ["会话日志", "Session logs"],
      [`${probe.sessions} 个可读，另有 ${probe.unreadableSessions.length} 个无法读取（${countReasons(probe.unreadableSessions, "zh")}）`, `${probe.sessions} readable, ${probe.unreadableSessions.length} more could not be read (${countReasons(probe.unreadableSessions, "en")})`],
      ["无法读取的会话不会出现在 /resume 与 /history sessions 里，相关运行的执行报告会标为“会话日志无法读取”；它们是工作区 .xiu/sessions/ 下的 <会话 ID>.jsonl。", "Unreadable sessions do not appear in /resume or /history sessions and their runs' execution reports say the session log is unreadable; they are <session id>.jsonl files under the workspace's .xiu/sessions/."])
    : item("sessions", "pass", ["会话日志", "Session logs"], [`${probe.sessions} 个，全部可读`, `${probe.sessions}, all readable`]);
  return section([runs, sessions, ...interruptedItems(probe)]);
}

function interruptedItems(probe: WorkspaceRecordsProbe): DoctorItem[] {
  if (probe.interruptedCheckFailure) {
    return [item("interrupted", "failure", ["中断任务", "Interrupted task"],
      [`中断任务检查无法完成（${probe.interruptedCheckFailure}）`, `The interrupted-task check could not complete (${probe.interruptedCheckFailure})`],
      ["新的一次性运行（xiu <任务>、xiu --json）会返回 not_started 直到此检查能完成；运行 xiu recover status 查看，修复或删除无法读取的运行记录后重试。", "New one-shot runs (xiu <task>, xiu --json) return not_started until this check can complete; run xiu recover status, then fix or delete the unreadable run record and retry."])];
  }
  if (probe.interrupted) {
    return [item("interrupted", "warning", ["中断任务", "Interrupted task"],
      [`有一条待处理的中断任务：${probe.interrupted.runId.slice(0, 8)}（${probe.interrupted.status}，${probe.interrupted.startedAt.slice(0, 19)}）`, `One interrupted task is pending: ${probe.interrupted.runId.slice(0, 8)} (${probe.interrupted.status}, ${probe.interrupted.startedAt.slice(0, 19)})`],
      [`新的一次性运行会返回 not_started 直到处理它：交互模式按提示恢复或放弃，或运行 xiu recover abandon ${probe.interrupted.runId.slice(0, 8)} 明确放弃（不重放任何操作）。`, `New one-shot runs return not_started until it is handled: resume or abandon it from the interactive prompt, or run xiu recover abandon ${probe.interrupted.runId.slice(0, 8)} to abandon it explicitly (nothing is replayed).`])];
  }
  return [item("interrupted", "pass", ["中断任务", "Interrupted task"], ["没有待处理的中断任务", "none pending"])];
}

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "XIU_UPDATE_PROXY", "XIU_WEB_PROXY", "npm_config_proxy", "npm_config_https_proxy"] as const;
const NO_PROXY_VARIABLES = ["NO_PROXY", "no_proxy"] as const;
const KNOWN_KEY_VARIABLES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AGNES_API_KEY", "DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY", "ZHIPUAI_API_KEY", "MOONSHOT_API_KEY", "ARK_API_KEY", "SILICONFLOW_API_KEY", "MINIMAX_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "XIU_BETA_SEARXNG_TOKEN"];
const HOSTED_KINDS = new Set(["agnes", "openai", "anthropic"]);
const TLS_PATTERN = /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID|certificate/i;

function item(id: string, level: DoctorLevel, label: [string, string], summary: [string, string], detail?: [string, string]): DoctorItem {
  return { id, level, labelZh: label[0], labelEn: label[1], summaryZh: summary[0], summaryEn: summary[1], ...(detail ? { detailZh: detail[0], detailEn: detail[1] } : {}) };
}

/** Keeps scheme, host, port and path of a proxy URL; replaces embedded credentials and flags unparsable values. */
export function describeProxyValue(value: string): { display: string; host?: string; hadCredentials: boolean; invalid: boolean } {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const hadCredentials = Boolean(url.username || url.password);
    const display = `${url.protocol}//${hadCredentials ? "***@" : ""}${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    return { display, host: url.host, hadCredentials, invalid: false };
  } catch {
    return { display: "(unparsable)", hadCredentials: false, invalid: true };
  }
}

function parseMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

async function defaultPowerShellProbe(): Promise<PowerShellProbe> {
  const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    const child = execFile(shell, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output $ExecutionContext.SessionState.LanguageMode; Write-Output (Get-ExecutionPolicy)"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve({ error: error.message.split("\n")[0] }); return; }
      const [languageMode, executionPolicy] = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      resolve({ languageMode, executionPolicy });
    });
    child.on("error", (error) => resolve({ error: error.message }));
  });
}

async function defaultUvAvailable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const home = managedUvHome();
  try {
    if ((await fs.readFile(path.join(home, "VERSION"), "utf8")).trim() === UV_VERSION) {
      const uvx = path.join(home, uvExecutableName("uvx", platform));
      await fs.access(uvx);
      return uvx;
    }
  } catch { /* fall through to PATH lookup */ }
  const name = uvExecutableName("uvx", platform);
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try { await fs.access(path.join(directory, name)); return path.join(directory, name); }
    catch { /* keep looking */ }
  }
  return undefined;
}

function settingsFileItem(probe: NonNullable<DoctorOptions["settingsFile"]>): DoctorItem {
  const label: [string, string] = ["设置文件", "Settings file"];
  if (probe.state === "unreadable") {
    const cause = (probe.cause ?? "unreadable").replace(/\s+/g, " ").slice(0, 160);
    return item("settings", "failure", label,
      [`~/.xiu/settings.json 无法读取（${cause}）`, `~/.xiu/settings.json could not be read (${cause})`],
      ["修复其中的 JSON 或把文件移走后再运行 xiu；语言与联网搜索设置保存在这里。修好之前，除 xiu doctor 外的命令都会以这个错误退出，不会悄悄改用默认设置。",
        "Fix its JSON or move the file away, then run xiu again; the language and web-search settings live there. Until then every command but xiu doctor exits with this error instead of silently using defaults."]);
  }
  return probe.state === "read"
    ? item("settings", "pass", label, ["~/.xiu/settings.json 已读取", "~/.xiu/settings.json read"])
    : item("settings", "pass", label, ["不存在，使用默认设置", "absent, defaults in use"]);
}

function installationSection(result: UpdateDoctorResult | undefined, failure: unknown, nodeVersion: string, settingsFile?: DoctorOptions["settingsFile"]): DoctorSection {
  const labels: Record<UpdateDoctorItem["id"], [string, string]> = {
    runtime: ["运行环境", "Runtime"], package: ["包完整性", "Package integrity"], command: ["命令来源", "Command resolution"], prefix: ["npm prefix", "npm prefix"],
    proxy: ["更新代理", "Update proxy"], cache: ["更新缓存", "Update cache"], registry: ["官方 Registry", "Official registry"], release: ["发布元数据", "Release metadata"],
  };
  const items: DoctorItem[] = [];
  if (result) {
    for (const entry of result.items) {
      items.push(item(`update-${entry.id}`, entry.level, labels[entry.id], [entry.summaryZh ?? entry.summary, entry.summary], entry.detail || entry.detailZh ? [entry.detailZh ?? entry.detail ?? "", entry.detail ?? entry.detailZh ?? ""] : undefined));
    }
  } else {
    const explanation = explainError(failure, "zh-CN");
    const english = explainError(failure, "en-US");
    items.push(item("update-doctor", "warning", ["更新诊断", "Update diagnostics"], [`未能完成：${explanation.cause}`, `Did not complete: ${english.cause}`], [explanation.nextStep, english.nextStep]));
  }
  if (settingsFile) items.push(settingsFileItem(settingsFile));
  if (parseMajor(nodeVersion) === 20) {
    items.push(item("node-eol", "warning", ["Node.js 版本", "Node.js version"],
      [`Node ${nodeVersion} 已于 2026-04-30 停止维护；Xiu 0.22 起要求 Node 22.12 或更高。`, `Node ${nodeVersion} reached end of life on 2026-04-30; Xiu 0.22 will require Node 22.12 or newer.`],
      ["请尽早升级到 Node 22 LTS 后重新安装 @xiu-ai/cli。", "Upgrade to Node 22 LTS and reinstall @xiu-ai/cli."]));
  }
  return { id: "installation", titleZh: "安装与运行环境", titleEn: "Installation and runtime", items };
}

async function providerSection(registry: DoctorProviderRegistry | undefined, env: NodeJS.ProcessEnv): Promise<{ section: DoctorSection; sensitive: string[] }> {
  const items: DoctorItem[] = [];
  const sensitive: string[] = [];
  if (!registry) return { section: { id: "providers", titleZh: "模型渠道", titleEn: "Model providers", items: [item("providers", "info", ["渠道", "Providers"], ["未检查", "Not checked"])] }, sensitive };
  let loaded = false;
  try { await registry.load(); loaded = true; }
  catch (error) {
    const zh = explainError(error, "zh-CN");
    const en = explainError(error, "en-US");
    items.push(item("provider-load", "failure", ["渠道配置", "Provider configuration"], [zh.cause, en.cause], [`${zh.nextStep} 诊断：xiu --provider-config-diagnostics（${zh.code}）`, `${en.nextStep} Diagnose: xiu --provider-config-diagnostics (${en.code})`]));
  }
  if (loaded) {
    const profiles = registry.list();
    const credentials = new Map(registry.credentialInfo().map((info) => [info.providerId, info]));
    const active = registry.activeId();
    for (const profile of profiles) {
      if (profile.apiKey) sensitive.push(profile.apiKey);
      const envValue = profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined;
      if (envValue) sensitive.push(envValue);
    }
    if (!profiles.length) {
      items.push(item("provider-count", "warning", ["渠道", "Providers"], ["还没有任何渠道。", "No provider is configured yet."], ["在终端运行 xiu 进入三步向导，或输入 /provider add。", "Run xiu in a terminal for the three-step wizard, or enter /provider add."]));
    } else {
      items.push(item("provider-count", "pass", ["渠道", "Providers"],
        [`${profiles.length} 个渠道，当前 ${active ? `${active} / ${registry.activeModel(active) ?? profiles.find((profile) => profile.id === active)?.model ?? "-"}` : "未选择"}`,
          `${profiles.length} provider(s); active ${active ? `${active} / ${registry.activeModel(active) ?? profiles.find((profile) => profile.id === active)?.model ?? "-"}` : "none"}`]));
      for (const profile of profiles) {
        const credential = credentials.get(profile.id);
        const source = credential?.source ?? "missing";
        const needsKey = HOSTED_KINDS.has(profile.kind) || (profile.kind === "openai-compatible" && Boolean(profile.apiKeyEnv));
        const sourceZh = source === "environment" ? `环境变量 ${profile.apiKeyEnv}` : source === "system" ? "系统凭据" : source === "legacy-file" ? "本机配置文件" : profile.apiKeyEnv ? `缺少环境变量 ${profile.apiKeyEnv}` : "无 Key";
        const sourceEn = source === "environment" ? `environment variable ${profile.apiKeyEnv}` : source === "system" ? "system credential store" : source === "legacy-file" ? "local configuration file" : profile.apiKeyEnv ? `missing environment variable ${profile.apiKeyEnv}` : "no key";
        let host = profile.baseURL ?? "";
        try { if (profile.baseURL) host = new URL(profile.baseURL).host; } catch { /* keep the raw value; it is validated elsewhere */ }
        const level: DoctorLevel = source === "missing" && needsKey ? "warning" : "pass";
        items.push(item(`provider-${profile.id}`, level, [profile.id, profile.id],
          [`${profile.kind} · ${profile.model}${host ? ` · ${host}` : ""} · Key：${sourceZh}${profile.proxy ? " · 专用代理" : ""}`,
            `${profile.kind} · ${profile.model}${host ? ` · ${host}` : ""} · key: ${sourceEn}${profile.proxy ? " · dedicated proxy" : ""}`],
          level === "warning" ? ["运行 /provider key 保存 Key，或设置对应环境变量后重启。", "Save a key with /provider key, or set the environment variable and restart."] : undefined));
      }
    }
  }
  try {
    const diagnostics = await registry.configurationDiagnostics();
    const level: DoctorLevel = diagnostics.state === "current" ? "pass" : diagnostics.state === "missing" ? "info" : diagnostics.state === "upgrade-required" ? "warning" : "failure";
    items.push(item("provider-storage", level, ["配置文件", "Configuration file"],
      [`${diagnostics.state} · 格式 ${diagnostics.sourceVersion ?? "无"}（支持 ${diagnostics.supportedVersion}）· ${diagnostics.backups.length} 个备份${diagnostics.issues.length ? ` · 问题：${diagnostics.issues.join(", ")}` : ""}`,
        `${diagnostics.state} · schema ${diagnostics.sourceVersion ?? "none"} (supported ${diagnostics.supportedVersion}) · ${diagnostics.backups.length} backup(s)${diagnostics.issues.length ? ` · issues: ${diagnostics.issues.join(", ")}` : ""}`],
      level === "failure" || level === "warning" ? ["查看 xiu --provider-config-diagnostics；恢复备份只在交互终端输入 RECOVER 后执行。", "See xiu --provider-config-diagnostics; a backup is restored only after typing RECOVER in an interactive terminal."] : undefined));
  } catch (error) {
    const zh = explainError(error, "zh-CN");
    const en = explainError(error, "en-US");
    items.push(item("provider-storage", "warning", ["配置文件", "Configuration file"], [`无法读取诊断：${zh.cause}`, `Diagnostics unavailable: ${en.cause}`]));
  }
  return { section: { id: "providers", titleZh: "模型渠道", titleEn: "Model providers", items }, sensitive };
}

async function webSearchSection(settings: XiuSettings, env: NodeJS.ProcessEnv, uvAvailable: () => Promise<string | undefined>): Promise<{ section: DoctorSection; sensitive: string[] }> {
  const items: DoctorItem[] = [];
  const sensitive: string[] = [];
  const web = settings.webSearch;
  if (!web?.enabled) {
    items.push(item("web-search", "info", ["联网搜索", "Web search"], ["未启用。", "Disabled."], ["输入 /web configure 可开启本机免 Key 搜索。", "Enter /web configure to enable keyless local search."]));
    return { section: { id: "web-search", titleZh: "联网搜索", titleEn: "Web search", items }, sensitive };
  }
  const backend = web.provider === "searxng" && web.managedAuth === "xiu-device" ? "Xiu managed search" : web.provider;
  items.push(item("web-search", "pass", ["联网搜索", "Web search"],
    [`已启用 · ${backend}${web.provider === "free-search" ? `（free-search-mcp ${FREE_SEARCH_VERSION}，回退 ${web.managedAuth === "xiu-device" ? "Xiu 托管搜索" : "无"}）` : ` · ${web.baseURL}`} · 超时 ${web.timeoutMs ?? 20_000}ms`,
      `enabled · ${backend}${web.provider === "free-search" ? ` (free-search-mcp ${FREE_SEARCH_VERSION}; fallback ${web.managedAuth === "xiu-device" ? "Xiu managed search" : "none"})` : ` · ${web.baseURL}`} · timeout ${web.timeoutMs ?? 20_000}ms`]));
  if (web.provider === "free-search") {
    const uv = await uvAvailable().catch(() => undefined);
    items.push(uv
      ? item("web-uv", "pass", ["uv", "uv"], [`已就绪：${uv}`, `ready: ${uv}`])
      : item("web-uv", "info", ["uv", "uv"], [`尚未准备；首次搜索会下载 uv ${UV_VERSION} 到 ~/.xiu/uv 并校验 SHA-256。`, `Not prepared yet; the first search downloads uv ${UV_VERSION} into ~/.xiu/uv and verifies its SHA-256.`], ["如果网络受限，可先运行 /web doctor 预下载并测试。", "On a restricted network, run /web doctor first to download and test it."]));
  }
  const keyEnv = web.apiKeyEnv ?? (web.provider === "tavily" ? "TAVILY_API_KEY" : web.provider === "brave" ? "BRAVE_SEARCH_API_KEY" : undefined);
  if (web.managedAuth === "xiu-device") {
    items.push(item("web-auth", "pass", ["认证", "Authentication"], ["自动设备注册与短期 Token；设备凭证只保存在本机。", "Automatic device enrollment with short-lived tokens; the device credential stays on this machine."]));
  } else if (keyEnv) {
    const value = env[keyEnv]?.trim();
    if (value) sensitive.push(value);
    items.push(value
      ? item("web-auth", "pass", ["认证", "Authentication"], [`环境变量 ${keyEnv} 可用`, `environment variable ${keyEnv} is set`])
      : item("web-auth", "warning", ["认证", "Authentication"], [`缺少环境变量 ${keyEnv}`, `missing environment variable ${keyEnv}`], ["设置后重启 Xiu，或用 /web configure 换成免 Key 搜索。", "Set it and restart Xiu, or switch to keyless search with /web configure."]));
  }
  if (web.proxy) {
    const proxy = describeProxyValue(web.proxy);
    items.push(item("web-proxy", proxy.invalid ? "warning" : "pass", ["搜索代理", "Search proxy"], [proxy.display, proxy.display]));
  }
  items.push(item("web-online", "info", ["在线测试", "Online test"], ["本报告不发起搜索；输入 /web doctor 做一次真实搜索与设备认证检查。", "This report performs no search; enter /web doctor for a live search and device-authentication check."]));
  return { section: { id: "web-search", titleZh: "联网搜索", titleEn: "Web search", items }, sensitive };
}

async function proxySection(env: NodeJS.ProcessEnv, settings: XiuSettings, profiles: ProviderProfile[], registryItem: UpdateDoctorItem | undefined): Promise<DoctorSection> {
  const items: DoctorItem[] = [];
  const hosts = new Map<string, string[]>();
  const record = (source: string, raw: string): void => {
    const proxy = describeProxyValue(raw);
    if (proxy.host) hosts.set(proxy.host, [...(hosts.get(proxy.host) ?? []), source]);
    items.push(item(`proxy-${source}`, proxy.invalid ? "warning" : proxy.hadCredentials ? "info" : "pass", [source, source],
      [proxy.display + (proxy.hadCredentials ? "（含账号密码，已隐藏）" : ""), proxy.display + (proxy.hadCredentials ? " (credentials hidden)" : "")]));
  };
  // Upper- and lower-case variants with the same value are one setting; show them once.
  const duplicate = (name: string): boolean => name !== name.toUpperCase() && env[name.toUpperCase()]?.trim() === env[name]?.trim();
  for (const name of PROXY_VARIABLES) if (env[name]?.trim() && !duplicate(name)) record(env[name.toUpperCase()]?.trim() === env[name]?.trim() && name === name.toUpperCase() && env[name.toLowerCase()]?.trim() === env[name]?.trim() ? `${name}/${name.toLowerCase()}` : name, env[name]!);
  if (settings.webSearch?.proxy) record("settings.webSearch.proxy", settings.webSearch.proxy);
  for (const profile of profiles) if (profile.proxy) record(`provider:${profile.id}`, profile.proxy);
  for (const name of NO_PROXY_VARIABLES) {
    if (!env[name]?.trim() || duplicate(name)) continue;
    const label = name === name.toUpperCase() && env[name.toLowerCase()]?.trim() === env[name]?.trim() ? `${name}/${name.toLowerCase()}` : name;
    items.push(item(`proxy-${name}`, "info", [label, label], [env[name]!.trim(), env[name]!.trim()]));
  }
  if (!items.length) items.push(item("proxy-none", "pass", ["代理", "Proxy"], ["未设置任何代理环境变量或渠道代理；所有请求直连。", "No proxy environment variable or provider proxy is set; all requests connect directly."]));
  if (hosts.size > 1) {
    items.push(item("proxy-mismatch", "warning", ["代理一致性", "Proxy consistency"],
      [`${hosts.size} 个不同的代理地址：${[...hosts].map(([host, sources]) => `${host}（${sources.join(", ")}）`).join("；")}`, `${hosts.size} different proxy hosts: ${[...hosts].map(([host, sources]) => `${host} (${sources.join(", ")})`).join("; ")}`],
      ["更新检查读 XIU_UPDATE_PROXY → npm_config_https_proxy → HTTPS_PROXY；联网搜索与 uv 下载读 XIU_WEB_PROXY 或设置里的代理，其次 HTTPS_PROXY；模型请求只用渠道自己配置的代理，不读环境变量。请确认每一类流量走的是预期出口。",
        "Update checks read XIU_UPDATE_PROXY → npm_config_https_proxy → HTTPS_PROXY; web search and the uv download read XIU_WEB_PROXY or the configured search proxy, then HTTPS_PROXY; model requests use only the proxy configured on the provider and ignore environment variables. Check that each kind of traffic leaves through the intended proxy."]));
  } else {
    items.push(item("proxy-routes", "info", ["代理用途", "Proxy routes"],
      ["更新检查：XIU_UPDATE_PROXY → npm_config_https_proxy → HTTPS_PROXY；联网搜索与 uv 下载：XIU_WEB_PROXY 或设置里的代理，其次 HTTPS_PROXY；模型请求：只用渠道配置的代理（/provider edit）。",
        "Update checks: XIU_UPDATE_PROXY → npm_config_https_proxy → HTTPS_PROXY; web search and uv download: XIU_WEB_PROXY or the configured search proxy, then HTTPS_PROXY; model requests: only the proxy configured on the provider (/provider edit)."]));
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    items.push(item("tls-disabled", "failure", ["证书校验", "Certificate verification"], ["NODE_TLS_REJECT_UNAUTHORIZED=0 关闭了所有 HTTPS 证书校验，这不安全，也不是 Xiu 设置的。", "NODE_TLS_REJECT_UNAUTHORIZED=0 disables every HTTPS certificate check; this is unsafe and was not set by Xiu."],
      ["删除这个环境变量，改用 NODE_EXTRA_CA_CERTS 指向企业根证书。", "Remove the variable and point NODE_EXTRA_CA_CERTS at the corporate root certificate instead."]));
  }
  if (env.NODE_EXTRA_CA_CERTS?.trim()) {
    const file = env.NODE_EXTRA_CA_CERTS.trim();
    const exists = await fs.access(file).then(() => true, () => false);
    items.push(exists
      ? item("extra-ca", "pass", ["额外根证书", "Extra CA certificates"], [`NODE_EXTRA_CA_CERTS=${file}`, `NODE_EXTRA_CA_CERTS=${file}`])
      : item("extra-ca", "warning", ["额外根证书", "Extra CA certificates"], [`NODE_EXTRA_CA_CERTS 指向的文件不存在：${file}`, `NODE_EXTRA_CA_CERTS points to a missing file: ${file}`]));
  }
  const registryText = `${registryItem?.summary ?? ""} ${registryItem?.detail ?? ""}`;
  if (registryItem && registryItem.level !== "pass") {
    if (TLS_PATTERN.test(registryText)) {
      items.push(item("tls-interception", "warning", ["证书拦截", "Certificate interception"],
        ["访问 npm Registry 时证书链不受信任，通常是公司网关替换了证书。Xiu 没有关闭校验。", "The certificate chain to the npm registry is not trusted, usually because a corporate gateway replaces certificates. Xiu did not disable verification."],
        ["把企业根证书导出为 PEM 并设置 NODE_EXTRA_CA_CERTS；Windows 上模型请求已信任系统证书库。", "Export the corporate root certificate as PEM and set NODE_EXTRA_CA_CERTS; on Windows, model requests already trust the system certificate store."]));
    } else if (/HTTP 403/.test(registryText)) {
      items.push(item("gateway-403", "warning", ["网关拦截", "Gateway block"],
        ["npm Registry 返回 HTTP 403，通常是企业网关或代理按域名拦截。", "The npm registry returned HTTP 403, usually a corporate gateway or proxy blocking the domain."],
        ["请 IT 放行 registry.npmjs.org，或配置允许的代理到 XIU_UPDATE_PROXY。", "Ask IT to allow registry.npmjs.org, or set an approved proxy in XIU_UPDATE_PROXY."]));
    }
  }
  return { id: "proxy", titleZh: "代理与证书", titleEn: "Proxy and certificates", items };
}

async function windowsSection(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, cwd: string, probe: () => Promise<PowerShellProbe>): Promise<DoctorSection | undefined> {
  if (platform !== "win32") return undefined;
  const items: DoctorItem[] = [];
  const result: PowerShellProbe = await probe().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if (result.error) {
    items.push(item("powershell", "info", ["PowerShell", "PowerShell"], [`无法读取语言模式：${result.error}`, `Could not read the language mode: ${result.error}`]));
  } else {
    const constrained = result.languageMode && result.languageMode !== "FullLanguage";
    items.push(item("powershell", constrained ? "warning" : "pass", ["PowerShell", "PowerShell"],
      [`语言模式 ${result.languageMode ?? "未知"} · 执行策略 ${result.executionPolicy ?? "未知"}`, `language mode ${result.languageMode ?? "unknown"} · execution policy ${result.executionPolicy ?? "unknown"}`],
      constrained
        ? ["受限语言模式下 npm.ps1 等脚本可能被拦截：安装或升级时用 npm.cmd；Xiu 自身自 0.20.11 起不再依赖 PowerShell 做权限检查。", "In a constrained language mode scripts such as npm.ps1 may be blocked: use npm.cmd to install or upgrade; since 0.20.11 Xiu itself no longer relies on PowerShell for permission checks."]
        : undefined));
  }
  const windowsDirectory = env.WINDIR ?? env.SystemRoot;
  if (windowsDirectory && cwd.toLowerCase() === path.join(windowsDirectory, "System32").toLowerCase()) {
    items.push(item("system32", "warning", ["工作目录", "Working directory"], ["当前目录是 Windows System32。", "The current directory is Windows System32."], ["请进入项目目录后再启动 Xiu。", "Start Xiu from your project directory instead."]));
  }
  if (env.ComSpec) items.push(item("comspec", "info", ["ComSpec", "ComSpec"], [env.ComSpec, env.ComSpec]));
  return { id: "windows", titleZh: "Windows", titleEn: "Windows", items };
}

function systemSection(options: Required<Pick<DoctorOptions, "version" | "platform" | "arch" | "nodeVersion" | "osRelease" | "cwd" | "homeDirectory">>, env: NodeJS.ProcessEnv): DoctorSection {
  let locale = "unknown";
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* keep unknown */ }
  const language = env.XIU_LANGUAGE?.trim();
  return {
    id: "system", titleZh: "系统", titleEn: "System", items: [
      item("xiu", "info", ["Xiu", "Xiu"], [options.version, options.version]),
      item("node", "info", ["Node.js", "Node.js"], [options.nodeVersion, options.nodeVersion]),
      item("os", "info", ["系统", "OS"], [`${options.platform} ${options.arch} · ${options.osRelease}`, `${options.platform} ${options.arch} · ${options.osRelease}`]),
      item("locale", "info", ["区域", "Locale"], [`${locale}${language ? ` · XIU_LANGUAGE=${language}` : ""}`, `${locale}${language ? ` · XIU_LANGUAGE=${language}` : ""}`]),
      item("home", "info", ["用户目录", "Home directory"], [path.join(options.homeDirectory, ".xiu"), path.join(options.homeDirectory, ".xiu")]),
      item("cwd", "info", ["工作目录", "Working directory"], [options.cwd, options.cwd]),
    ],
  };
}

function overallStatus(sections: DoctorSection[]): DoctorReport["status"] {
  const levels = sections.flatMap((section) => section.items.map((entry) => entry.level));
  if (levels.includes("failure")) return "failure";
  if (levels.includes("warning")) return "warning";
  return "pass";
}

function redactReport(report: DoctorReport, sensitive: readonly string[]): DoctorReport {
  const clean = (text: string | undefined): string | undefined => text === undefined ? undefined : redactSecrets(text, sensitive);
  return {
    ...report,
    sections: report.sections.map((section) => ({
      ...section,
      items: section.items.map((entry) => ({
        ...entry,
        summaryZh: clean(entry.summaryZh)!, summaryEn: clean(entry.summaryEn)!,
        ...(entry.detailZh !== undefined ? { detailZh: clean(entry.detailZh) } : {}),
        ...(entry.detailEn !== undefined ? { detailEn: clean(entry.detailEn) } : {}),
      })),
    })),
  };
}

export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const osRelease = options.osRelease ?? os.release();
  const cwd = options.cwd ?? process.cwd();
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const now = options.now ?? new Date();
  const updateDoctor = options.updateDoctor ?? (() => diagnoseUpdateInstallation(options.version, { cache: new UpdateCheckCache() }));
  const powerShell = options.powerShell ?? defaultPowerShellProbe;
  const uvAvailable = options.uvAvailable ?? (() => defaultUvAvailable(platform, env));

  let updateResult: UpdateDoctorResult | undefined;
  let updateFailure: unknown;
  const updatePromise = updateDoctor().then((result) => { updateResult = result; }, (error: unknown) => { updateFailure = error; });
  const providers = await providerSection(options.registry, env);
  const webSearch = await webSearchSection(options.settings, env, uvAvailable);
  await updatePromise;
  const profiles = options.registry ? safeList(options.registry) : [];
  const proxy = await proxySection(env, options.settings, profiles, updateResult?.items.find((entry) => entry.id === "registry"));
  const windows = await windowsSection(platform, env, cwd, powerShell);
  const workspace = await (options.workspaceRecords ?? (() => probeWorkspaceRecords(cwd)))();

  const sections: DoctorSection[] = [
    installationSection(updateResult, updateFailure, nodeVersion, options.settingsFile),
    providers.section,
    webSearch.section,
    proxy,
    ...(windows ? [windows] : []),
    workspaceSection(workspace),
    systemSection({ version: options.version, platform, arch, nodeVersion, osRelease, cwd, homeDirectory }, env),
  ];
  const sensitive = [
    ...(options.sensitive ?? []),
    ...providers.sensitive,
    ...webSearch.sensitive,
    ...KNOWN_KEY_VARIABLES.map((name) => env[name]?.trim()).filter((value): value is string => Boolean(value)),
  ].filter((value) => value.length >= 4);
  return redactReport({ version: options.version, generatedAt: now.toISOString(), status: overallStatus(sections), sections }, sensitive);
}

function safeList(registry: DoctorProviderRegistry): ProviderProfile[] {
  try { return registry.list(); }
  catch { return []; }
}

export function doctorHasHardFailure(report: DoctorReport): boolean {
  return report.status === "failure";
}

export function formatDoctorReport(report: DoctorReport, language: UiLanguage): string {
  const marks: Record<DoctorLevel, string> = { pass: "✓", warning: "!", failure: "✗", info: "·" };
  const status = report.status === "pass"
    ? localize(language, "通过", "passed")
    : report.status === "warning" ? localize(language, "可用，但有需要留意的警告", "usable, with warnings to review") : localize(language, "存在需要处理的错误", "has failures that need attention");
  const lines = [
    `${localize(language, "Xiu 诊断报告", "Xiu diagnostics report")} · ${report.version} · ${report.generatedAt}`,
    `${localize(language, "结论", "Result")}: ${status}`,
  ];
  for (const section of report.sections) {
    lines.push("", `[${localize(language, section.titleZh, section.titleEn)}]`);
    for (const entry of section.items) {
      lines.push(`${marks[entry.level]} ${localize(language, entry.labelZh, entry.labelEn)}: ${localize(language, entry.summaryZh, entry.summaryEn)}`);
      const detail = localize(language, entry.detailZh ?? "", entry.detailEn ?? "");
      if (detail) lines.push(`  ${detail}`);
    }
  }
  lines.push("", localize(language,
    "只读检查：没有修改配置、没有发送凭证；Key、Token 与代理密码已脱敏，可直接粘贴给维护者。在线测试请用 /provider test 与 /web doctor。",
    "Read-only checks: nothing was modified and no credential was sent; keys, tokens and proxy passwords are redacted, so the report can be pasted to a maintainer. Use /provider test and /web doctor for live tests."));
  return lines.join("\n");
}
