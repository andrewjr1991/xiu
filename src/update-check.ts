import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { localize, type UiLanguage } from "./i18n.js";

export const XIU_NPM_PACKAGE = "@xiu-ai/cli";
export const XIU_NPM_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_URL = `${XIU_NPM_REGISTRY}/%40xiu-ai%2Fcli/latest`;
const MAX_RESPONSE_BYTES = 256 * 1024;
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const UPDATE_CACHE_SCHEMA_VERSION = 1;

export type UpdateStatus = "up-to-date" | "update-available" | "newer-than-registry";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  status: UpdateStatus;
  registry: string;
  checkedAt: string;
}

interface PersistedUpdateCache {
  schemaVersion: 1;
  latestVersion: string;
  registry: string;
  checkedAt: string;
}

export interface CachedUpdateCheck {
  result: UpdateCheckResult;
  fresh: boolean;
}

interface RegistryResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}

export interface UpdateCheckOptions {
  timeoutMs?: number;
  proxy?: string;
  now?: () => Date;
  fetcher?: (url: string, init: Record<string, unknown>) => Promise<RegistryResponse>;
}

export type UpdateDoctorLevel = "pass" | "warning" | "failure";

export type UpdateDoctorItemId = "runtime" | "package" | "command" | "prefix" | "proxy" | "cache" | "registry";

export interface UpdateDoctorItem {
  id: UpdateDoctorItemId;
  level: UpdateDoctorLevel;
  summary: string;
  summaryZh?: string;
  detail?: string;
  detailZh?: string;
}

export interface UpdateDoctorResult {
  status: UpdateDoctorLevel;
  items: UpdateDoctorItem[];
  update?: UpdateCheckResult;
}

export interface UpdateDoctorOptions {
  packageRoot?: string;
  runtimeVersion?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEntries?: string[];
  now?: Date;
  cache?: UpdateCheckCache;
  checker?: (proxy?: string) => Promise<UpdateCheckResult>;
}

export interface XiuCommandCandidate {
  launcher: string;
  packageRoot?: string;
  version?: string;
  issue?: string;
}

export interface XiuCommandResolution {
  candidates: XiuCommandCandidate[];
  installations: Array<{ packageRoot: string; version?: string }>;
  first?: XiuCommandCandidate;
  activePackageRoot: string;
  configuredPrefix?: string;
  expectedPrefixBin?: string;
  prefixBinOnPath?: boolean;
}

const REQUIRED_PACKAGE_FILES = ["package.json", "dist/cli.js", "README.md", "USAGE.zh-CN.md"] as const;
const MAX_PATH_DIRECTORIES = 128;
const MAX_LAUNCHER_BYTES = 64 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

