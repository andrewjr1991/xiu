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
    item("/plan on", "开启只读 Plan 模式", "Turn on read-only Plan mode"),
    item("/plan off", "关闭 Plan 模式", "Turn off Plan mode"),
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
    item("/plugin revoke", "撤销插件授权并卸载其贡献，保留文件", "Revoke a plugin's approval and unload its contributions, keeping its files"),
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
    item("/skills uninstall", "卸载 Xiu 安装的全局技能并保留备份", "Uninstall a Xiu-installed global skill, keeping a backup"),
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

/** What `/quit` and `/model` stand for when their usage is listed. */
const ALIAS_TARGETS: Readonly<Record<string, string>> = { "/quit": "/exit", "/model": "/models" };

/**
 * The help entries for one command: `/help mcp`, `/help /mcp` and `/help mcp login` all narrow the list. A topic that
 * matches nothing as a whole falls back to its first word; an alias shows what it stands for. Empty when the word is unknown.
 */
export function helpEntriesFor(topic: string, language: UiLanguage): SlashCommand[] {
  const words = topic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return slashCommands(language);
  if (!words[0]!.startsWith("/")) words[0] = `/${words[0]}`;
  words[0] = ALIAS_TARGETS[words[0]!] ?? words[0]!;
  const entries = slashCommands(language);
  const matching = (prefix: string) => entries.filter((command) => command.name === prefix || command.name.startsWith(`${prefix} `));
  const whole = matching(words.join(" "));
  return whole.length ? whole : matching(words[0]!);
}

/**
 * The `/help` listing: one command per line with the descriptions in one column, which starts
 * after the longest listed name (at least 20 columns), so `/update notifications off` no longer
 * runs into its description while shorter names are padded.
 */
export function formatHelpEntries(entries: ReadonlyArray<Pick<SlashCommand, "name" | "description">>): string {
  const width = Math.max(20, ...entries.map((command) => command.name.length));
  return entries.map((command) => `${command.name.padEnd(width)} ${command.description}`).join("\n");
}

/** Script-side equivalents of interactive commands, named when a one-shot run is given the interactive form. */
const ONE_SHOT_EQUIVALENTS: Readonly<Record<string, string>> = {
  "/doctor": "xiu doctor [json]",
  "/report": "xiu report [markdown|json|html] [summary|details] [run:<number|id prefix>] [path]",
  "/recover": "xiu recover [status] / xiu recover abandon <run id>",
  "/audit": "xiu audit [approvals|credentials] [json] [limit]",
  "/update": "xiu --check-update / xiu --update-doctor",
  "/resume": "xiu --resume [session]",
  "/history": "xiu --list-sessions",
  "/language": "xiu --language zh-CN|en-US <task>",
  "/models": "xiu --model <model> <task>",
  "/providers": "xiu --provider <id> <task>",
};

export interface OneShotSlashProblem {
  /** The first word of the task, for example `/help` or `/skils`. */
  word: string;
  /** Whether the word is an interactive command (as opposed to a typo of one). */
  known: boolean;
  /** The command-line form that does the same job, when one exists. */
  equivalent?: string;
  /** For an unknown word, the listed commands it most resembles. */
  suggestions: string[];
}

/**
 * Decides whether a one-shot task (`xiu <task>`) is really an interactive slash command. Slash commands run only at the
 * interactive prompt, so such a run does not start and names the script form where one exists. The same path rule as
 * the interactive prompt applies: `/etc/hosts explain` and a word naming an existing path are task text.
 */
export function explainOneShotSlashInput(task: string, options: Pick<SlashInputOptions, "pathExists"> = {}): OneShotSlashProblem | undefined {
  const word = task.trim().split(/\s+/)[0] ?? "";
  if (!COMMAND_WORD.test(word)) return undefined;
  const known = knownSlashCommandWords();
  if (known.has(word)) return { word, known: true, equivalent: ONE_SHOT_EQUIVALENTS[ALIAS_TARGETS[word] ?? word], suggestions: [] };
  const pathExists = options.pathExists ?? ((candidate: string) => { try { return fs.existsSync(candidate); } catch { return false; } });
  if (pathExists(word)) return undefined;
  const listed = [...known].filter((candidate) => !SLASH_COMMAND_ALIASES.includes(candidate)).sort();
  return { word, known: false, suggestions: closest(listed.map((name) => ({ name, score: similarity(word.toLowerCase(), name) }))) };
}

