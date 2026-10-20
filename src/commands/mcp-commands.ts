import process from "node:process";
import chalk from "chalk";
import { permissionFingerprint } from "../extension-permissions.js";
import { localize, type UiLanguage } from "../i18n.js";
import { describeFailure } from "../user-facing-errors.js";
import { selectTerminalOption } from "../interactive-ui.js";
import type { McpAuthSecretRecord } from "../mcp-auth-store.js";
import type { McpManager, McpOAuthConfig } from "../mcp.js";
import { expandResourceTemplate, isResourceTemplate, resourceTemplateVariables } from "../mcp-resource-template.js";
import type { SecurityAuditOutcome } from "../security-audit.js";
import type { StatusLine } from "../status.js";
import { systemCredentialBackendName, type SystemCredentialStore } from "../system-credential-store.js";
import { askQuestion } from "../terminal-prompts.js";
import { formatLocalTime } from "../local-time.js";

export interface McpCommandContext {
  attachMcpTools: () => void;
  auditCredential: (action: string, subject: string | undefined, outcome: SecurityAuditOutcome) => Promise<void>;
  ensureMcpSystemCredentialStore: () => Promise<SystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record">>;
  language: UiLanguage;
  mcpManager: McpManager;
  projectMcpTrusted: boolean;
  status: StatusLine;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleMcpCommand(task: string, ctx: McpCommandContext): Promise<boolean> {
  const { attachMcpTools, auditCredential, ensureMcpSystemCredentialStore, language, mcpManager, projectMcpTrusted, status } = ctx;
  if (task === "/mcp") {
    console.log(`${mcpManager.summary(language)}\n`);
    return true;
  }
  if (task === "/mcp permissions" || task.startsWith("/mcp permissions ")) {
    const parts = task.trim().split(/\s+/);
    const approving = parts[2]?.toLowerCase() === "approve";
    const requested = approving ? parts[3] : parts[2];
    try {
      const manifests = await mcpManager.permissionManifests(projectMcpTrusted);
      if (approving) {
        const candidates = requested ? manifests.filter((item) => item.name === requested) : manifests.filter((item) => !item.approved);
        const selected = requested ?? await selectTerminalOption(localize(language, "选择要确认权限的 MCP", "Choose an MCP permission manifest to approve"), candidates.map((item) => ({
          label: item.name,
          description: `${item.origin} · ${item.added.join(", ") || localize(language, "清单已变化", "manifest changed")}`,
          value: item.name,
        })), language);
        if (!selected) { console.log(chalk.dim(localize(language, "没有待确认的 MCP 权限，或操作已取消。\n", "No MCP permissions await approval, or the operation was cancelled.\n"))); return true; }
        const manifest = manifests.find((item) => item.name === selected);
        if (!manifest) throw new Error(localize(language, `未找到 MCP ${selected}`, `MCP ${selected} was not found`));
        if (manifest.approved) {
          console.log(chalk.dim(localize(language, `MCP ${selected} 当前权限清单已经确认，无需重复操作。\n`, `MCP ${selected} already has approval for its current permission manifest.\n`)));
          return true;
        }
        console.log(chalk.yellow(localize(language,
          `MCP ${selected} 权限：\n${manifest.permissions.map((permission) => `  • ${permission}`).join("\n")}\n来源：${manifest.origin}\n确认只记录清单，不会绕过工具审批。`,
          `MCP ${selected} permissions:\n${manifest.permissions.map((permission) => `  • ${permission}`).join("\n")}\nSource: ${manifest.origin}\nApproval records the manifest only and cannot bypass tool approvals.`)));
        const answer = await askQuestion(chalk.yellow(localize(language, "确认此权限清单？[y/N] ", "Approve this permission manifest? [y/N] ")));
        if (!/^(y|yes)$/i.test(answer.trim())) { console.log(chalk.dim(localize(language, "已取消权限确认。\n", "Permission approval cancelled.\n"))); return true; }
        await mcpManager.approvePermissions(selected, projectMcpTrusted, permissionFingerprint(manifest));
        await mcpManager.start(projectMcpTrusted);
        attachMcpTools();
        console.log(chalk.green(localize(language, `已确认 MCP ${selected} 权限并重新加载。\n`, `Approved MCP ${selected} permissions and reloaded it.\n`)));
        return true;
      }
      if (!manifests.length) console.log(chalk.dim(localize(language, "未配置 MCP 权限清单。\n", "No MCP permission manifests are configured.\n")));
      else console.log(`${manifests.filter((item) => !requested || item.name === requested).map((item) => [
        `${item.approved ? chalk.green("✓") : chalk.yellow("!")} ${chalk.cyan(item.name)} · ${item.origin} · ${item.declared ? localize(language, "显式声明", "declared") : localize(language, "兼容推导", "compatibility-derived")}`,
        `  ${localize(language, "权限", "Permissions")}: ${item.permissions.join(", ")}`,
        ...(item.details?.length ? [`  ${localize(language, "依据", "Basis")}: ${item.details.join(", ")}`] : []),
        ...(!item.approved ? [`  ${chalk.yellow(localize(language, `待确认变化：${item.added.join(", ") || "配置或清单指纹变化"}`, `Pending changes: ${item.added.join(", ") || "configuration or manifest fingerprint changed"}`))}`] : []),
      ].join("\n")).join("\n") }\n`);
    } catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 权限操作失败", "MCP permission operation failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/mcp resources" || task.startsWith("/mcp resources ")) {
    const requested = task.trim().split(/\s+/)[2];
    const names = mcpManager.connectedServerNames();
    const name = requested ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); return true; }
    try {
      const catalog = await mcpManager.listResources(name);
      const lines = [chalk.cyan(localize(language, `MCP ${name} 资源`, `MCP ${name} resources`))];
      if (!catalog.resources.length && !catalog.templates.length) lines.push(chalk.dim(localize(language, "该服务未提供 Resource 或 Resource Template。", "This server exposes no resources or resource templates.")));
      if (catalog.resources.length) {
        lines.push(chalk.bold(localize(language, "资源", "Resources")));
        for (const resource of catalog.resources) lines.push(`  ${chalk.green(resource.name)} · ${resource.uri}${resource.mimeType ? ` · ${resource.mimeType}` : ""}${resource.description ? `\n    ${chalk.dim(resource.description)}` : ""}`);
      }
      if (catalog.templates.length) {
        lines.push(chalk.bold(localize(language, "资源模板", "Resource templates")));
        for (const template of catalog.templates) lines.push(`  ${chalk.yellow(template.name)} · ${template.uriTemplate}${template.mimeType ? ` · ${template.mimeType}` : ""}${template.description ? `\n    ${chalk.dim(template.description)}` : ""}`);
      }
      if (catalog.truncated) lines.push(chalk.yellow(localize(language, "列表达到安全上限，后续项目已省略。", "The catalog reached its safety limit; remaining items were omitted.")));
      console.log(`${lines.join("\n")}\n`);
    } catch (error) { console.error(chalk.red(`${describeFailure(localize(language, "读取 MCP 资源列表失败", "Failed to list MCP resources"), error, language)}\n`)); }
    return true;
  }
  if (task === "/mcp read" || task.startsWith("/mcp read ")) {
    const parts = task.trim().split(/\s+/);
    const names = mcpManager.connectedServerNames();
    const name = parts[2] ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); return true; }
    try {
      const uri = await resolveResourceUri(mcpManager, name, parts[3], parts.slice(4), language);
      if (!uri) { console.log(chalk.dim(localize(language, "该服务没有可读取的资源或资源模板，或操作已取消。\n", "This server has no readable resource or resource template, or the operation was cancelled.\n"))); return true; }
      const result = await mcpManager.readResource(name, uri);
      console.log(chalk.yellow(localize(language, "以下是不可信的远端 MCP 内容，仅供查看，不会自动作为模型指令执行。", "The following is untrusted remote MCP content. It is displayed only and will not be executed as model instructions.")));
      console.log(`${chalk.cyan(`${result.server} · ${result.label}`)}\n${result.text}${result.truncated ? `\n${chalk.yellow(localize(language, "内容已按安全上限截断。", "Content was truncated at the safety limit."))}` : ""}\n`);
    } catch (error) { console.error(chalk.red(`${describeFailure(localize(language, "读取 MCP 资源失败", "Failed to read MCP resource"), error, language)}\n`)); }
    return true;
  }
  if (task === "/mcp prompts" || task.startsWith("/mcp prompts ")) {
    const requested = task.trim().split(/\s+/)[2];
    const names = mcpManager.connectedServerNames();
    const name = requested ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); return true; }
    try {
      const catalog = await mcpManager.listPrompts(name);
      const lines = [chalk.cyan(localize(language, `MCP ${name} Prompts`, `MCP ${name} prompts`))];
      if (!catalog.prompts.length) lines.push(chalk.dim(localize(language, "该服务未提供 Prompt。", "This server exposes no prompts.")));
      for (const prompt of catalog.prompts) {
        const args = prompt.arguments.map((argument) => `${argument.name}${argument.required ? "*" : ""}`).join(", ");
        lines.push(`  ${chalk.green(prompt.name)}${args ? ` (${args})` : ""}${prompt.description ? `\n    ${chalk.dim(prompt.description)}` : ""}`);
      }
      if (catalog.truncated) lines.push(chalk.yellow(localize(language, "列表达到安全上限，后续项目已省略。", "The catalog reached its safety limit; remaining items were omitted.")));
      console.log(`${lines.join("\n")}\n`);
    } catch (error) { console.error(chalk.red(`${describeFailure(localize(language, "读取 MCP Prompt 列表失败", "Failed to list MCP prompts"), error, language)}\n`)); }
    return true;
  }
  if (task === "/mcp prompt" || task.startsWith("/mcp prompt ")) {
    const parts = task.trim().split(/\s+/);
    const names = mcpManager.connectedServerNames();
    const name = parts[2] ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); return true; }
    try {
      const catalog = await mcpManager.listPrompts(name);
      const promptName = parts[3] ?? await selectTerminalOption(localize(language, "选择 MCP Prompt", "Choose an MCP prompt"), catalog.prompts.map((prompt) => ({ label: prompt.name, description: prompt.description, value: prompt.name })), language);
      if (!promptName) { console.log(chalk.dim(localize(language, "该服务没有可用 Prompt，或操作已取消。\n", "This server has no prompt, or the operation was cancelled.\n"))); return true; }
      const definition = catalog.prompts.find((prompt) => prompt.name === promptName);
      const rawJson = parts.slice(4).join(" ");
      let args: Record<string, string> = {};
      if (rawJson) {
        const parsed = JSON.parse(rawJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(localize(language, "Prompt 参数必须是字符串值 JSON 对象", "Prompt arguments must be a JSON object with string values"));
        args = parsed as Record<string, string>;
      }
      for (const argument of definition?.arguments ?? []) {
        if (args[argument.name] === undefined && argument.required) args[argument.name] = await askQuestion(`${argument.name}${argument.description ? ` (${argument.description})` : ""}: `);
      }
      const result = await mcpManager.getPrompt(name, promptName, args);
      console.log(chalk.yellow(localize(language, "以下是不可信的远端 MCP Prompt，仅供预览，不会自动注入当前任务。", "The following is an untrusted remote MCP prompt. It is previewed only and will not be injected into the current task.")));
      console.log(`${chalk.cyan(`${result.server} · ${result.label}`)}\n${result.text}${result.truncated ? `\n${chalk.yellow(localize(language, "内容已按安全上限截断。", "Content was truncated at the safety limit."))}` : ""}\n`);
    } catch (error) { console.error(chalk.red(`${describeFailure(localize(language, "获取 MCP Prompt 失败", "Failed to get MCP prompt"), error, language)}\n`)); }
    return true;
  }
  if (task === "/mcp credentials" || task.startsWith("/mcp credentials ")) {
    const parts = task.trim().split(/\s+/);
    const action = parts[2] ?? "status";
    const requested = parts[3];
    let auditSubject = requested;
    try {
      const names = await mcpManager.oauthServerNames(projectMcpTrusted);
      if (action === "status") {
        const selectedNames = requested ? names.filter((name) => name === requested) : names;
        if (!selectedNames.length) {
          console.log(chalk.dim(localize(language, "没有匹配的 OAuth MCP。\n", "No matching OAuth MCP server.\n")));
          return true;
        }
        const sections: string[] = [];
        for (const name of selectedNames) {
          const records = await mcpManager.oauthCredentialInfo(name, projectMcpTrusted);
          if (!records.length) {
            sections.push(`${chalk.cyan(name)}\n${localize(language, "  尚无本地 OAuth 凭证", "  No local OAuth credentials")}`);
            continue;
          }
          sections.push(`${chalk.cyan(name)}\n${records.map((record) => localize(language,
            `  ${record.source} · 旧明文 ${record.legacyCopyPresent ? "有" : "无"} · 系统副本 ${record.systemCopyPresent ? "可用" : record.source === "system" ? "不可用" : "无"}${record.interruptedMigration ? " · 迁移待恢复" : ""}`,
            `  ${record.source} · legacy plaintext ${record.legacyCopyPresent ? "present" : "absent"} · system copy ${record.systemCopyPresent ? "available" : record.source === "system" ? "unavailable" : "absent"}${record.interruptedMigration ? " · migration recovery pending" : ""}`)).join("\n")}`);
        }
        console.log(`${sections.join("\n\n")}\n`);
        return true;
      }
      if (!["migrate", "cleanup", "rollback"].includes(action)) {
        console.log(chalk.yellow(localize(language,
          "用法：/mcp credentials [status|migrate|cleanup|rollback] [name]\n",
          "Usage: /mcp credentials [status|migrate|cleanup|rollback] [name]\n")));
        return true;
      }
      const candidateNames: string[] = [];
      for (const name of names) {
        const records = await mcpManager.oauthCredentialInfo(name, projectMcpTrusted);
        const eligible = action === "migrate"
          ? records.some((record) => record.source === "legacy-file")
          : action === "cleanup"
            ? records.some((record) => record.source === "system" && record.legacyCopyPresent)
            : records.some((record) => record.source === "system" && Boolean(record.migratedAt));
        if (eligible) candidateNames.push(name);
      }
      const name = requested ?? await selectTerminalOption(localize(language, "选择 OAuth MCP", "Choose an OAuth MCP server"), candidateNames.map((item) => ({ label: item, value: item })), language);
      auditSubject = name;
      if (!name || !candidateNames.includes(name)) {
        await auditCredential(`mcp-${action}`, auditSubject, "cancelled");
        console.log(chalk.dim(localize(language, "没有符合条件的 OAuth MCP，或操作已取消。\n", "No eligible OAuth MCP server is available, or the operation was cancelled.\n")));
        return true;
      }
      if (action === "migrate") {
        const backendName = systemCredentialBackendName();
        const confirmed = await selectTerminalOption(localize(language,
          `将 ${name} 的 OAuth Token 与 Client Secret 复制到 ${backendName}，校验后切换引用；Scope 等非秘密元数据仍保留在配置文件。继续？`,
          `Copy OAuth tokens and the client secret for ${name} to ${backendName}, verify them, and switch the reference? Non-secret metadata such as scopes remains in the config file.`), [
          { label: localize(language, "继续迁移（保留旧明文）", "Migrate and retain legacy plaintext"), value: "yes" },
          { label: localize(language, "取消", "Cancel"), value: "no" },
        ], language);
        if (confirmed !== "yes") { await auditCredential("mcp-migrate", name, "cancelled"); console.log(chalk.dim(localize(language, "已取消迁移。\n", "Migration cancelled.\n"))); return true; }
        const mcpSystemCredentialStore = await ensureMcpSystemCredentialStore();
        mcpManager.attachOAuthCredentialStore(mcpSystemCredentialStore);
        const count = await mcpManager.migrateOAuthCredentials(name, mcpSystemCredentialStore, projectMcpTrusted);
        await auditCredential("mcp-migrate", name, "succeeded");
        console.log(chalk.green(localize(language,
          `已迁移并校验 ${count} 条 OAuth 凭证。旧明文暂时保留；重启验证成功后运行 /mcp credentials cleanup ${name}。\n`,
          `Migrated and verified ${count} OAuth credential record(s). Legacy plaintext remains; after verifying a restart, run /mcp credentials cleanup ${name}.\n`)));
        return true;
      }
      if (action === "cleanup") {
        const typed = await askQuestion(chalk.yellow(localize(language,
          `将再次校验系统副本并永久删除 ${name} 的旧明文 Token。请输入 MCP 名称“${name}”确认：`,
          `The system copy will be verified again and legacy plaintext tokens for ${name} will be permanently deleted. Type the MCP name "${name}" to confirm: `)));
        if (typed.trim() !== name) { await auditCredential("mcp-cleanup", name, "cancelled"); console.log(chalk.dim(localize(language, "MCP 名称不匹配，已取消清理。\n", "MCP name did not match; cleanup cancelled.\n"))); return true; }
        const count = await mcpManager.cleanupOAuthCredentials(name, projectMcpTrusted);
        await auditCredential("mcp-cleanup", name, "succeeded");
        console.log(chalk.green(localize(language, `已安全删除 ${count} 条旧明文 OAuth 凭证。\n`, `Safely deleted ${count} legacy plaintext OAuth credential record(s).\n`)));
        return true;
      }
      const confirmed = await selectTerminalOption(localize(language,
        `将 ${name} 切回本机兼容文件，并删除系统凭证引用；若旧明文已清理，会先从系统凭证恢复。继续？`,
        `Switch ${name} back to the compatibility file and remove its system reference? If plaintext was cleaned, it will first be restored from the system credential.`), [
        { label: localize(language, "确认回退", "Roll back"), value: "yes" },
        { label: localize(language, "取消", "Cancel"), value: "no" },
      ], language);
      if (confirmed !== "yes") { await auditCredential("mcp-rollback", name, "cancelled"); console.log(chalk.dim(localize(language, "已取消回退。\n", "Rollback cancelled.\n"))); return true; }
      const count = await mcpManager.rollbackOAuthCredentials(name, projectMcpTrusted);
      await auditCredential("mcp-rollback", name, "succeeded");
      console.log(chalk.green(localize(language, `已回退 ${count} 条 OAuth 凭证到兼容文件。\n`, `Rolled back ${count} OAuth credential record(s) to the compatibility file.\n`)));
    } catch (error) {
      if (action !== "status") await auditCredential(`mcp-${action}`, auditSubject, "failed");
      console.error(chalk.red(`${describeFailure(localize(language, "MCP OAuth 凭证操作失败", "MCP OAuth credential operation failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/mcp auth" || task.startsWith("/mcp auth ")) {
    const requested = task.trim().split(/\s+/)[2];
    const entries = await mcpManager.authStatus(requested, projectMcpTrusted);
    if (!entries.length) console.log(chalk.dim(localize(language, "没有匹配的 OAuth MCP。\n", "No matching OAuth MCP server.\n")));
    else console.log(`${entries.map((entry) => {
      const expiry = entry.expiresAt ? formatLocalTime(entry.expiresAt) : localize(language, "未知", "unknown");
      return [
        chalk.cyan(entry.name),
        localize(language, `状态：${entry.authenticated ? entry.expired ? "已过期" : "已登录" : "未登录"}`, `Status: ${entry.authenticated ? entry.expired ? "expired" : "authenticated" : "not authenticated"}`),
        localize(language, `Issuer：${entry.issuer ?? "未知"}`, `Issuer: ${entry.issuer ?? "unknown"}`),
        localize(language, `Scope：${entry.scopes.join(" ") || "（默认）"}`, `Scopes: ${entry.scopes.join(" ") || "(default)"}`),
        localize(language, `到期：${expiry}`, `Expires: ${expiry}`),
      ].join("\n");
    }).join("\n\n")}\n`);
    return true;
  }
  if (task === "/mcp login" || task.startsWith("/mcp login ")) {
    const requested = task.trim().split(/\s+/)[2];
    const names = await mcpManager.oauthServerNames(projectMcpTrusted);
    const name = requested ?? await selectTerminalOption(localize(language, "选择要登录的 MCP 服务", "Choose an MCP server to log in to"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) {
      console.log(chalk.dim(localize(language, "没有可登录的 OAuth MCP，或操作已取消。\n", "No OAuth MCP server is available, or login was cancelled.\n")));
      return true;
    }
    const loginController = new AbortController();
    const cancelLogin = (): void => loginController.abort();
    process.once("SIGINT", cancelLogin);
    try {
      console.log(chalk.cyan(localize(language, `正在为 MCP ${name} 启动安全登录，回调仅监听 127.0.0.1。`, `Starting secure login for MCP ${name}; the callback listens only on 127.0.0.1.`)));
      await mcpManager.login(name, {
        signal: loginController.signal,
        confirmAuthorizationServer: async (authorizationServer, resource, details) => {
          const crossOrigin = authorizationServer.origin !== resource.origin;
          console.log(localize(language,
            `MCP：${resource.origin}\n授权服务器：${authorizationServer.origin}${crossOrigin ? "（不同来源）" : ""}\nScope：${details.scopes.join(" ") || "（默认）"}\n回调：${details.callback.toString()}`,
            `MCP: ${resource.origin}\nAuthorization server: ${authorizationServer.origin}${crossOrigin ? " (cross-origin)" : ""}\nScopes: ${details.scopes.join(" ") || "(default)"}\nCallback: ${details.callback.toString()}`));
          const choice = await selectTerminalOption(localize(language, "是否允许本次 OAuth 登录？", "Allow this OAuth login?"), [
            { label: localize(language, "允许本次登录", "Allow this login"), value: true },
            { label: localize(language, "取消", "Cancel"), value: false },
          ], language);
          return choice === true;
        },
        authorizationUrlReady: (url, opened, error) => {
          if (opened) {
            console.log(chalk.dim(localize(language,
              `已请求系统打开浏览器，正在等待授权回调……\n如果浏览器没有自动打开，请复制以下链接完成授权：\n${url.toString()}`,
              `Asked the system to open a browser; waiting for the authorization callback...\nIf no browser opened, copy this URL to authorize:\n${url.toString()}`)));
            return;
          }
          console.log(chalk.yellow(localize(language,
            `无法自动打开浏览器（${error?.message ?? "未知错误"}）。请复制以下链接到浏览器完成授权：\n${url.toString()}`,
            `Could not open a browser (${error?.message ?? "unknown error"}). Copy this URL into a browser to authorize:\n${url.toString()}`)));
        },
      }, projectMcpTrusted);
      await mcpManager.start(projectMcpTrusted);
      attachMcpTools();
      const server = mcpManager.status().find((item) => item.name === name);
      if (server?.state !== "connected") throw new Error(server?.error ?? localize(language, "授权后连接失败", "connection failed after authorization"));
      console.log(chalk.green(localize(language, `MCP ${name} 登录成功，已连接 ${server.tools} 个工具。\n`, `MCP ${name} login succeeded with ${server.tools} tools.\n`)));
    } catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 登录失败", "MCP login failed"), error, language)}\n`));
    } finally { process.removeListener("SIGINT", cancelLogin); }
    return true;
  }
  if (task === "/mcp logout" || task.startsWith("/mcp logout ")) {
    const requested = task.trim().split(/\s+/)[2];
    const names = await mcpManager.oauthServerNames(projectMcpTrusted);
    const name = requested ?? await selectTerminalOption(localize(language, "选择要退出登录的 MCP 服务", "Choose an MCP server to log out"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) { console.log(chalk.dim(localize(language, "没有可退出的 OAuth MCP，或操作已取消。\n", "No OAuth MCP server is available, or logout was cancelled.\n"))); return true; }
    const confirmed = await selectTerminalOption(localize(language, `撤销并清除 MCP ${name} 的本地 Token？`, `Revoke and clear local tokens for MCP ${name}?`), [
      { label: localize(language, "撤销并退出（保留 Client 注册）", "Revoke and log out (keep client registration)"), value: "tokens" as const },
      { label: localize(language, "同时忘记 Client 注册", "Also forget client registration"), value: "all" as const },
      { label: localize(language, "取消", "Cancel"), value: "cancel" as const },
    ], language);
    if (!confirmed || confirmed === "cancel") { await auditCredential("mcp-logout", name, "cancelled"); console.log(chalk.dim(localize(language, "已取消退出登录。\n", "Logout cancelled.\n"))); return true; }
    try {
      const result = await mcpManager.logout(name, confirmed === "all", projectMcpTrusted);
      await auditCredential("mcp-logout", name, "succeeded");
      attachMcpTools();
      console.log(chalk.green(localize(language, `MCP ${name} 已退出登录，本地授权已清除。`, `MCP ${name} logged out; local authorization was cleared.`)));
      if (result.warning) console.log(chalk.yellow(localize(language, `远端撤销未确认：${result.warning}`, `Remote revocation was not confirmed: ${result.warning}`)));
      else if (!result.revoked) console.log(chalk.dim(localize(language, "授权服务器未提供撤销端点；本地 Token 已清除。", "The authorization server did not expose a revocation endpoint; local tokens were cleared.")));
      console.log();
    } catch (error) {
      await auditCredential("mcp-logout", name, "failed");
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 退出登录失败", "MCP logout failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/mcp add" || task.startsWith("/mcp add ")) {
    const parts = task.trim().split(/\s+/);
    const name = parts[2] ?? (await askQuestion(localize(language, "MCP 名称：", "MCP name: "))).trim();
    const url = parts[3] ?? (await askQuestion(localize(language, "Streamable HTTP 地址：", "Streamable HTTP URL: "))).trim();
    const positionalBearer = parts[4];
    const authentication = positionalBearer ? "bearer" : await selectTerminalOption(localize(language, "选择 MCP 认证方式", "Choose MCP authentication"), [
      { label: localize(language, "无需认证", "No authentication"), value: "none" as const },
      { label: localize(language, "Bearer 环境变量", "Bearer environment variable"), value: "bearer" as const },
      { label: "OAuth", value: "oauth" as const },
    ], language);
    if (!authentication) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); return true; }
    const bearerEnv = authentication === "bearer"
      ? (positionalBearer ?? (await askQuestion(localize(language, "Bearer Token 环境变量名：", "Bearer-token environment variable: "))).trim()) || undefined
      : undefined;
    let oauth: McpOAuthConfig | undefined;
    if (authentication === "oauth") {
      const registration = await selectTerminalOption(localize(language, "选择 OAuth Client 注册方式", "Choose OAuth client registration"), [
        { label: localize(language, "预注册 Client ID", "Pre-registered client ID"), value: "pre-registered" as const },
        { label: "Client ID Metadata Document (CIMD)", value: "cimd" as const },
        { label: localize(language, "自动兼容注册（DCR）", "Automatic compatibility registration (DCR)"), value: "auto" as const },
      ], language);
      if (!registration) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); return true; }
      const clientId = registration === "pre-registered" ? (await askQuestion(localize(language, "Client ID：", "Client ID: "))).trim() : undefined;
      const clientMetadataUrl = registration === "cimd" ? (await askQuestion(localize(language, "HTTPS Client Metadata URL：", "HTTPS client metadata URL: "))).trim() : undefined;
      const scopeInput = (await askQuestion(localize(language, "Scope（空格或逗号分隔，可留空）：", "Scopes (space/comma separated, optional): "))).trim();
      const callbackInput = (await askQuestion(localize(language, "固定回调端口（留空使用 53121）：", "Fixed callback port (blank for 53121): "))).trim();
      oauth = {
        type: "oauth",
        registration: registration === "pre-registered" ? "pre-registered" : "auto",
        ...(clientId ? { clientId } : {}),
        ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
        ...(scopeInput ? { scopes: scopeInput.split(/[\s,]+/).filter(Boolean) } : {}),
        ...(callbackInput ? { callbackPort: Number(callbackInput) } : {}),
      };
    }
    const risk = await selectTerminalOption(localize(language, "选择 MCP 工具的默认风险等级", "Choose the default MCP tool risk"), [
      { label: localize(language, "执行（推荐）", "Execute (recommended)"), description: localize(language, "调用前按现有风险规则审批", "Use existing risk-based approval before calls"), value: "execute" as const },
      { label: localize(language, "只读", "Read-only"), description: localize(language, "仅当该服务的所有工具确实只读时选择", "Only when every tool on this server is truly read-only"), value: "read" as const },
      { label: localize(language, "写入", "Write"), description: localize(language, "服务可能修改工作区或外部状态", "The server may modify workspace or external state"), value: "write" as const },
    ], language);
    if (!risk) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); return true; }
    const sampling = await selectTerminalOption(localize(language, "是否允许该服务请求模型采样（用你当前的模型回答它拼好的提示）？", "May this server request model sampling (answers from your current model to prompts it composes)?"), [
      { label: localize(language, "不允许（推荐）", "No (recommended)"), description: localize(language, "服务器的 sampling/createMessage 一律拒绝", "Every sampling/createMessage from the server is refused"), value: "off" as const },
      { label: localize(language, "允许，每次仍需确认", "Yes, with a confirmation each time"), description: localize(language, "只在它的工具调用期间受理，每次请求都弹出危险级确认并计入你的额度", "Served only during its tool calls; each request is a dangerous-risk confirmation billed to your key"), value: "on" as const },
    ], language);
    if (!sampling) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); return true; }
    status.start(localize(language, `正在添加并连接 MCP ${name}`, `Adding and connecting MCP ${name}`));
    try {
      if (oauth) await mcpManager.addUserOAuthServer(name, url, oauth, risk, sampling === "on");
      else await mcpManager.addUserHttpServer(name, url, bearerEnv, risk, sampling === "on");
      await mcpManager.start(projectMcpTrusted);
      attachMcpTools();
      status.stop();
      const server = mcpManager.status().find((item) => item.name === name);
      const result = server?.state === "connected"
        ? localize(language, `MCP ${name} 已添加并连接，发现 ${server.tools} 个工具。`, `MCP ${name} added and connected with ${server.tools} tools.`)
        : server?.state === "auth-required"
          ? localize(language, `MCP ${name} 已保存，需要执行 /mcp login ${name} 完成 OAuth 登录。`, `MCP ${name} was saved; run /mcp login ${name} to complete OAuth login.`)
        : localize(language, `MCP ${name} 已保存，但连接失败：${server?.error ?? "未知错误"}`, `MCP ${name} was saved, but connection failed: ${server?.error ?? "unknown error"}`);
      console.log(`${server?.state === "connected" ? chalk.green(result) : chalk.yellow(result)}\n`);
    } catch (error) {
      status.stop();
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 添加失败", "MCP add failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/mcp sampling" || task.startsWith("/mcp sampling ")) {
    const parts = task.trim().split(/\s+/);
    const requested = parts[2];
    const switchTo = parts[3];
    if (!requested || !switchTo) {
      const entries = (await mcpManager.configurationEntries(projectMcpTrusted)).filter((entry) => !requested || entry.name === requested);
      if (!entries.length) console.log(chalk.dim(localize(language, "没有匹配的 MCP 服务。\n", "No matching MCP server.\n")));
      else console.log(`${entries.map((entry) => localize(language,
        `${entry.name}：采样${entry.config.sampling ? "已开启（每次需确认）" : "关闭"}${entry.origin === "user" ? "" : `（${entry.origin === "plugin" ? "插件" : "项目"}配置，只能在其文件中修改）`}`,
        `${entry.name}: sampling ${entry.config.sampling ? "on (confirmed per request)" : "off"}${entry.origin === "user" ? "" : ` (${entry.origin} configuration; change it in its own file)`}`)).join("\n")}\n${localize(language,
        "用法：/mcp sampling <名称> on|off（仅用户级配置；改动后需 /mcp permissions approve <名称> 重新确认）", "Usage: /mcp sampling <name> on|off (user-level servers only; approve the changed manifest with /mcp permissions approve <name>)")}\n`);
      return true;
    }
    if (switchTo !== "on" && switchTo !== "off") {
      console.log(chalk.yellow(localize(language, "用法：/mcp sampling <名称> on|off\n", "Usage: /mcp sampling <name> on|off\n")));
      return true;
    }
    try {
      const config = await mcpManager.setUserServerSampling(requested, switchTo === "on");
      await mcpManager.start(projectMcpTrusted);
      attachMcpTools();
      console.log(chalk.green(localize(language,
        `MCP ${requested} 的模型采样已${config.sampling ? "开启：服务器只能在自己的工具调用期间请求，每次请求都需要你确认" : "关闭：服务器的采样请求一律拒绝"}。权限清单已变化，请运行 /mcp permissions approve ${requested} 重新确认后再连接。\n`,
        `Model sampling for MCP ${requested} is now ${config.sampling ? "on: the server may ask only during its own tool calls and every request needs your confirmation" : "off: the server's sampling requests are refused"}. The permission manifest changed; run /mcp permissions approve ${requested} to confirm it before reconnecting.\n`)));
    } catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 采样设置失败", "MCP sampling change failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/mcp remove" || task.startsWith("/mcp remove ")) {
    const requested = task.trim().split(/\s+/)[2];
    const names = await mcpManager.userServerNames();
    const name = requested ?? await selectTerminalOption(localize(language, "删除哪个用户级 MCP？", "Remove which user-level MCP server?"), names.map((item) => ({ label: item, value: item })), language);
    if (!name) { console.log(chalk.dim(localize(language, "没有可删除的用户级 MCP，或操作已取消。\n", "No user-level MCP server can be removed, or the operation was cancelled.\n"))); return true; }
    const confirmed = (await askQuestion(chalk.yellow(localize(language, `确认删除用户级 MCP ${name}？[y/N] `, `Remove user-level MCP ${name}? [y/N] `)))).trim();
    if (!/^(y|yes)$/i.test(confirmed)) { console.log(chalk.dim(localize(language, "已取消删除 MCP。\n", "MCP removal cancelled.\n"))); return true; }
    try {
      if (!await mcpManager.removeUserServer(name)) throw new Error(localize(language, `用户配置中不存在 ${name}`, `${name} does not exist in user configuration`));
      await mcpManager.start(projectMcpTrusted);
      attachMcpTools();
      console.log(chalk.green(localize(language, `已删除 MCP ${name}。\n`, `Removed MCP ${name}.\n`)));
    } catch (error) {
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 删除失败", "MCP removal failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/mcp test" || task.startsWith("/mcp test ")) {
    const requested = task.trim().split(/\s+/)[2];
    status.start(localize(language, "正在测试 MCP 连接", "Testing MCP connections"));
    await mcpManager.start(projectMcpTrusted);
    attachMcpTools();
    status.stop();
    const servers = requested ? mcpManager.status().filter((item) => item.name === requested) : mcpManager.status();
    if (!servers.length) console.log(chalk.yellow(localize(language, `未找到 MCP ${requested ?? "服务"}。\n`, `MCP ${requested ?? "server"} was not found.\n`)));
    else console.log(`${servers.map((server) => server.state === "connected"
      ? chalk.green(localize(language, `✓ ${server.name}：已连接 · ${server.transport} · ${server.tools} 个工具`, `✓ ${server.name}: connected · ${server.transport} · ${server.tools} tools`))
      : server.state === "auth-required"
        ? chalk.yellow(localize(language, `! ${server.name}：需要 OAuth 登录 · 运行 /mcp login ${server.name}`, `! ${server.name}: OAuth login required · run /mcp login ${server.name}`))
        : server.state === "permission-required"
          ? chalk.yellow(localize(language, `! ${server.name}：需要确认权限 · 运行 /mcp permissions approve ${server.name}`, `! ${server.name}: permission approval required · run /mcp permissions approve ${server.name}`))
        : chalk.red(localize(language, `× ${server.name}：连接失败 · ${server.error}`, `× ${server.name}: failed · ${server.error}`))).join("\n")}\n`);
    return true;
  }
  if (task === "/mcp reload") {
    status.start(localize(language, "正在重新加载 MCP 服务", "Reloading MCP servers"));
    try {
      await mcpManager.start(projectMcpTrusted);
      attachMcpTools();
      status.stop();
      console.log(`${chalk.green(localize(language, "MCP 配置已重新加载。", "MCP configuration reloaded."))}\n${mcpManager.summary(language)}\n`);
    } catch (error) {
      status.stop();
      console.error(chalk.red(`${describeFailure(localize(language, "MCP 重新加载失败", "MCP reload failed"), error, language)}\n`));
    }
    return true;
  }
  return false;
}

