import { ConfigFileError, type ConfigFileKind } from "./config-file-error.js";
import type { UiLanguage } from "./i18n.js";
import { ProviderConfigurationError } from "./provider-config-migration.js";
import { classifyRetryError } from "./retry-policy.js";
import { redactSecrets } from "./secret-redaction.js";

/**
 * One explanation of a failure for the person at the keyboard: what went
 * wrong in plain words, what to do next, and which read-only command shows
 * more. Raw messages stay available as bounded, redacted detail for
 * diagnostics; they are never the headline.
 */
export interface ErrorExplanation {
  /** Stable code for the documentation table and diagnostics, e.g. `provider-config/unsafe`, `http/401`. */
  code: string;
  cause: string;
  nextStep: string;
  diagnostic?: string;
  /** Redacted original message, at most 300 characters. Absent when the cause already is the message. */
  detail?: string;
}

interface Entry { code: string; zh: [cause: string, nextStep: string]; en: [cause: string, nextStep: string]; diagnostic?: string }

const PROVIDER_DIAGNOSTIC = "xiu --provider-config-diagnostics";

const PROVIDER_CONFIG: Record<string, Entry> = {
  unsafe: { code: "provider-config/unsafe", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["渠道配置文件或它所在的目录不是普通文件，可能被替换成链接、被其他程序占用，或所在目录不可写。", "关闭其他 Xiu 窗口后重试；仍失败请运行诊断命令，并把输出发给维护者。"],
    en: ["The provider configuration file or its directory is not a plain, writable file: it may be a link, locked by another program, or in a read-only location.", "Close other Xiu windows and retry; if it still fails, run the diagnostic command and share its output."] },
  changed: { code: "provider-config/changed", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["另一个 Xiu 窗口或桌面端刚修改了渠道配置，本次改动没有保存。", "重新打开渠道设置（CLI 为 /providers）核对最新配置后再操作。"],
    en: ["Another Xiu window or the desktop app changed the provider settings first, so this change was not saved.", "Reopen the provider settings (/providers in the CLI), check the current values, then retry."] },
  busy: { code: "provider-config/busy", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["渠道配置正在被另一个 Xiu 进程写入，或上次写入中断后留下了锁。", "关闭其他 Xiu 窗口后重试；如果没有其他窗口，运行诊断命令按提示处理中断的写入。"],
    en: ["Another Xiu process is writing the provider settings, or an interrupted write left a lock behind.", "Close other Xiu windows and retry; with none open, run the diagnostic command and follow its recovery steps."] },
  "size-limit": { code: "provider-config/size-limit", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["渠道配置文件超过 4 MiB 的安全上限，没有写入。", "检查是否有程序往 ~/.xiu/providers.json 里写了额外内容。"],
    en: ["The provider configuration exceeds the 4 MiB safety limit and was not written.", "Check whether another program appended data to ~/.xiu/providers.json."] },
  backup: { code: "provider-config/backup", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["要恢复的配置备份缺失、损坏或无法校验，配置没有改动。", "运行诊断命令查看可用备份，再选择一个完好的备份恢复。"],
    en: ["The configuration backup to restore is missing, corrupt, or cannot be verified; nothing was changed.", "Run the diagnostic command to list usable backups and pick an intact one."] },
  unsupported: { code: "provider-config/unsupported", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["渠道配置是更新版本的 Xiu 写入的格式，这个版本读不懂，配置没有改动。", "把 CLI 和桌面端升级到同一版本后再试。"],
    en: ["The provider settings were written by a newer Xiu in a format this version cannot read; nothing was changed.", "Upgrade the CLI and the desktop app to the same version, then retry."] },
  invalid: { code: "provider-config/invalid", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["渠道配置文件内容无效，Xiu 没有改动它。", "运行诊断命令查看问题；需要时从备份恢复。"],
    en: ["The provider configuration file is invalid; Xiu left it unchanged.", "Run the diagnostic command to see the problem and restore a backup if needed."] },
  confirmation: { code: "provider-config/confirmation", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["恢复操作需要先预览，再在有效期内明确确认。", "重新运行恢复预览，然后按提示确认。"],
    en: ["Recovery needs a fresh preview followed by an explicit confirmation.", "Run the recovery preview again and confirm when prompted."] },
  restart: { code: "provider-config/restart",
    zh: ["渠道配置刚从备份恢复，这个 Xiu 进程还在用旧状态。", "退出并重新打开 Xiu。"],
    en: ["The provider settings were just restored from a backup and this Xiu process still holds the old state.", "Quit and reopen Xiu."] },
  reload: { code: "provider-config/reload", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["上一次保存渠道配置失败，或配置在别处被修改，Xiu 没有自动重试。", "重新打开渠道设置（CLI 为 /providers）读取最新配置后再改。"],
    en: ["The previous provider settings write failed or the settings changed elsewhere; Xiu did not retry automatically.", "Reopen the provider settings (/providers in the CLI) to reload the current values, then make the change again."] },
  "write-unverified": { code: "provider-config/write-unverified", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["渠道配置写入后没能回读确认，文件可能已更新也可能没有。", "运行诊断命令确认当前内容后再决定是否重做。"],
    en: ["The provider settings write could not be read back, so the file may or may not have changed.", "Run the diagnostic command to confirm the current contents before redoing the change."] },
  io: { code: "provider-config/io", diagnostic: PROVIDER_DIAGNOSTIC,
    zh: ["读写渠道配置文件时出错，已有备份保留。", "检查 ~/.xiu 是否可写、是否被安全软件拦截，然后运行诊断命令。"],
    en: ["Reading or writing the provider configuration failed; existing backups were kept.", "Check that ~/.xiu is writable and not blocked by security software, then run the diagnostic command."] },
};

