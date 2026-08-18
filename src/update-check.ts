import { fetch as undiciFetch, ProxyAgent } from "undici";
import { localize, type UiLanguage } from "./i18n.js";

export const XIU_NPM_PACKAGE = "@xiu-ai/cli";
export const XIU_NPM_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_URL = `${XIU_NPM_REGISTRY}/%40xiu-ai%2Fcli/latest`;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type UpdateStatus = "up-to-date" | "update-available" | "newer-than-registry";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  status: UpdateStatus;
  registry: string;
  checkedAt: string;
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
