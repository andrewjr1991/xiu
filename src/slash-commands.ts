import fs from "node:fs";
import { PROJECT_CHECK_NAMES } from "./commands/check.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { SlashCommand } from "./interactive-ui.js";

/** Every slash command `/help` lists, in the interface language. The interactive loop dispatches on these names. */
export function slashCommands(language: UiLanguage): SlashCommand[] {
  const item = (name: string, zh: string, en: string): SlashCommand => ({ name, description: localize(language, zh, en) });
  return [
    item("/resume", "选择并恢复项目会话", "Choose and restore a project session"),
    item("/recover", "恢复上次异常中断的任务", "Recover the last interrupted task"),
    item("/history", "查看最近对话", "Show recent conversation"),
    item("/history sessions", "列出本项目会话", "List sessions in this project"),
    item("/compact", "压缩对话上下文", "Compress conversation context"),
    item("/plan", "查看计划或切换只读规划模式", "Show plan or toggle read-only plan mode"),
    item("/tasks", "查看当前任务计划", "Show the live task plan"),
    item("/diff", "查看最近任务开始以来的变化（来源可能未知）", "Show changes since the latest task started (attribution may be unknown)"),
    item("/diff workspace", "查看工作区全部变化，含新文件", "Show all workspace changes, including new files"),
    item("/diff staged", "查看 Git 暂存区变化", "Show staged Git changes"),
    item("/diff runs", "列出最近运行及其保存的改动记录", "List recent runs and their saved change records"),
    item("/diff run:", "回放某次运行保存的改动：/diff run:<序号|ID 前缀> [文件]", "Replay the changes saved for a run: /diff run:<number|id prefix> [file]"),
    item("/check", "发现项目检查脚本并显示最近结果", "Discover project check scripts and show recent results"),
    item("/check all", "依次运行可用的标准项目检查", "Run available standard project checks in order"),
    ...PROJECT_CHECK_NAMES.map((name) => item(`/check ${name}`, `运行项目 ${name} 检查`, `Run the project ${name} check`)),
    item("/paste", "粘贴文字、图片或复制的文件", "Paste clipboard text, image, or copied files"),
    item("/checkpoints", "列出安全恢复点", "List safe file restore points"),
    item("/rewind", "选择恢复点回退", "Choose a checkpoint to restore"),
    item("/models", "发现并选择可用模型", "Discover and choose an available model"),
    item("/media", "查看并恢复媒体生成任务", "Show and recover media generation tasks"),
    item("/providers", "浏览并切换 Provider", "Browse and switch providers"),
    item("/provider test", "测试当前 Provider 连接", "Test the current provider connection"),
    item("/provider capabilities", "重新探测当前模型能力", "Re-probe current model capabilities"),
    item("/provider fallback", "查看当前 Provider 的备用链", "Show the current provider failover chain"),
    item("/provider fallback add", "向备用链末尾添加 Provider", "Append a provider to the failover chain"),
    item("/provider fallback remove", "从备用链移除 Provider", "Remove a provider from the failover chain"),
    item("/provider fallback clear", "清空当前 Provider 的备用链", "Clear the current provider failover chain"),
    item("/routing", "查看阶段模型路由", "Show stage-based model routing"),
    item("/routing on", "启用阶段模型路由", "Enable stage-based model routing"),
    item("/routing off", "停用阶段模型路由", "Disable stage-based model routing"),
    item("/routing set", "为规划、实现或验证阶段指定 Provider", "Assign a provider to a planning, implementation, or verification stage"),
    item("/routing clear", "清除某个阶段的 Provider", "Clear the provider assigned to a stage"),
    item("/provider key", "为 Provider 保存本地 API Key", "Save a local API key for a provider"),
    item("/provider add", "选择模板并添加 Provider", "Choose a template and add a provider"),
    item("/provider edit", "编辑自定义 Provider", "Edit a custom provider"),
    item("/provider remove", "删除自定义 Provider", "Remove a custom provider"),
    item("/language", "设置界面与会话语言", "Set interface and conversation language"),
    item("/web", "查看原生只读联网搜索状态", "Show native read-only web search status"),
    item("/web status", "查看联网搜索本地配置与凭证状态", "Show local web search configuration and credential status"),
    item("/web doctor", "诊断联网搜索健康状态与认证", "Diagnose web search health and authentication"),
    item("/web devices", "查看托管搜索服务端设备与撤销审计（只读）", "Show managed search server devices and revocation audit (read-only)"),
    item("/web reset", "确认后重置托管搜索设备凭证", "Reset the managed search device credential after confirmation"),
    item("/web proxy", "查看联网工具的独立代理", "Show the independent proxy used by web tools"),
    item("/web proxy set", "设置并保存联网工具的独立代理", "Set and save the independent proxy used by web tools"),
    item("/web proxy clear", "清除联网工具已保存的独立代理", "Clear the saved independent proxy used by web tools"),
    item("/web configure managed", "直接使用 Xiu 托管搜索，不启动本机程序", "Use Xiu managed search without local programs"),
    item("/web configure", "配置本机、Xiu 托管或自定义搜索", "Configure local, Xiu managed, or custom search"),
    item("/web disable", "停用原生联网工具", "Disable native web tools"),
    item("/plugins", "列出已发现的 Xiu 插件声明", "List discovered Xiu plugin manifests"),
    item("/plugins reload", "重新扫描插件声明", "Rescan plugin manifests"),
    item("/plugin inspect", "检查插件兼容性、权限与贡献项", "Inspect plugin compatibility, permissions, and contributions"),
    item("/plugin policy", "查看当前项目的团队插件策略", "Show the current project's team plugin policy"),
    item("/plugin approve", "授权并加载插件的当前声明式清单", "Approve and load a plugin's current declarative manifest"),
    item("/plugin install", "从可信本地路径或 HTTPS Git 安装插件", "Install a plugin from a trusted local path or HTTPS Git"),
    item("/plugin update", "预览权限变化并原子更新插件", "Preview permission changes and atomically update a plugin"),
    item("/plugin enable", "启用已安装插件", "Enable an installed plugin"),
    item("/plugin disable", "禁用插件但保留文件和数据", "Disable a plugin while retaining files and data"),
    item("/plugin uninstall", "可恢复地卸载插件", "Recoverably uninstall a plugin"),
    item("/plugin recover", "从最近备份恢复插件", "Restore a plugin from its latest backup"),
    item("/plugin publisher list", "列出已信任的插件发布者", "List trusted plugin publishers"),
    item("/plugin publisher trust", "信任一个已验证签名的插件发布者", "Trust the verified publisher of a signed plugin"),
    item("/plugin publisher revoke", "撤销插件发布者信任", "Revoke trust in a plugin publisher"),
    item("/skills", "浏览或安装 Xiu 技能", "Browse or install Xiu skills"),
    item("/skills install", "安装本地或 HTTPS Git 技能包", "Install a local or HTTPS Git skill package"),
    item("/mcp", "查看 MCP 服务和工具", "Show connected MCP servers and tools"),
    item("/mcp permissions", "查看或确认 MCP 权限清单", "Show or approve MCP permission manifests"),
    item("/mcp resources", "浏览 MCP 资源与模板", "Browse MCP resources and templates"),
    item("/mcp read", "读取一个 MCP 资源", "Read an MCP resource"),
    item("/mcp prompts", "浏览 MCP Prompt", "Browse MCP prompts"),
    item("/mcp prompt", "获取并预览 MCP Prompt", "Get and preview an MCP prompt"),
    item("/mcp auth", "查看 OAuth 状态（不显示 Token）", "Show OAuth status without tokens"),
    item("/mcp credentials", "查看或迁移 MCP OAuth 凭证", "Show or migrate MCP OAuth credentials"),
    item("/mcp login", "登录需要 OAuth 的 MCP 服务", "Log in to an OAuth-protected MCP server"),
    item("/mcp logout", "撤销并清除 MCP OAuth 登录", "Revoke and clear an MCP OAuth login"),
    item("/mcp add", "添加用户级远程 MCP 服务", "Add a user-level remote MCP server"),
    item("/mcp remove", "删除用户级 MCP 服务", "Remove a user-level MCP server"),
    item("/mcp test", "测试 MCP 服务连接", "Test an MCP server connection"),
    item("/mcp reload", "重新加载 MCP 配置", "Reload user and project MCP configuration"),
    item("/agents", "查看多 Agent 运行和任务状态", "Show multi-agent runs and task status"),
    item("/agents cancel", "取消一个 Agent 任务", "Cancel one agent task"),
    item("/agents retry", "重试中断或失败的 Agent", "Retry one interrupted or failed agent"),
    item("/agents integrate", "审查并集成 Worktree Agent", "Review and integrate a Worktree agent"),
    item("/details", "浏览完整工具与 Agent 活动", "Browse complete tool and Agent activity details"),
    item("/background", "查看可跨终端续跑的后台任务", "Show background jobs that survive terminal exit"),
    item("/background start", "确认后启动可跨终端续跑的命令", "Start a confirmed command that survives terminal exit"),
    item("/background read", "从游标读取后台任务输出", "Read background output from a cursor"),
    item("/background cancel", "显式取消后台任务", "Explicitly cancel a background job"),
    item("/diagnostics", "查看当前或最近任务的诊断报告", "Show diagnostics for the current or most recent task"),
    item("/report", "预览或导出最近任务的完整执行报告", "Preview or export the latest task execution report"),
    item("/audit", "查看本机安全审计记录", "Show local security audit records"),
    item("/credentials", "查看凭证后端状态（不显示凭证）", "Show credential backend status without secrets"),
    item("/credentials probe", "显式验证 Windows 系统凭证库读写与清理", "Explicitly verify Windows system credential write, read, and cleanup"),
    item("/credentials migrate", "将一个 Provider Key 迁移到 Windows 凭证库", "Migrate one Provider key to Windows Credential Manager"),
    item("/credentials cleanup", "确认系统副本后删除一个旧明文 Key", "Delete one legacy plaintext key after verifying its system copy"),
    item("/credentials rollback", "切回一个 Provider 保留的旧明文 Key", "Switch one Provider back to its retained legacy key"),
    item("/credentials forget", "删除一个 Provider 的所有本地 Key 副本", "Delete every local key copy for one Provider"),
    item("/status", "查看 Token、调用、耗时和索引", "Show tokens, calls, time, and index stats"),
    item("/update", "显式检查 npm 最新版本并显示升级命令", "Explicitly check npm latest and show the upgrade command"),
    item("/doctor", "一份只读诊断报告：安装、渠道、联网搜索、代理与证书、PowerShell", "One read-only report: installation, providers, web search, proxy and certificates, PowerShell"),
    item("/update doctor", "诊断运行环境、命令来源、npm prefix、包和官方 Registry", "Diagnose runtime, command resolution, npm prefix, package integrity, and the official registry"),
    item("/update status", "查看更新提醒、缓存与自动行为边界", "Show update reminder, cache, and automatic behavior status"),
    item("/update notifications on", "启用非阻塞更新提醒（24 小时缓存）", "Enable non-blocking update reminders (24-hour cache)"),
    item("/update notifications off", "关闭更新提醒（默认）", "Disable update reminders (default)"),
    item("/queue", "查看或安排下一项任务", "Show or schedule the next task"),
    item("/clear-queue", "清空运行期排队任务", "Clear queued follow-ups while a task is running"),
    item("/cancel", "取消当前任务", "Cancel the task that is currently running"),
    item("/clear", "开始新会话", "Start a new conversation session"),
    item("/help", "显示全部命令", "Show all commands"),
    item("/exit", "退出 Xiu", "Exit Xiu"),
  ];
}