/** Xiu's own configuration files; the owners fail closed and `xiu doctor` names every file's state. */
const CONFIG: Record<ConfigFileKind, Entry> = {
  settings: { code: "config/settings", diagnostic: "xiu doctor",
    zh: ["Xiu 的设置文件（~/.xiu/settings.json）无法读取或不是有效的 JSON，Xiu 不会悄悄改用默认值。", "修好它的 JSON，或把这个文件移走后重新启动；它只保存语言与联网搜索设置。"],
    en: ["Xiu's settings file (~/.xiu/settings.json) cannot be read or is not valid JSON; Xiu does not fall back to the defaults silently.", "Fix its JSON or move the file away, then start Xiu again; it only holds the language and web-search settings."] },
  "trust-store": { code: "config/trust-store", diagnostic: "xiu doctor",
    zh: ["信任名单（~/.xiu/trusted-workspaces.json）无法读取，Xiu 无法判断任何工作区是否受信任，所以没有继续。", "修好它的 JSON，或把这个文件移走；移走后每个工作区会重新询问一次是否信任。"],
    en: ["The trust list (~/.xiu/trusted-workspaces.json) cannot be read, so Xiu cannot tell whether any workspace is trusted and did not continue.", "Fix its JSON or move the file away; afterwards each workspace asks for trust once more."] },
  "extension-permissions": { code: "config/extension-permissions", diagnostic: "xiu doctor",
    zh: ["扩展授权记录（~/.xiu/extension-permissions.json）无法读取，插件、Skill 与 MCP 都无法确认是否已获授权。", "修好它的 JSON，或把这个文件移走；移走后已授权的插件、Skill 和 MCP 需要重新授权一次。"],
    en: ["The extension permission record (~/.xiu/extension-permissions.json) cannot be read, so no plugin, skill or MCP server can be confirmed as approved.", "Fix its JSON or move the file away; afterwards every approved plugin, skill and MCP server needs one new approval."] },
  mcp: { code: "config/mcp", diagnostic: "xiu doctor",
    zh: ["MCP 配置文件无法读取，或其中某个服务条目无效，这次没有连接任何 MCP 服务；其他功能照常可用。", "按详情里的说明修正 ~/.xiu/mcp.json 或工作区的 .xiu/mcp.json，然后执行 /mcp reload 或重新启动。"],
    en: ["An MCP configuration file cannot be read or one of its server entries is invalid, so no MCP server was connected this time; everything else works as usual.", "Fix ~/.xiu/mcp.json or the workspace's .xiu/mcp.json as the detail says, then run /mcp reload or start Xiu again."] },
};

