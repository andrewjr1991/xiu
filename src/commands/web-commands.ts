import chalk from "chalk";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import type { ManagedWebSearchAuth } from "../managed-web-search-auth.js";
import type { SecurityAuditOutcome } from "../security-audit.js";
import type { SettingsStore, XiuSettings } from "../settings.js";
import { askQuestion } from "../terminal-prompts.js";
import type { WebSearchConfig, WebSearchProvider } from "../web-search.js";

export interface WebCommandContext {
  auditCredential: (action: string, subject: string | undefined, outcome: SecurityAuditOutcome) => Promise<void>;
  language: UiLanguage;
  /** Read at call time: cli.ts replaces the instance whenever the web search settings change. */
  managedWebSearchAuth: () => ManagedWebSearchAuth | undefined;
  refreshWebSearchRuntime: () => void;
  settings: XiuSettings;
  settingsStore: SettingsStore;
}

function webSearchSummary(settings: XiuSettings, language: UiLanguage): string {
  const web = settings.webSearch;
  if (!web?.enabled) return localize(language,
    "原生联网搜索：未启用。使用 /web configure 配置 Tavily、Brave Search 或 SearXNG。",
    "Native web search: disabled. Use /web configure to set up Tavily, Brave Search, or SearXNG.");
  const defaultKeyEnv = web.provider === "tavily" ? "TAVILY_API_KEY" : web.provider === "brave" ? "BRAVE_SEARCH_API_KEY" : undefined;
  const credentialEnv = web.apiKeyEnv ?? defaultKeyEnv;
  const credential = web.managedAuth === "xiu-device"
    ? localize(language, "自动设备注册与短期 Token", "automatic device enrollment and short-lived tokens")
    : credentialEnv
    ? process.env[credentialEnv]
      ? localize(language, "API Key 环境变量可用", "API key environment variable is available")
      : localize(language, `缺少环境变量 ${credentialEnv}`, `missing environment variable ${credentialEnv}`)
    : localize(language, "无需 API Key", "no API key required");
  const policy = [
    web.allowedDomains?.length ? `${localize(language, "允许域名", "allowlisted domains")}: ${web.allowedDomains.join(", ")}` : localize(language, "允许所有公网域名", "all public domains allowed"),
    web.blockedDomains?.length ? `${localize(language, "阻止域名", "blocked domains")}: ${web.blockedDomains.join(", ")}` : undefined,
  ].filter(Boolean).join(" · ");
  return [
    localize(language, `原生联网搜索：已启用 · ${web.provider}`, `Native web search: enabled · ${web.provider}`),
    `${localize(language, "端点", "Endpoint")}: ${web.baseURL}`,
    `${localize(language, "认证", "Authentication")}: ${credential}`,
    `${localize(language, "联网代理", "Web proxy")}: ${web.proxy ? localize(language, "已配置", "configured") : localize(language, "直连", "direct")}`,
    `${localize(language, "超时", "Timeout")}: ${web.timeoutMs ?? 20_000}ms`,
    `${localize(language, "策略", "Policy")}: ${policy}`,
    localize(language, "工具：web_search、web_open（只读；外部内容始终按不可信数据处理）", "Tools: web_search, web_open (read-only; external content is always untrusted)"),
  ].join("\n");
}

async function managedSearchCredentialSummary(settings: XiuSettings, language: UiLanguage, managedWebSearchAuth: ManagedWebSearchAuth | undefined): Promise<string> {
  if (!settings.webSearch?.enabled || settings.webSearch.managedAuth !== "xiu-device" || !managedWebSearchAuth) {
    return localize(language, "托管搜索凭证：不适用。", "Managed search credential: not applicable.");
  }
  const state = await managedWebSearchAuth.credentialStatus();
  const storage = state.storage === "system" ? localize(language, "Windows 凭证管理器", "Windows Credential Manager")
    : state.storage === "compatibility-file" ? localize(language, "本机兼容文件", "local compatibility file")
      : state.storage === "system-unavailable" ? localize(language, "系统凭证后端不可用", "system credential backend unavailable")
        : localize(language, "尚未注册（首次搜索时自动注册）", "not registered yet (automatic on first search)");
  return [
    `${localize(language, "托管搜索凭证", "Managed search credential")}: ${state.present ? localize(language, "可用", "available") : localize(language, "未就绪", "not ready")}`,
    `${localize(language, "存储", "Storage")}: ${storage}`,
    `${localize(language, "内存短期 Token", "In-memory short-lived token")}: ${state.tokenCached ? localize(language, "可用", "available") : localize(language, "无（按需签发）", "none (issued on demand)")}`,
  ].join("\n");
}