/** Commands the loop accepts but `/help` does not list: `/quit` is `/exit`, `/model` points at `/models`. */
export const SLASH_COMMAND_ALIASES: readonly string[] = ["/quit", "/model"];

/** The first word of every accepted command (`/mcp` for `/mcp login`), aliases included. */
export function knownSlashCommandWords(): Set<string> {
  const words = new Set<string>();
  for (const command of slashCommands("en-US")) words.add(command.name.split(/\s+/)[0]!);
  for (const alias of SLASH_COMMAND_ALIASES) words.add(alias);
  return words;
}

export interface UnknownSlashCommand {
  /** The first word of the input, for example `/skils`. */
  word: string;
  /** Listed commands the word most resembles, closest first, at most three. */
  suggestions: string[];
}

export interface UnknownSlashCommandOptions {
  /** Replaces the filesystem probe in tests. */
  pathExists?: (word: string) => boolean;
}

const COMMAND_WORD = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Decides whether an interactive input that starts with a slash is a mistyped command rather than task text.
 * Only a lone word such as `/skils` qualifies: `/etc/hosts`, `/a.b` and `/` are left to the model, and so is a word
 * that names an existing path (`/tmp 下有什么`), because a path is the one ordinary reason a task starts with a slash.
 * Returns undefined when the input is not a slash word, or when it is a command the loop accepts.
 */