const GENERAL: Record<string, Entry> = {
  "credential/missing": { code: "credential/missing",
    zh: ["这个渠道还没有可用的 API Key。", "在渠道设置里保存 Key（CLI 为 /provider key），或先设置渠道对应的环境变量。"],
    en: ["This provider has no usable API key yet.", "Save one in the provider settings (/provider key in the CLI), or set the provider's environment variable before starting Xiu."] },
  "http/401": { code: "http/401",
    zh: ["服务拒绝了这个 API Key：Key 错误、已过期，或不属于这个地址。", "核对 Key 和 Base URL 是否来自同一个服务商，然后重新保存 Key（CLI 为 /provider key）。"],
    en: ["The service rejected the API key: it is wrong, expired, or belongs to a different endpoint.", "Check that the key and base URL come from the same vendor, then save the key again (/provider key in the CLI)."] },
  "http/403": { code: "http/403",
    zh: ["服务拒绝访问：账号没有这个模型的权限，或企业网关/代理拦截了请求。", "在服务商控制台确认模型权限；公司网络请检查网关规则或用 --proxy 指定允许的代理。"],
    en: ["Access was denied: the account lacks permission for this model, or a corporate gateway or proxy blocked the request.", "Confirm model access in the vendor console; on a company network check the gateway rules or pass an allowed proxy with --proxy."] },
  "http/404": { code: "http/404",
    zh: ["地址或模型名不对：服务上没有这个接口或模型。", "检查 Base URL 是否以 /v1 等正确路径结尾，再刷新模型列表（CLI 为 /models）选择一个存在的模型。"],
    en: ["Wrong address or model name: the service has no such endpoint or model.", "Check that the base URL ends with the right path (often /v1), then refresh the model list (/models in the CLI) and pick a model that exists."] },
  "http/400": { code: "http/400",
    zh: ["服务不接受这次请求的参数，常见原因是模型名拼错或模型不支持工具调用。", "从刷新后的模型列表（CLI 为 /models）里选择服务返回的模型名；如果仍失败，换一个支持工具调用的模型。"],
    en: ["The service rejected the request parameters; usually the model name is misspelled or the model does not support tool calls.", "Pick a model name from the refreshed model list (/models in the CLI); if it still fails, choose a model that supports tool calling."] },
  "http/409": { code: "http/409",
    zh: ["服务报告请求与当前状态冲突。", "稍后重试；持续出现请查看 /diagnostics。"],
    en: ["The service reported a conflict with its current state.", "Retry shortly; if it persists, check /diagnostics."] },
  "http/429": { code: "http/429",
    zh: ["请求过于频繁或额度用完，服务暂时限流。", "等一会再试，或在服务商控制台检查余额与速率限制。"],
    en: ["Too many requests or the quota is exhausted; the service is rate-limiting.", "Wait a moment and retry, or check balance and rate limits in the vendor console."] },
  "http/5xx": { code: "http/5xx",
    zh: ["服务端出错，不是本机配置问题。", "稍后重试；持续出现请查看服务商状态页。"],
    en: ["The service itself failed; this is not a local configuration problem.", "Retry later; if it persists, check the vendor's status page."] },
  "network/dns": { code: "network/dns",
    zh: ["找不到这个服务器地址：域名拼写错误，或本机 DNS/代理无法解析它。", "核对 Base URL 的域名；公司网络请用 --proxy 或 /web proxy set 指定代理。"],
    en: ["The server address could not be found: the hostname is misspelled, or local DNS or the proxy cannot resolve it.", "Check the hostname in the base URL; on a company network pass the proxy with --proxy or /web proxy set."] },
  "network/refused": { code: "network/refused",
    zh: ["连接被拒绝：目标服务没有在这个地址和端口上运行。", "本地模型请先启动 Ollama、LM Studio 或 vLLM，并核对端口。"],
    en: ["The connection was refused: nothing is listening at that address and port.", "For local models start Ollama, LM Studio or vLLM first and check the port."] },
  "network/tls": { code: "network/tls",
    zh: ["HTTPS 证书不受信任，通常是公司网关替换了证书。Xiu 没有关闭证书校验。", "把企业根证书加入系统信任或 NODE_EXTRA_CA_CERTS，或改用允许的代理。"],
    en: ["The HTTPS certificate is not trusted, usually because a corporate gateway replaces certificates. Xiu did not disable verification.", "Add the enterprise root certificate to the system trust store or NODE_EXTRA_CA_CERTS, or use an allowed proxy."] },
  "network/proxy-auth": { code: "network/proxy-auth",
    zh: ["代理服务器要求认证（HTTP 407）。", "在代理地址中带上账号密码，或换用不需要认证的代理。"],
    en: ["The proxy server requires authentication (HTTP 407).", "Include credentials in the proxy URL or use a proxy that needs none."] },
  "network/timeout": { code: "network/timeout",
    zh: ["连接或响应超时，服务没有在限定时间内回应。", "检查网络和代理设置后重试；本地模型可能还在加载。"],
    en: ["The connection or response timed out.", "Check network and proxy settings and retry; a local model may still be loading."] },
  "network/unreachable": { code: "network/unreachable",
    zh: ["无法建立网络连接。", "检查网络、防火墙和代理设置后重试。"],
    en: ["A network connection could not be established.", "Check network, firewall and proxy settings, then retry."] },
  "background/node-missing": { code: "background/node-missing",
    zh: ["后台任务需要本机安装的 Node.js，但没有找到。", "安装 Node.js 22 或更高版本后重试。"],
    en: ["Background jobs need a local Node.js installation, which was not found.", "Install Node.js 22 or later and retry."] },
  "background/stop-unconfirmed": { code: "background/stop-unconfirmed", diagnostic: "/background list",
    zh: ["后台任务的进程没能在限定时间内确认退出，任务仍标记为运行中。", "用 /background list 查看进程号，必要时在任务管理器或 ps 中手动结束。"],
    en: ["The background job's processes did not confirm exit within the time budget, so it is still marked as running.", "Check the PID with /background list and end it manually in Task Manager or with ps/kill if needed."] },
  "background/pid-reused": { code: "background/pid-reused", diagnostic: "/background list",
    zh: ["后台任务的进程早已退出，记录的进程号现在属于其他程序，Xiu 没有结束它们；任务已标记为中断。", "用 /background list 确认状态；不需要手动处理。"],
    en: ["The background job's processes had already exited; the recorded process numbers now belong to unrelated programs, which were left alone. The job is recorded as interrupted.", "Check the state with /background list; nothing needs to be done by hand."] },
  cancelled: { code: "cancelled",
    zh: ["操作已取消。", "需要时重新运行。"],
    en: ["The operation was cancelled.", "Run it again when ready."] },
};