/** `name=value` words after the resource argument pre-fill template variables; anything else is a usage error. */
function parseTemplateValues(words: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const word of words) {
    const separator = word.indexOf("=");
    if (separator <= 0) throw new Error(`Expected name=value after the resource template, got ${JSON.stringify(word)}.`);
    values[word.slice(0, separator)] = word.slice(separator + 1);
  }
  return values;
}

/**
 * Turns the `/mcp read` arguments into the URI to read. A plain URI is used as given. A resource
 * template (chosen from the catalog, named by its title or template string, or typed as a template)
 * has every variable filled from `name=value` arguments or an interactive prompt before expansion;
 * Xiu never fills a variable itself. Returns undefined when nothing was chosen.
 */
export async function resolveResourceUri(mcpManager: McpManager, server: string, argument: string | undefined, extra: readonly string[], language: UiLanguage): Promise<string | undefined> {
  const presets = parseTemplateValues(extra);
  if (argument && !isResourceTemplate(argument) && !extra.length) {
    const catalog = /^[a-z][a-z0-9+.-]*:/i.test(argument) ? undefined : await mcpManager.listResources(server);
    const template = catalog?.templates.find((item) => item.name === argument);
    if (!template) return argument;
    return expandWithPrompts(template.uriTemplate, presets, language);
  }
  let template = argument;
  if (!template) {
    const catalog = await mcpManager.listResources(server);
    const chosen = await selectTerminalOption(localize(language, "选择要读取的 MCP 资源", "Choose an MCP resource to read"), [
      ...catalog.resources.map((resource) => ({ label: resource.name, description: resource.uri, value: `uri:${resource.uri}` })),
      ...catalog.templates.map((item) => ({ label: `${item.name} ${localize(language, "（模板）", "(template)")}`, description: item.uriTemplate, value: `template:${item.uriTemplate}` })),
    ], language);
    if (!chosen) return undefined;
    if (chosen.startsWith("uri:")) return chosen.slice("uri:".length);
    template = chosen.slice("template:".length);
  } else if (!isResourceTemplate(template)) {
    const catalog = await mcpManager.listResources(server);
    const match = catalog.templates.find((item) => item.name === template || item.uriTemplate === template);
    if (!match) throw new Error(localize(language, `${server} 没有名为 ${JSON.stringify(template)} 的资源模板；用 /mcp resources ${server} 查看。`, `${server} has no resource template named ${JSON.stringify(template)}; list them with /mcp resources ${server}.`));
    template = match.uriTemplate;
  }
  return expandWithPrompts(template, presets, language);
}

async function expandWithPrompts(template: string, presets: Record<string, string>, language: UiLanguage): Promise<string> {
  const values: Record<string, string> = {};
  const variables = resourceTemplateVariables(template);
  if (variables.length) console.log(chalk.dim(localize(language, `资源模板：${template}`, `Resource template: ${template}`)));
  for (const variable of variables) {
    values[variable] = presets[variable] ?? await askQuestion(localize(language, `${variable} 的值> `, `Value for ${variable}> `));
  }
  const uri = expandResourceTemplate(template, values);
  console.log(chalk.dim(localize(language, `读取 URI：${uri}`, `Reading URI: ${uri}`)));
  return uri;
}