/** One localized paragraph for stderr (or the `--json` result line): why the run did not start and what to run instead. */
export function formatOneShotSlashProblem(problem: OneShotSlashProblem, language: UiLanguage): string {
  const zh = language === "zh-CN";
  const list = (items: string[]) => items.join(zh ? "、" : ", ");
  const sentences = problem.known
    ? [
      localize(language, `${problem.word} 是交互命令，一次性运行（xiu <任务>）不执行斜杠命令：不带任务启动 xiu 进入交互模式后再输入它。`, `${problem.word} is an interactive command; a one-shot run (xiu <task>) does not run slash commands: start xiu without a task and type it at the prompt.`),
      problem.equivalent ? localize(language, `脚本里请用 ${problem.equivalent}。`, `In a script, use ${problem.equivalent}.`) : "",
      localize(language, "这次运行没有开始，也没有把它发给模型。", "This run did not start and nothing was sent to the model."),
    ]
    : [
      localize(language, `未知命令 ${problem.word}。`, `Unknown command ${problem.word}.`),
      problem.suggestions.length ? localize(language, `你是想输入 ${list(problem.suggestions)} 吗？`, `Did you mean ${list(problem.suggestions)}?`) : "",
      localize(language, "斜杠命令只在交互模式可用，一次性运行不会把它发给模型；如果它是任务内容，请不要以斜杠开头。", "Slash commands run only at the interactive prompt, and a one-shot run does not send one to the model; if it is task text, do not start it with a slash."),
    ];
  return sentences.filter(Boolean).join(zh ? "" : " ");
}

/** The commands that run without an interactive session, in the order `xiu --help` lists them. */
export const SCRIPT_COMMANDS: readonly string[] = ["doctor", "report", "recover", "audit"];

/** The bare argument words each script command accepts; `run:<…>`, paths, ids and limits are not words a typo guard needs. */
const SCRIPT_COMMAND_ARGUMENT_WORDS: Readonly<Record<string, readonly string[]>> = {
  doctor: ["json"],
  report: ["markdown", "json", "html", "summary", "details", "runs"],
  recover: ["status", "abandon"],
  audit: ["approvals", "credentials", "json"],
};

export interface ScriptCommandTypo {
  /** The first word as typed, for example `doctr`. */
  word: string;
  /** The script command it is one edit (or a letter case) away from, for example `doctor`. */
  command: string;
}

/**
 * `xiu doctr`, `xiu reprot json`, `xiu Doctor`: a one-shot task of at most three words whose first word is one edit or a
 * letter case away from a script command and whose other words are that command's argument words. Before, such a run
 * went through the trust prompt to the model as a task. A longer task, or one whose other words are not arguments
 * (`edit README`, `recovr abandon 1234`, `doctr fix the tests`), is task text and is left alone; so is the exact word,
 * which the command handles.
 */
export function explainScriptCommandTypo(task: string): ScriptCommandTypo | undefined {
  const words = task.trim().split(/\s+/).filter(Boolean);
  const word = words[0];
  if (!word || words.length > 3 || !/^[A-Za-z]+$/.test(word)) return undefined;
  const typed = word.toLowerCase();
  if (SCRIPT_COMMANDS.includes(word)) return undefined;
  const command = SCRIPT_COMMANDS.find((candidate) => typed === candidate || editDistance(typed, candidate) <= 1);
  if (!command) return undefined;
  const accepted = SCRIPT_COMMAND_ARGUMENT_WORDS[command] ?? [];
  if (!words.slice(1).every((argument) => accepted.includes(argument.toLowerCase()))) return undefined;
  return { word, command };
}

/** One localized paragraph for stderr (or the `--json` result line): the typo, the command meant and that nothing ran. */
export function formatScriptCommandTypo(problem: ScriptCommandTypo, language: UiLanguage): string {
  const zh = language === "zh-CN";
  const commands = SCRIPT_COMMANDS.map((command) => `xiu ${command}`);
  return [
    localize(language, `未知命令 ${problem.word}。你是想运行 xiu ${problem.command} 吗？`, `Unknown command ${problem.word}. Did you mean xiu ${problem.command}?`),
    localize(language, `${commands.join("、")} 不进入交互模式；这次运行没有开始，也没有把它当作任务发给模型。如果它就是任务内容，请写成完整的一句话。`,
      `${commands.slice(0, -1).join(", ")} and ${commands.at(-1)} run without an interactive session; this run did not start and nothing was sent to the model as a task. If it is task text, write it as a full sentence.`),
  ].join(zh ? "" : " ");
}

export type SlashInputProblem =
  /** A lone slash word no command owns, for example `/skils`. */
  | { kind: "unknown-command"; word: string; suggestions: string[] }
  /** A known command word whose handler declined the rest, for example `/mcp lsit` or `/plan onn`. */
  | { kind: "unknown-usage"; word: string; input: string; usage: string[]; suggestions: string[] }
  /** A known command the steer> prompt does not accept while a task runs, for example `/mcp` mid-task. */
  | { kind: "unavailable-while-running"; word: string; available: string[] };

export interface SlashInputOptions {
  /** Replaces the filesystem probe in tests. */
  pathExists?: (word: string) => boolean;
  /** Set while a task runs: the command words the steer> prompt accepts. Any other known word is unavailable until the task ends. */
  runningCommandWords?: ReadonlySet<string>;
}