/** Every explanation code with its Chinese cause, for the documentation table and its consistency test. */
export function errorCatalog(): Array<{ code: string; cause: string; nextStep: string; diagnostic?: string }> {
  return [...Object.values(PROVIDER_CONFIG), ...Object.values(CONFIG), ...Object.values(GENERAL)].map((entry) => ({ code: entry.code, cause: entry.zh[0], nextStep: entry.zh[1], diagnostic: entry.diagnostic }));
}

interface ErrorShape { message?: string; code?: unknown; status?: unknown; cause?: unknown }
function chain(error: unknown): ErrorShape[] {
  const items: ErrorShape[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    items.push(current as ErrorShape);
    current = (current as ErrorShape).cause;
  }
  return items;
}

function entryFor(error: unknown): Entry | undefined {
  if (error instanceof ProviderConfigurationError) return PROVIDER_CONFIG[error.code] ?? PROVIDER_CONFIG.io;
  const items = chain(error);
  const configFile = items.find((item): item is ConfigFileError => item instanceof ConfigFileError);
  if (configFile) return CONFIG[configFile.kind];
  const message = items.map((item) => item.message ?? "").join(" ");
  const codes = items.map((item) => String(item.code ?? "")).join(" ").toUpperCase();
  const status = items.map((item) => Number(item.status)).find((value) => Number.isInteger(value));
  if (/XIU_NODE_NOT_FOUND/.test(message)) return GENERAL["background/node-missing"];
  if (/XIU_BACKGROUND_STOP_UNCONFIRMED/.test(message)) return GENERAL["background/stop-unconfirmed"];
  if (/XIU_BACKGROUND_PID_REUSED/.test(message)) return GENERAL["background/pid-reused"];
  if (/ is not set$|missing api key|no api key/i.test(message)) return GENERAL["credential/missing"];
  if (status === 407 || /proxy authentication required/i.test(message)) return GENERAL["network/proxy-auth"];
  if (/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID/.test(`${codes} ${message}`)) return GENERAL["network/tls"];
  switch (classifyRetryError(error)) {
    case "cancelled": return GENERAL.cancelled;
    case "authentication": return GENERAL["http/401"];
    case "authorization": return GENERAL["http/403"];
    case "not-found": return GENERAL["http/404"];
    case "invalid-request": return GENERAL["http/400"];
    case "conflict": return GENERAL["http/409"];
    case "rate-limit": return GENERAL["http/429"];
    case "server": return GENERAL["http/5xx"];
    case "timeout": return GENERAL["network/timeout"];
    case "transport":
      if (/ENOTFOUND|EAI_AGAIN/.test(codes)) return GENERAL["network/dns"];
      if (/ECONNREFUSED/.test(codes)) return GENERAL["network/refused"];
      return GENERAL["network/unreachable"];
    default: return undefined;
  }
}