export async function printWebSearchStatus(ctx: Pick<WebCommandContext, "language" | "managedWebSearchAuth" | "settings">): Promise<void> {
  const { language, settings } = ctx;
  console.log(`${webSearchSummary(settings, language)}\n${await managedSearchCredentialSummary(settings, language, ctx.managedWebSearchAuth())}\n`);
}

/** Handles the /web commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleWebCommand(task: string, ctx: WebCommandContext): Promise<boolean> {
  if (task !== "/web" && !task.startsWith("/web ")) return false;
  const { auditCredential, language, refreshWebSearchRuntime, settings, settingsStore } = ctx;
  const managedWebSearchAuth = ctx.managedWebSearchAuth();

  const normalizedWebProxy = (raw: string): string => {
    let parsed: URL;
    try { parsed = new URL(raw.trim()); }
    catch { throw new Error(localize(language, "联网代理必须是有效的 HTTP(S) URL，例如 http://127.0.0.1:12334。", "Web proxy must be a valid HTTP(S) URL, for example http://127.0.0.1:12334.")); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(localize(language, "联网代理仅支持 http:// 或 https://。", "Web proxy must use http:// or https://."));
    }
    return parsed.toString();
  };

  const printWebProxyStatus = (): void => {
    const proxy = settings.webSearch?.proxy;
    const environmentProxy = process.env.XIU_WEB_PROXY?.trim();
    console.log(proxy
      ? `${localize(language, "联网工具独立代理", "Independent web tools proxy")}: ${proxy}\n${localize(language, "仅用于 web_search、web_open 和托管搜索认证；不会修改模型 Provider 代理。", "Used only by web_search, web_open, and managed search authentication; the model provider proxy is unchanged.")}\n`
      : `${localize(language, "联网工具独立代理：直连。", "Independent web tools proxy: direct.")}\n`);
    if (environmentProxy) console.log(chalk.dim(`${localize(language, "当前进程还检测到 XIU_WEB_PROXY；清除已保存配置后，下次启动仍可能从该环境变量恢复代理。", "XIU_WEB_PROXY is also present in this process; after clearing the saved setting, the proxy may return from that environment variable on the next launch.")}\n`));
  };

  const setWebProxy = async (command: string): Promise<void> => {
    if (!settings.webSearch) throw new Error(localize(language, "联网工具尚未配置。请先使用 /web configure。", "Web tools are not configured. Use /web configure first."));
    const argument = command.slice("/web proxy set".length).trim();
    const input = argument || (await askQuestion(localize(language,
      "联网工具代理地址（例如 http://127.0.0.1:12334）：",
      "Web tools proxy URL (for example http://127.0.0.1:12334): "))).trim();
    if (!input) { console.log(chalk.dim(localize(language, "已取消联网代理设置。\n", "Web proxy setup cancelled.\n"))); return; }
    settings.webSearch.proxy = normalizedWebProxy(input);
    await settingsStore.save(settings);
    refreshWebSearchRuntime();
    console.log(chalk.green(localize(language,
      `联网工具独立代理已保存并立即生效：${settings.webSearch.proxy}\n模型 Provider 代理未改变。\n`,
      `The independent web tools proxy was saved and applied immediately: ${settings.webSearch.proxy}\nThe model provider proxy was not changed.\n`)));
  };

  const clearWebProxy = async (): Promise<void> => {
    if (!settings.webSearch) throw new Error(localize(language, "联网工具尚未配置。", "Web tools are not configured."));
    const hadProxy = Boolean(settings.webSearch.proxy);
    delete settings.webSearch.proxy;
    await settingsStore.save(settings);
    refreshWebSearchRuntime();
    console.log(chalk.green(localize(language,
      hadProxy ? "已清除联网工具保存的代理；当前会话改为直连。\n" : "联网工具没有已保存的代理，当前保持直连。\n",
      hadProxy ? "The saved web tools proxy was cleared; this session now connects directly.\n" : "No saved web tools proxy was present; this session remains direct.\n")));
    if (process.env.XIU_WEB_PROXY?.trim()) console.log(chalk.yellow(localize(language,
      "注意：父终端仍设置了 XIU_WEB_PROXY，下次启动会再次读取它；如需永久直连，还要从终端或系统环境变量中删除该变量。\n",
      "Note: the parent terminal still defines XIU_WEB_PROXY, so it will be loaded again on the next launch. Remove that environment variable from the terminal or system settings for permanent direct access.\n")));
  };

  const diagnoseWebSearch = async (): Promise<void> => {
    if (!settings.webSearch?.enabled) throw new Error(localize(language, "联网搜索未启用。", "Web search is disabled."));
    if (settings.webSearch.managedAuth !== "xiu-device" || !managedWebSearchAuth) {
      const keyEnv = settings.webSearch.apiKeyEnv ?? (settings.webSearch.provider === "tavily" ? "TAVILY_API_KEY" : settings.webSearch.provider === "brave" ? "BRAVE_SEARCH_API_KEY" : undefined);
      if (keyEnv && !process.env[keyEnv]?.trim()) throw new Error(localize(language, `缺少环境变量 ${keyEnv}。`, `Missing environment variable ${keyEnv}.`));
      console.log(chalk.green(localize(language, "✓ 本地配置检查通过。当前后端不使用 Xiu 托管设备认证；实际搜索连接将在调用 web_search 时验证。\n", "✓ Local configuration check passed. This backend does not use Xiu managed device authentication; the search connection is verified when web_search runs.\n")));
      return;
    }
    console.log(chalk.cyan(localize(language, "正在检查 Xiu Search 健康状态并验证设备认证；没有凭证时会自动注册本设备……", "Checking Xiu Search health and device authentication; this device will be enrolled automatically if no credential exists...")));
    const result = await managedWebSearchAuth.diagnose();
    console.log(chalk.green(localize(language,
      `✓ 服务健康 · 设备认证通过 · ${result.elapsedMs}ms\n${await managedSearchCredentialSummary(settings, language, managedWebSearchAuth)}\n`,
      `✓ Service healthy · device authentication passed · ${result.elapsedMs}ms\n${await managedSearchCredentialSummary(settings, language, managedWebSearchAuth)}\n`)));
  };

  const resetManagedWebSearch = async (): Promise<void> => {
    if (settings.webSearch?.managedAuth !== "xiu-device" || !managedWebSearchAuth) throw new Error(localize(language, "当前配置未使用 Xiu 托管搜索设备凭证。", "The current configuration does not use a Xiu managed search device credential."));
    const confirmed = await selectTerminalOption(localize(language, "重置本机托管搜索凭证？", "Reset this installation's managed search credential?"), [
      { label: localize(language, "取消", "Cancel"), description: localize(language, "保留现有设备凭证", "Keep the existing device credential"), value: false },
      { label: localize(language, "确认重置", "Confirm reset"), description: localize(language, "删除本机凭证；下一次搜索将注册新设备", "Delete the local credential; the next search will enroll a new device"), value: true },
    ], language);
    if (!confirmed) { console.log(chalk.dim(localize(language, "已取消托管搜索凭证重置。\n", "Managed search credential reset cancelled.\n"))); return; }
    const before = await managedWebSearchAuth.resetCredential();
    await auditCredential("web-search-reset", "managed-search-device", "allowed");
    console.log(chalk.green(localize(language,
      `已清除本机托管搜索凭证${before.present ? "" : "（此前没有可用凭证）"}。下一次搜索或 /web doctor 将自动注册新设备。\n`,
      `The local managed search credential was cleared${before.present ? "" : " (no usable credential was present)"}. The next search or /web doctor will enroll a new device.\n`)));
  };

  const printManagedWebSearchDevices = async (): Promise<void> => {
    if (settings.webSearch?.managedAuth !== "xiu-device" || !managedWebSearchAuth) throw new Error(localize(language, "当前配置未使用 Xiu 托管搜索设备凭证。", "The current configuration does not use a Xiu managed search device credential."));
    const result = await managedWebSearchAuth.listDevices();
    await auditCredential("web-search-devices", result.currentDeviceId ?? "managed-search-device", "allowed");
    const deviceStatus = (status: string): string => ({
      active: localize(language, "有效", "active"),
      revoked: localize(language, "已撤销", "revoked"),
    })[status] ?? status;
    const auditAction = (action: string): string => ({
      registered: localize(language, "已登记", "registered"),
      revoked: localize(language, "已撤销", "revoked"),
      restored: localize(language, "已恢复", "restored"),
    })[action] ?? action;
    const deviceLines = result.devices.map((device) => {
      const id = device.id.length > 12 ? `…${device.id.slice(-8)}` : device.id;
      return `- ${id} · ${deviceStatus(device.status)}${device.createdAt ? ` · ${localize(language, "创建", "created")} ${device.createdAt}` : ""}${device.lastSeenAt ? ` · ${localize(language, "最近使用", "last seen")} ${device.lastSeenAt}` : ""}${device.revokedAt ? ` · ${localize(language, "撤销", "revoked")} ${device.revokedAt}` : ""}`;
    });
    const requestLabel = localize(language, "请求", "request");
    const auditLines = result.audit.map((event) => `- ${auditAction(event.action)} · ${event.deviceId.length > 12 ? `…${event.deviceId.slice(-8)}` : event.deviceId}${event.occurredAt ? ` · ${event.occurredAt}` : ""}${event.requestId ? ` · ${requestLabel} ${event.requestId}` : ""}`);
    console.log(`${localize(language, "服务端设备（只读）", "Server devices (read-only)")}${result.requestId ? ` · ${requestLabel} ${result.requestId}` : ""}\n${deviceLines.length ? deviceLines.join("\n") : localize(language, "- 无设备记录", "- No device records")}\n${localize(language, "撤销审计", "Revocation audit")}\n${auditLines.length ? auditLines.join("\n") : localize(language, "- 无审计记录", "- No audit records")}\n`);
  };

  const parseDomainSetting = (value: string): string[] | undefined => {
    const domains = [...new Set(value.split(/[\s,]+/).map((item) => item.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean))];
    if (domains.some((domain) => domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain))) {
      throw new Error(localize(language, "域名策略中包含无效域名。", "The domain policy contains an invalid domain."));
    }
    return domains.length ? domains : undefined;
  };

  const configureWebSearch = async (command: string): Promise<void> => {
    const requested = command.slice("/web configure".length).trim().toLowerCase();
    let provider: WebSearchProvider | undefined;
    if (requested) {
      if (requested !== "tavily" && requested !== "brave" && requested !== "searxng") throw new Error(localize(language, "Web Search 后端仅支持 tavily、brave 或 searxng。", "Web Search provider must be tavily, brave, or searxng."));
      provider = requested;
    } else {
      provider = await selectTerminalOption(localize(language, "选择只读搜索后端", "Choose a read-only search provider"), [
        { label: "Tavily", description: localize(language, "面向 AI 的 HTTPS API，免费额度无需信用卡", "AI-oriented HTTPS API; free allowance without a credit card"), value: "tavily" as const },
        { label: "Brave Search", description: localize(language, "官方 HTTPS API，需要 API Key 环境变量", "Official HTTPS API; requires an API key environment variable"), value: "brave" as const },
        { label: "SearXNG", description: localize(language, "使用你自建或信任的 HTTPS 实例，可选 Bearer Token", "Use a self-hosted or trusted HTTPS instance; optional Bearer token"), value: "searxng" as const },
      ], language);
    }
    if (!provider) { console.log(chalk.dim(localize(language, "已取消联网搜索配置。\n", "Web search configuration cancelled.\n"))); return; }
    const previous = settings.webSearch?.provider === provider ? settings.webSearch : undefined;
    const defaultEndpoint = provider === "tavily" ? "https://api.tavily.com/search"
      : provider === "brave" ? "https://api.search.brave.com/res/v1/web/search"
        : previous?.baseURL ?? "";
    const endpointInput = (await askQuestion(localize(language,
      `HTTPS 端点${defaultEndpoint ? `（回车使用 ${defaultEndpoint}）` : "（例如 https://search.example.com）"}：`,
      `HTTPS endpoint${defaultEndpoint ? ` (Enter for ${defaultEndpoint})` : " (for example https://search.example.com)"}: `))).trim();
    const baseURL = endpointInput || defaultEndpoint;
    let parsed: URL;
    try { parsed = new URL(baseURL); } catch { throw new Error(localize(language, "端点必须是有效的绝对 HTTPS URL。", "Endpoint must be a valid absolute HTTPS URL.")); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(localize(language, "端点必须使用 HTTPS 且不能包含凭证。", "Endpoint must use HTTPS and must not contain credentials."));
    let apiKeyEnv: string | undefined;
    if (provider === "tavily" || provider === "brave") {
      const fallbackKeyEnv = provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_SEARCH_API_KEY";
      apiKeyEnv = (await askQuestion(localize(language,
        `API Key 环境变量名（回车使用 ${previous?.apiKeyEnv ?? fallbackKeyEnv}）：`,
        `API key environment variable (Enter for ${previous?.apiKeyEnv ?? fallbackKeyEnv}): `))).trim() || previous?.apiKeyEnv || fallbackKeyEnv;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error(localize(language, "API Key 环境变量名无效。", "Invalid API key environment variable name."));
    } else {
      apiKeyEnv = (await askQuestion(localize(language,
        "可选 Bearer Token 环境变量名（公开或 IP 白名单实例请留空）：",
        "Optional Bearer token environment variable (blank for public or IP-allowlisted instances): "))).trim() || undefined;
      if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error(localize(language, "Token 环境变量名无效。", "Invalid token environment variable name."));
    }
    const allowedDomains = parseDomainSetting((await askQuestion(localize(language,
      "允许域名（空格或逗号分隔；留空允许所有公网域名）：",
      "Allowed domains (space/comma separated; blank allows all public domains): "))).trim());
    const blockedDomains = parseDomainSetting((await askQuestion(localize(language,
      "阻止域名（空格或逗号分隔；可留空）：",
      "Blocked domains (space/comma separated; optional): "))).trim());
    const timeoutInput = (await askQuestion(localize(language, "超时毫秒（回车使用 20000）：", "Timeout in milliseconds (Enter for 20000): "))).trim();
    const timeoutMs = timeoutInput ? Number(timeoutInput) : 20_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error(localize(language, "超时必须是 1000 到 60000 之间的整数。", "Timeout must be an integer from 1000 to 60000."));
    const proxyInput = (await askQuestion(localize(language,
      "联网搜索代理（可留空，与模型 Provider 代理独立）：",
      "Web search proxy (optional and independent from the model provider proxy): "))).trim();
    let webProxy: string | undefined;
    if (proxyInput) {
      try {
        const parsedProxy = new URL(proxyInput);
        if (parsedProxy.protocol !== "http:" && parsedProxy.protocol !== "https:") throw new Error();
        webProxy = parsedProxy.toString();
      } catch { throw new Error(localize(language, "联网搜索代理必须是有效的 HTTP(S) URL。", "Web search proxy must be a valid HTTP(S) URL.")); }
    }
    const web: WebSearchConfig = { enabled: true, provider, baseURL: parsed.toString(), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(allowedDomains ? { allowedDomains } : {}), ...(blockedDomains ? { blockedDomains } : {}), timeoutMs, ...(webProxy ? { proxy: webProxy } : {}) };
    settings.webSearch = web;
    await settingsStore.save(settings);
    refreshWebSearchRuntime();
    console.log(`${chalk.green(localize(language, "原生只读联网搜索已启用。", "Native read-only web search enabled."))}\n${webSearchSummary(settings, language)}\n`);
  };

  if (task === "/web" || task === "/web status") {
    try { await printWebSearchStatus(ctx); }
    catch (error) { console.error(chalk.red(`${localize(language, "读取联网搜索状态失败", "Could not read web search status")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  if (task === "/web doctor") {
    try { await diagnoseWebSearch(); }
    catch (error) { console.error(chalk.red(`${localize(language, "联网搜索诊断失败", "Web search diagnostics failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  if (task === "/web devices") {
    try { await printManagedWebSearchDevices(); }
    catch (error) { await auditCredential("web-search-devices", "managed-search-device", "failed"); console.error(chalk.red(`${localize(language, "读取服务端设备状态失败", "Could not read server-side device status")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  if (task === "/web reset") {
    try { await resetManagedWebSearch(); }
    catch (error) { console.error(chalk.red(`${localize(language, "托管搜索凭证重置失败", "Managed search credential reset failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  if (task === "/web proxy") {
    printWebProxyStatus();
    return true;
  }
  if (task === "/web proxy set" || task.startsWith("/web proxy set ")) {
    try { await setWebProxy(task); }
    catch (error) { console.error(chalk.red(`${localize(language, "联网代理设置失败", "Web proxy setup failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  if (task === "/web proxy clear") {
    try { await clearWebProxy(); }
    catch (error) { console.error(chalk.red(`${localize(language, "联网代理清除失败", "Could not clear the web proxy")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  if (task === "/web disable") {
    if (settings.webSearch) settings.webSearch.enabled = false;
    await settingsStore.save(settings);
    refreshWebSearchRuntime();
    console.log(chalk.green(localize(language, "原生联网工具已停用。\n", "Native web tools disabled.\n")));
    return true;
  }
  if (task === "/web configure" || task.startsWith("/web configure ")) {
    try { await configureWebSearch(task); }
    catch (error) { console.error(chalk.red(`${localize(language, "联网搜索配置失败", "Web search configuration failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
    return true;
  }
  return false;
}