interface ParsedVersion {
  core: [string, string, string];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion {
  if (value.trim().length > 128) throw new Error(`Invalid semantic version: ${value}`);
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return {
    core: [match[1], match[2], match[3]],
    prerelease,
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(a.core[index], b.core[index]);
    if (comparison !== 0) return comparison;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function validatedProxy(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Update proxy must use http:// or https://");
  }
  if (parsed.username || parsed.password) throw new Error("Update proxy URL must not contain credentials");
  return parsed.toString();
}

export function updateProxyFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return validatedProxy(environment.XIU_UPDATE_PROXY ?? environment.npm_config_https_proxy ?? environment.HTTPS_PROXY ?? environment.https_proxy);
}

export function updateProxySourceFromEnvironment(environment: NodeJS.ProcessEnv = process.env): { source?: string; proxy?: string } {
  const candidates: Array<[string, string | undefined]> = [
    ["XIU_UPDATE_PROXY", environment.XIU_UPDATE_PROXY],
    ["npm_config_https_proxy", environment.npm_config_https_proxy],
    ["HTTPS_PROXY", environment.HTTPS_PROXY],
    ["https_proxy", environment.https_proxy],
  ];
  const selected = candidates.find(([, value]) => Boolean(value?.trim()));
  if (!selected) return {};
  return { source: selected[0], proxy: validatedProxy(selected[1]) };
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function realpathOrResolved(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function readPackageIdentity(packageRoot: string): Promise<{ packageRoot: string; version?: string } | undefined> {
  const filename = path.join(packageRoot, "package.json");
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) return undefined;
    const document = JSON.parse(await fs.readFile(filename, "utf8")) as { name?: unknown; version?: unknown };
    if (document.name !== XIU_NPM_PACKAGE) return undefined;
    return {
      packageRoot: await realpathOrResolved(packageRoot),
      ...(typeof document.version === "string" ? { version: document.version } : {}),
    };
  } catch {
    return undefined;
  }
}

async function packageRootFromTarget(target: string): Promise<{ packageRoot: string; version?: string } | undefined> {
  let current = path.dirname(target);
  for (let depth = 0; depth < 12; depth += 1) {
    const identity = await readPackageIdentity(current);
    if (identity) return identity;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function inspectCommandCandidate(launcher: string, platform: NodeJS.Platform): Promise<XiuCommandCandidate> {
  try {
    const stat = await fs.lstat(launcher);
    if (!stat.isFile() && !stat.isSymbolicLink()) return { launcher, issue: "launcher is not a file" };
    const resolvedLauncher = await fs.realpath(launcher).catch(() => undefined);
    if (!resolvedLauncher) return { launcher, issue: "launcher target is missing or inaccessible" };

    let identity = resolvedLauncher !== path.resolve(launcher)
      ? await packageRootFromTarget(resolvedLauncher)
      : undefined;
    if (!identity && platform === "win32") {
      identity = await readPackageIdentity(path.join(path.dirname(launcher), "node_modules", "@xiu-ai", "cli"));
    }
    if (!identity && stat.isFile() && stat.size <= MAX_LAUNCHER_BYTES) {
      identity = await packageRootFromTarget(launcher);
    }
    return identity
      ? { launcher, packageRoot: identity.packageRoot, ...(identity.version ? { version: identity.version } : {}) }
      : { launcher, issue: `launcher does not resolve to ${XIU_NPM_PACKAGE}` };
  } catch (error) {
    return { launcher, issue: error instanceof Error ? error.message : String(error) };
  }
}

function pathEntriesFromEnvironment(environment: NodeJS.ProcessEnv): string[] {
  const value = environment.Path ?? environment.PATH ?? "";
  return value.split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

export async function inspectXiuCommandResolution(options: {
  packageRoot: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEntries?: string[];
}): Promise<XiuCommandResolution> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const rawEntries = options.pathEntries ?? pathEntriesFromEnvironment(environment);
  const entries: string[] = [];
  const seenEntries = new Set<string>();
  for (const entry of rawEntries.slice(0, MAX_PATH_DIRECTORIES)) {
    const normalized = normalizedPath(entry, platform);
    if (seenEntries.has(normalized)) continue;
    seenEntries.add(normalized);
    entries.push(path.resolve(entry));
  }

  const names = platform === "win32"
    ? ["xiu.ps1", "xiu.cmd", "xiu.exe", "xiu.bat", "xiu"]
    : ["xiu"];
  const candidates: XiuCommandCandidate[] = [];
  for (const directory of entries) {
    for (const name of names) {
      const launcher = path.join(directory, name);
      try {
        await fs.lstat(launcher);
      } catch {
        continue;
      }
      candidates.push(await inspectCommandCandidate(launcher, platform));
    }
  }

  const installations: Array<{ packageRoot: string; version?: string }> = [];
  const seenInstallations = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.packageRoot) continue;
    const key = normalizedPath(candidate.packageRoot, platform);
    if (seenInstallations.has(key)) continue;
    seenInstallations.add(key);
    installations.push({ packageRoot: candidate.packageRoot, ...(candidate.version ? { version: candidate.version } : {}) });
  }

  const configuredPrefix = environment.npm_config_prefix?.trim() || environment.NPM_CONFIG_PREFIX?.trim() || undefined;
  const expectedPrefixBin = configuredPrefix
    ? path.resolve(platform === "win32" ? configuredPrefix : path.join(configuredPrefix, "bin"))
    : undefined;
  return {
    candidates,
    installations,
    first: candidates[0],
    activePackageRoot: await realpathOrResolved(options.packageRoot),
    ...(configuredPrefix ? { configuredPrefix } : {}),
    ...(expectedPrefixBin ? {
      expectedPrefixBin,
      prefixBinOnPath: entries.some((entry) => normalizedPath(entry, platform) === normalizedPath(expectedPrefixBin, platform)),
    } : {}),
  };
}

function commandResolutionDoctorItems(resolution: XiuCommandResolution, currentVersion: string, platform: NodeJS.Platform): UpdateDoctorItem[] {
  const first = resolution.first;
  const activeKey = normalizedPath(resolution.activePackageRoot, platform);
  const distinctVersions = resolution.installations.map((item) => item.version ?? "unknown").join(", ");
  let command: UpdateDoctorItem;
  if (!first) {
    command = {
      id: "command",
      level: "warning",
      summary: "xiu launcher was not found on PATH",
      summaryZh: "PATH 中未找到 xiu 启动器",
      detail: "The current process is usable, but a new terminal may not resolve the xiu command. Add the npm global bin directory to PATH.",
      detailZh: "当前进程仍可用，但新终端可能无法解析 xiu 命令；请将 npm 全局 bin 目录加入 PATH。",
    };
  } else if (first.issue || !first.packageRoot) {
    command = {
      id: "command",
      level: "warning",
      summary: `first PATH launcher is stale or unrecognized: ${first.launcher}`,
      summaryZh: `PATH 首个启动器已损坏或无法识别：${first.launcher}`,
      detail: first.issue,
      detailZh: `${first.issue ?? "无法解析安装目录"}；请移除旧 shim，或重新安装 ${XIU_NPM_PACKAGE}。`,
    };
  } else if (normalizedPath(first.packageRoot, platform) !== activeKey || (first.version && first.version !== currentVersion)) {
    command = {
      id: "command",
      level: "warning",
      summary: `PATH resolves ${first.version ?? "unknown"} from ${first.launcher}`,
      summaryZh: `PATH 当前解析到 ${first.version ?? "未知版本"}：${first.launcher}`,
      detail: `Running package: ${resolution.activePackageRoot} (${currentVersion})`,
      detailZh: `当前运行包：${resolution.activePackageRoot}（${currentVersion}）；请调整 PATH 顺序或清理旧的全局安装。`,
    };
  } else if (resolution.installations.length > 1) {
    command = {
      id: "command",
      level: "warning",
      summary: `${resolution.installations.length} distinct Xiu installations on PATH (${distinctVersions})`,
      summaryZh: `PATH 中存在 ${resolution.installations.length} 个不同的 Xiu 安装（${distinctVersions}）`,
      detail: resolution.installations.map((item) => `${item.version ?? "unknown"}: ${item.packageRoot}`).join("\n  "),
      detailZh: `${resolution.installations.map((item) => `${item.version ?? "未知版本"}：${item.packageRoot}`).join("\n  ")}\n  建议保留当前安装并清理旧安装；本诊断不会自动修改。`,
    };
  } else {
    command = {
      id: "command",
      level: "pass",
      summary: `${first.launcher} -> ${first.packageRoot} (${first.version ?? currentVersion})`,
      summaryZh: `${first.launcher} → ${first.packageRoot}（${first.version ?? currentVersion}）`,
    };
  }

  let prefix: UpdateDoctorItem;
  if (!resolution.configuredPrefix || !resolution.expectedPrefixBin) {
    prefix = {
      id: "prefix",
      level: "pass",
      summary: "npm prefix is not explicitly configured; PATH result used",
      summaryZh: "未显式配置 npm prefix；已以 PATH 解析结果为准",
    };
  } else if (!resolution.prefixBinOnPath) {
    prefix = {
      id: "prefix",
      level: "warning",
      summary: `npm prefix bin is not on PATH: ${resolution.expectedPrefixBin}`,
      summaryZh: `npm prefix 对应目录不在 PATH：${resolution.expectedPrefixBin}`,
      detail: `Configured prefix: ${resolution.configuredPrefix}`,
      detailZh: `已配置 prefix：${resolution.configuredPrefix}；请将对应目录加入 PATH，或修正 npm prefix。`,
    };
  } else {
    prefix = {
      id: "prefix",
      level: "pass",
      summary: `${resolution.configuredPrefix} (${resolution.expectedPrefixBin} is on PATH)`,
      summaryZh: `${resolution.configuredPrefix}（${resolution.expectedPrefixBin} 已在 PATH）`,
    };
  }
  return [command, prefix];
}

function doctorStatus(items: UpdateDoctorItem[]): UpdateDoctorLevel {
  if (items.some((item) => item.level === "failure")) return "failure";
  if (items.some((item) => item.level === "warning")) return "warning";
  return "pass";
}

export async function diagnoseUpdateInstallation(currentVersion: string, options: UpdateDoctorOptions = {}): Promise<UpdateDoctorResult> {
  const items: UpdateDoctorItem[] = [];
  const runtimeVersion = options.runtimeVersion ?? process.versions.node;
  const runtimeMajor = Number.parseInt(runtimeVersion.split(".")[0] ?? "", 10);
  items.push(Number.isInteger(runtimeMajor) && runtimeMajor >= 20
    ? { id: "runtime", level: "pass", summary: `Node.js ${runtimeVersion}` }
    : { id: "runtime", level: "failure", summary: `Node.js ${runtimeVersion}`, detail: "Xiu requires Node.js 20 or newer", detailZh: "Xiu 需要 Node.js 20 或更高版本" });

  const packageRoot = options.packageRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const missing: string[] = [];
  for (const filename of REQUIRED_PACKAGE_FILES) {
    try {
      const stat = await fs.stat(path.join(packageRoot, filename));
      if (!stat.isFile()) missing.push(filename);
    } catch {
      missing.push(filename);
    }
  }
  items.push(missing.length === 0
    ? { id: "package", level: "pass", summary: `${REQUIRED_PACKAGE_FILES.length} required package files present`, summaryZh: `${REQUIRED_PACKAGE_FILES.length} 个必需包文件均存在` }
    : { id: "package", level: "failure", summary: `${missing.length} required package file(s) missing`, summaryZh: `缺少 ${missing.length} 个必需包文件`, detail: missing.join(", ") });

  const platform = options.platform ?? process.platform;
  const commandResolution = await inspectXiuCommandResolution({
    packageRoot,
    environment: options.environment,
    platform,
    pathEntries: options.pathEntries,
  });
  items.push(...commandResolutionDoctorItems(commandResolution, currentVersion, platform));

  let proxy: string | undefined;
  try {
    const selected = updateProxySourceFromEnvironment(options.environment ?? process.env);
    proxy = selected.proxy;
    items.push(selected.source
      ? { id: "proxy", level: "pass", summary: `${selected.source}: ${selected.proxy}` }
      : { id: "proxy", level: "pass", summary: "direct connection", summaryZh: "直连" });
  } catch (error) {
    items.push({ id: "proxy", level: "failure", summary: "invalid update proxy", summaryZh: "更新代理无效", detail: error instanceof Error ? error.message : String(error), detailZh: "代理地址无效或包含凭证；请检查更新代理配置" });
  }

  const now = options.now ?? new Date();
  const cache = options.cache ?? new UpdateCheckCache();
  const cached = await cache.load(currentVersion, now);
  items.push(!cached
    ? { id: "cache", level: "warning", summary: "no valid update cache", summaryZh: "没有有效的更新缓存" }
    : cached.fresh
      ? { id: "cache", level: "pass", summary: `fresh cache: ${cached.result.latestVersion}`, summaryZh: `缓存新鲜：${cached.result.latestVersion}`, detail: cached.result.checkedAt }
      : { id: "cache", level: "warning", summary: `stale cache: ${cached.result.latestVersion}`, summaryZh: `缓存已过期：${cached.result.latestVersion}`, detail: cached.result.checkedAt });

  let update: UpdateCheckResult | undefined;
  if (items.some((item) => item.id === "proxy" && item.level === "failure")) {
    items.push({ id: "registry", level: "warning", summary: "registry check skipped", summaryZh: "已跳过 Registry 检查", detail: "Fix the update proxy configuration first", detailZh: "请先修复更新代理配置" });
  } else {
    try {
      update = await (options.checker?.(proxy) ?? checkForUpdates(currentVersion, { proxy, now: () => now }));
      const statusZh: Record<UpdateStatus, string> = {
        "update-available": "有可用更新",
        "up-to-date": "已是最新版本",
        "newer-than-registry": "本地版本高于 Registry",
      };
      items.push({
        id: "registry",
        level: "pass",
        summary: `${XIU_NPM_REGISTRY}: ${update.latestVersion}`,
        detail: update.status,
        detailZh: statusZh[update.status],
      });
    } catch (error) {
      items.push({ id: "registry", level: "warning", summary: "official npm registry unavailable", summaryZh: "官方 npm Registry 暂不可用", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return { status: doctorStatus(items), items, ...(update ? { update } : {}) };
}

export function updateDoctorHasHardFailure(result: UpdateDoctorResult): boolean {
  return result.status === "failure";
}

export function formatUpdateDoctor(result: UpdateDoctorResult, language: UiLanguage): string {
  const labels: Record<UpdateDoctorItemId, [string, string]> = {
    runtime: ["运行环境", "Runtime"],
    package: ["包完整性", "Package integrity"],
    command: ["命令来源", "Command resolution"],
    prefix: ["npm prefix", "npm prefix"],
    proxy: ["更新代理", "Update proxy"],
    cache: ["更新缓存", "Update cache"],
    registry: ["官方 Registry", "Official registry"],
  };
  const marks: Record<UpdateDoctorLevel, string> = { pass: "✓", warning: "!", failure: "✗" };
  const status = result.status === "pass"
    ? localize(language, "通过", "passed")
    : result.status === "warning"
      ? localize(language, "可用，但有外部警告", "usable with external warnings")
      : localize(language, "本地安装存在硬错误", "local installation has hard failures");
  const lines = [localize(language, "Xiu 更新诊断", "Xiu update diagnostics"), `${localize(language, "结论", "Result")}: ${status}`];
  for (const item of result.items) {
    const summary = language === "zh-CN" ? item.summaryZh ?? item.summary : item.summary;
    const detail = language === "zh-CN" ? item.detailZh ?? item.detail : item.detail;
    lines.push(`${marks[item.level]} ${localize(language, labels[item.id][0], labels[item.id][1])}: ${summary}`);
    if (detail) lines.push(`  ${detail}`);
  }
  lines.push("", localize(language, "只执行只读检查；未运行 npm，未安装、修复或修改全局配置。", "Read-only checks only; npm was not run and no installation, repair, or global configuration change was performed."));
  return lines.join("\n");
}

async function readBoundedBody(response: RegistryResponse, controller: AbortController): Promise<string> {
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("npm registry response is too large");
    return body;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      controller.abort();
      throw new Error("npm registry response is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function checkForUpdates(currentVersion: string, options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  parseVersion(currentVersion);
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new Error("Update check timeout must be between 500 and 60000ms");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const proxy = validatedProxy(options.proxy);
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const fetcher = options.fetcher ?? ((url, init) => undiciFetch(url, init) as Promise<RegistryResponse>);
  try {
    const response = await fetcher(REGISTRY_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": `xiu/${currentVersion}` },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("npm registry response is too large");
    const body = await readBoundedBody(response, controller);
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { throw new Error("npm registry returned invalid JSON"); }
    const latestVersion = typeof payload === "object" && payload !== null && typeof (payload as { version?: unknown }).version === "string"
      ? (payload as { version: string }).version.trim()
      : "";
    parseVersion(latestVersion);
    const comparison = compareVersions(currentVersion, latestVersion);
    return {
      currentVersion,
      latestVersion,
      status: comparison < 0 ? "update-available" : comparison > 0 ? "newer-than-registry" : "up-to-date",
      registry: XIU_NPM_REGISTRY,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof Error && error.message === "npm registry response is too large")) {
      throw new Error(`npm registry request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (dispatcher) {
      try { await dispatcher.close(); }
      catch { /* Closing a best-effort update-check dispatcher must not mask the actual result. */ }
    }
  }
}

function resultFromLatest(currentVersion: string, latestVersion: string, checkedAt: string): UpdateCheckResult {
  parseVersion(currentVersion);
  parseVersion(latestVersion);
  const comparison = compareVersions(currentVersion, latestVersion);
  return {
    currentVersion,
    latestVersion,
    status: comparison < 0 ? "update-available" : comparison > 0 ? "newer-than-registry" : "up-to-date",
    registry: XIU_NPM_REGISTRY,
    checkedAt,
  };
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  }
}

export class UpdateCheckCache {
  constructor(private readonly filename = path.join(os.homedir(), ".xiu", "update-cache.json")) {}

  async load(currentVersion: string, now = new Date()): Promise<CachedUpdateCheck | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.filename, "utf8")) as Partial<PersistedUpdateCache>;
      if (value.schemaVersion !== UPDATE_CACHE_SCHEMA_VERSION || value.registry !== XIU_NPM_REGISTRY) return undefined;
      if (typeof value.latestVersion !== "string" || typeof value.checkedAt !== "string") return undefined;
      const checkedAtMs = Date.parse(value.checkedAt);
      if (!Number.isFinite(checkedAtMs) || checkedAtMs > now.getTime() + 5 * 60_000) return undefined;
      const result = resultFromLatest(currentVersion, value.latestVersion, new Date(checkedAtMs).toISOString());
      return { result, fresh: now.getTime() - checkedAtMs <= UPDATE_CACHE_TTL_MS };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      return undefined;
    }
  }

  async save(result: UpdateCheckResult): Promise<void> {
    if (result.registry !== XIU_NPM_REGISTRY) throw new Error("Update cache accepts only the official npm registry");
    parseVersion(result.latestVersion);
    const checkedAtMs = Date.parse(result.checkedAt);
    if (!Number.isFinite(checkedAtMs)) throw new Error("Update cache requires a valid check time");
    const document: PersistedUpdateCache = {
      schemaVersion: UPDATE_CACHE_SCHEMA_VERSION,
      latestVersion: result.latestVersion,
      registry: XIU_NPM_REGISTRY,
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await replaceFile(temporary, this.filename);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function formatUpdateReminder(result: UpdateCheckResult, language: UiLanguage, platform: NodeJS.Platform = process.platform): string {
  return language === "zh-CN"
    ? `Xiu 有新版本：${result.currentVersion} → ${result.latestVersion}\n升级命令（仅显示，未执行）：${upgradeCommand(platform)}\n可用 /update status 查看提醒状态。`
    : `A new Xiu version is available: ${result.currentVersion} -> ${result.latestVersion}\nUpgrade command (displayed only; not executed): ${upgradeCommand(platform)}\nUse /update status to inspect reminder status.`;
}

export function formatUpdateNotificationStatus(enabled: boolean, cached: CachedUpdateCheck | undefined, language: UiLanguage): string {
  const cacheStatus = !cached
    ? localize(language, "无缓存", "no cache")
    : `${cached.result.latestVersion} · ${cached.fresh ? localize(language, "有效", "fresh") : localize(language, "已过期", "stale")} · ${cached.result.checkedAt}`;
  return language === "zh-CN"
    ? ["Xiu 更新提醒", `状态：${enabled ? "已启用" : "已关闭（默认）"}`, "检查间隔：24 小时缓存", `缓存：${cacheStatus}`, "行为：仅在安全输入边界提示；不会自动安装、降级或修改全局 npm。"].join("\n")
    : ["Xiu update reminders", `Status: ${enabled ? "enabled" : "disabled (default)"}`, "Check interval: 24-hour cache", `Cache: ${cacheStatus}`, "Behavior: reminders appear only at safe input boundaries; Xiu never installs, downgrades, or changes global npm automatically."].join("\n");
}

export function upgradeCommand(platform: NodeJS.Platform = process.platform): string {
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  return `${npm} install --global '${XIU_NPM_PACKAGE}@latest' --registry='${XIU_NPM_REGISTRY}/'`;
}

export function formatUpdateCheckError(error: unknown, language: UiLanguage): string {
  const message = error instanceof Error ? error.message : String(error);
  if (language !== "zh-CN") return message;
  if (message.startsWith("npm registry returned HTTP ")) return message.replace("npm registry returned HTTP ", "npm Registry 返回 HTTP ");
  if (message === "npm registry response is too large") return "npm Registry 响应超过 256 KiB 安全上限";
  if (message === "npm registry returned invalid JSON") return "npm Registry 返回了无效 JSON";
  if (message.startsWith("Invalid semantic version: ")) return message.replace("Invalid semantic version: ", "无效的语义版本：");
  if (message.startsWith("npm registry request timed out after ")) {
    return message.replace("npm registry request timed out after ", "npm Registry 请求超时（").replace(/ms$/, " 毫秒）");
  }
  if (message === "Update proxy must use http:// or https://") return "更新检查代理必须使用 http:// 或 https://";
  if (message === "Update proxy URL must not contain credentials") return "更新检查代理地址不能包含用户名或密码";
  if (message === "Update check timeout must be between 500 and 60000ms") return "更新检查超时必须介于 500 至 60000 毫秒之间";
  return message;
}

export function formatUpdateCheck(result: UpdateCheckResult, language: UiLanguage, platform: NodeJS.Platform = process.platform): string {
  const status = result.status === "update-available"
    ? localize(language, "发现新版本", "update available")
    : result.status === "newer-than-registry"
      ? localize(language, "本地版本高于 npm latest（可能是开发版）", "local version is newer than npm latest (possibly a development build)")
      : localize(language, "已是最新版本", "up to date");
  return [
    localize(language, "Xiu 版本检查", "Xiu update check"),
    `${localize(language, "已安装", "Installed")}: ${result.currentVersion}`,
    `npm latest: ${result.latestVersion}`,
    `${localize(language, "状态", "Status")}: ${status}`,
    `${localize(language, "检查源", "Registry")}: ${result.registry}`,
    ...(result.status === "update-available" ? [
      "",
      localize(language, "升级命令（仅显示，尚未执行）：", "Upgrade command (displayed only; not executed):"),
      `  ${upgradeCommand(platform)}`,
      `${localize(language, "升级后验证", "Verify after upgrading")}: xiu --version`,
    ] : []),
  ].join("\n");
}