export interface ExplainOptions {
  /** Values that must never appear in output, such as the profile's API key. */
  sensitive?: readonly string[];
  /** A read-only command to suggest when the catalog has none. */
  diagnostic?: string;
}

export function explainError(error: unknown, language: UiLanguage, options: ExplainOptions = {}): ErrorExplanation {
  const raw = redactSecrets(error instanceof Error ? error.message : String(error), options.sensitive ?? []).replace(/\s+/g, " ").trim().slice(0, 300);
  const entry = entryFor(error);
  if (!entry) {
    return {
      code: "unknown",
      cause: raw || (language === "zh-CN" ? "发生了未知错误。" : "An unknown error occurred."),
      nextStep: language === "zh-CN" ? "重试一次；仍失败请运行 /diagnostics 查看详细记录。" : "Retry once; if it still fails, run /diagnostics for the detailed record.",
      diagnostic: options.diagnostic,
    };
  }
  const [cause, nextStep] = language === "zh-CN" ? entry.zh : entry.en;
  return { code: entry.code, cause, nextStep, diagnostic: entry.diagnostic ?? options.diagnostic, detail: raw || undefined };
}

/**
 * Three to four short lines: `<heading>: cause`, the next step, the diagnostic
 * command when there is one, and the redacted detail with its code.
 */
export function formatUserFacingError(heading: string, error: unknown, language: UiLanguage, options: ExplainOptions = {}): string {
  const explanation = explainError(error, language, options);
  const zh = language === "zh-CN";
  const lines = [`${heading}${zh ? "：" : ": "}${explanation.cause}`, `${zh ? "下一步：" : "Next step: "}${explanation.nextStep}`];
  if (explanation.diagnostic) lines.push(`${zh ? "诊断：" : "Diagnose: "}${explanation.diagnostic}`);
  if (explanation.detail && explanation.detail !== explanation.cause) lines.push(`${zh ? "详情：" : "Detail: "}${explanation.code} · ${explanation.detail}`);
  return lines.join("\n");
}

/**
 * The four-line explanation when the catalog knows the cause, otherwise `<heading>: <redacted message>` on one line.
 * For command families whose failures are mostly input validation ("Plugin not found: x"), a generic next step would
 * be noise; only a catalogued cause (a damaged configuration file, a network or HTTP failure) earns the next step and
 * the diagnostic command.
 */
export function describeFailure(heading: string, error: unknown, language: UiLanguage, options: ExplainOptions = {}): string {
  if (explainError(error, language, options).code !== "unknown") return formatUserFacingError(heading, error, language, options);
  const message = redactSecrets(error instanceof Error ? error.message : String(error), options.sensitive ?? []);
  return `${heading}${language === "zh-CN" ? "：" : ": "}${message}`;
}

/** One sentence for compact surfaces such as the desktop renderer: cause plus next step. */
export function summarizeUserFacingError(error: unknown, language: UiLanguage, options: ExplainOptions = {}): string {
  const explanation = explainError(error, language, options);
  const separator = language === "zh-CN" ? "" : " ";
  return `${explanation.cause}${separator}${explanation.nextStep}`;
}