export function detectUnknownSlashCommand(input: string, options: UnknownSlashCommandOptions = {}): UnknownSlashCommand | undefined {
  const word = input.trim().split(/\s+/)[0] ?? "";
  if (!COMMAND_WORD.test(word)) return undefined;
  const known = knownSlashCommandWords();
  if (known.has(word)) return undefined;
  const pathExists = options.pathExists ?? ((candidate: string) => { try { return fs.existsSync(candidate); } catch { return false; } });
  if (pathExists(word)) return undefined;
  const lower = word.toLowerCase();
  const listed = [...known].filter((candidate) => !SLASH_COMMAND_ALIASES.includes(candidate)).sort();
  const budget = lower.length - 1 >= 4 ? 2 : 1;
  const ranked = listed
    .map((candidate) => ({ candidate, distance: candidate.startsWith(lower) || lower.startsWith(candidate) ? 0 : editDistance(lower, candidate) }))
    .filter(({ distance }) => distance <= budget)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return { word, suggestions: ranked.slice(0, 3).map(({ candidate }) => candidate) };
}

/** One localized paragraph for the prompt: what was typed, the closest commands, and that nothing reached the model. */
export function formatUnknownSlashCommand(unknown: UnknownSlashCommand, language: UiLanguage): string {
  const options = unknown.suggestions.join(language === "zh-CN" ? "、" : ", ");
  const guess = unknown.suggestions.length
    ? localize(language, `你是想输入 ${options} 吗？`, `Did you mean ${options}?`)
    : "";
  return [
    localize(language, `未知命令 ${unknown.word}。`, `Unknown command ${unknown.word}.`),
    guess,
    localize(language, "输入 /help 查看全部命令。", "Type /help for the full list."),
    localize(language, "这一行没有发送给模型；如果它是任务内容，请不要以斜杠开头。", "This line was not sent to the model; if it is task text, do not start it with a slash."),
  ].filter(Boolean).join(language === "zh-CN" ? "" : " ");
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions each cost one. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[rows - 1]![cols - 1]!;
}