const COMMAND_WORD = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Explains an interactive input that starts with a slash and that no handler consumed, so the loop can answer it
 * instead of sending it to the model as a task (or as steering while a task runs).
 * Only a lone word qualifies as a command word: `/etc/hosts`, `/a.b` and `/` are left to the model, and so is a word
 * that names an existing path (`/tmp 下有什么`), because a path is the one ordinary reason a task starts with a slash.
 * Returns undefined when the input is not a slash word, or when it is such a path.
 */
export function explainUnhandledSlashInput(input: string, options: SlashInputOptions = {}): SlashInputProblem | undefined {
  const trimmed = input.trim().replace(/\s+/g, " ");
  const word = trimmed.split(" ")[0] ?? "";
  if (!COMMAND_WORD.test(word)) return undefined;
  const known = knownSlashCommandWords();
  if (known.has(word)) {
    if (options.runningCommandWords && !options.runningCommandWords.has(word)) {
      return { kind: "unavailable-while-running", word, available: [...options.runningCommandWords].filter((candidate) => !SLASH_COMMAND_ALIASES.includes(candidate)) };
    }
    const owner = ALIAS_TARGETS[word] ?? word;
    const usage = slashCommands("en-US").map((command) => command.name).filter((name) => name === owner || name.startsWith(`${owner} `));
    const rest = trimmed.toLowerCase().split(" ").slice(1);
    // Compare the typed words with each usage's own words (`proxy sett` with `proxy set`); a usage shorter than what
    // was typed still counts, after the ones of the same length.
    const suggestions = rest.length
      ? closest(usage.filter((name) => name.includes(" ")).map((name) => {
        const tail = name.split(" ").slice(1);
        const score = similarity(rest.slice(0, tail.length).join(" "), tail.join(" "));
        return { name, score: score === undefined ? undefined : score + (tail.length < rest.length ? 1.5 : 0) };
      }))
      : [];
    return { kind: "unknown-usage", word, input: trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed, usage, suggestions };
  }
  const pathExists = options.pathExists ?? ((candidate: string) => { try { return fs.existsSync(candidate); } catch { return false; } });
  if (pathExists(word)) return undefined;
  const listed = [...known].filter((candidate) => !SLASH_COMMAND_ALIASES.includes(candidate)).sort();
  const lower = word.toLowerCase();
  return { kind: "unknown-command", word, suggestions: closest(listed.map((name) => ({ name, score: similarity(lower, name) }))) };
}

/** 0 for a shared prefix, else the edit distance when within one edit (two from four letters on); undefined beyond that. */
function similarity(typed: string, candidate: string): number | undefined {
  const letters = typed.replace(/^\//, "").replace(/\s/g, "").length;
  const budget = letters >= 4 ? 2 : 1;
  const distance = candidate.startsWith(typed) || typed.startsWith(candidate) ? 0 : editDistance(typed, candidate);
  return distance <= budget ? distance : undefined;
}

/** The three best-scoring names, best first, ties alphabetical. */
function closest(scored: Array<{ name: string; score: number | undefined }>): string[] {
  return scored
    .filter((item): item is { name: string; score: number } => item.score !== undefined)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name }) => name);
}

/** One localized paragraph for the prompt: what was typed, the closest commands or usages, and that nothing reached the model. */
export function formatSlashInputProblem(problem: SlashInputProblem, language: UiLanguage): string {
  const zh = language === "zh-CN";
  const list = (items: string[]) => items.join(zh ? "、" : ", ");
  const guess = (suggestions: string[]) => suggestions.length ? localize(language, `你是想输入 ${list(suggestions)} 吗？`, `Did you mean ${list(suggestions)}?`) : "";
  const notSent = localize(language, "这一行没有发送给模型；如果它是任务内容，请不要以斜杠开头。", "This line was not sent to the model; if it is task text, do not start it with a slash.");
  const sentences = problem.kind === "unknown-command"
    ? [localize(language, `未知命令 ${problem.word}。`, `Unknown command ${problem.word}.`), guess(problem.suggestions), localize(language, "输入 /help 查看全部命令。", "Type /help for the full list."), notSent]
    : problem.kind === "unknown-usage"
      ? [
        localize(language, `${problem.word} 没有「${problem.input}」这种用法。`, `${problem.word} has no usage "${problem.input}".`),
        guess(problem.suggestions),
        localize(language, `可用：${list(problem.usage)}；输入 /help ${problem.word.slice(1)} 查看说明。`, `Available: ${list(problem.usage)}; type /help ${problem.word.slice(1)} for details.`),
        notSent,
      ]
      : [
        localize(language, `${problem.word} 在任务运行时不可用，等任务结束后再用。`, `${problem.word} is not available while a task runs; use it after the task ends.`),
        localize(language, `运行中可用：${list(problem.available)}。`, `Available now: ${list(problem.available)}.`),
        localize(language, "这一行没有发送给模型，也没有作为补充。", "This line was not sent to the model or added as steering."),
      ];
  return sentences.filter(Boolean).join(zh ? "" : " ");
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
