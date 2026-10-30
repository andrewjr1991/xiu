import { spawnSync } from "node:child_process";
import path from "node:path";

export type ProviderProxyMode = "direct" | "system" | "custom";

export interface SystemProxySnapshot {
  enabled: boolean;
  server?: string;
  override?: string;
}

function normalizedProxyUrl(value: string | undefined, scheme = "http"): string | undefined {
  const source = value?.trim();
  if (!source) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `${scheme}://${source}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch { return undefined; }
}

export function parseProxyServer(value: string | undefined, targetProtocol: "http:" | "https:"): string | undefined {
  const source = value?.trim();
  if (!source) return undefined;
  if (!source.includes("=") && !source.includes(";")) return normalizedProxyUrl(source);
  const entries = new Map(source.split(";").map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? ["", entry.trim()] : [entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()];
  }));
  const key = targetProtocol === "https:" ? "https" : "http";
  const selected = entries.get(key) ?? entries.get("http") ?? entries.get("");
  return normalizedProxyUrl(selected, key === "https" && entries.has("https") ? "http" : "http");
}

function bypassesProxy(hostname: string, override: string | undefined): boolean {
  const host = hostname.toLowerCase();
  return (override ?? "").split(";").map((item) => item.trim().toLowerCase()).filter(Boolean).some((item) => {
    const pattern = item.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
    if (pattern === "<local>") return !host.includes(".");
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
    if (pattern.startsWith(".")) return host === pattern.slice(1) || host.endsWith(pattern);
    return host === pattern;
  });
}

export function resolveProxySnapshot(snapshot: SystemProxySnapshot, targetUrl: string): string | undefined {
  if (!snapshot.enabled || !snapshot.server) return undefined;
  let target: URL;
  try { target = new URL(targetUrl); } catch { return undefined; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (bypassesProxy(target.hostname, snapshot.override)) return undefined;
  return parseProxyServer(snapshot.server, target.protocol);
}

function environmentProxy(target: URL, environment: NodeJS.ProcessEnv): string | undefined | null {
  const noProxy = environment.NO_PROXY ?? environment.no_proxy;
  if (noProxy && bypassesProxy(target.hostname, noProxy.replaceAll(",", ";"))) return null;
  const value = target.protocol === "https:"
    ? environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy ?? environment.ALL_PROXY ?? environment.all_proxy
    : environment.HTTP_PROXY ?? environment.http_proxy ?? environment.ALL_PROXY ?? environment.all_proxy;
  return normalizedProxyUrl(value);
}

export function parseWindowsInternetSettings(output: string): SystemProxySnapshot {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*?)\s*$/i);
    if (match) values.set(match[1]!.toLowerCase(), match[2]!);
  }
  const enabledValue = values.get("proxyenable") ?? "0";
  const enabled = enabledValue === "1" || /^0x0*1$/i.test(enabledValue);
  return { enabled, server: values.get("proxyserver"), override: values.get("proxyoverride") };
}

function windowsSystemProxy(targetUrl: string): string | undefined {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "reg.exe");
  const result = spawnSync(executable, ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
    encoding: "utf8", windowsHide: true, timeout: 2_000,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return resolveProxySnapshot(parseWindowsInternetSettings(result.stdout), targetUrl);
}

/** Resolve a Provider's "system proxy" without changing global process networking. */
export function resolveSystemProxy(targetUrl: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  let target: URL;
  try { target = new URL(targetUrl); } catch { return undefined; }
  const fromEnvironment = environmentProxy(target, environment);
  if (fromEnvironment === null) return undefined;
  if (fromEnvironment) return fromEnvironment;
  return process.platform === "win32" ? windowsSystemProxy(targetUrl) : undefined;
}
