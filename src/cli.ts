#!/usr/bin/env node
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { Agent, BackgroundApprovalRequiredError } from "./agent.js";
import { configureBackgroundWorkspace, listBackgroundProcesses, readBackgroundProcessOutput, startBackgroundProcess, stopBackgroundProcess } from "./background.js";
import { ActivityLog } from "./activity.js";
import { continueTaskAfterAnswer, parseAssistantInteraction } from "./assistant-interaction.js";
import { CheckpointManager } from "./checkpoint.js";
import { applyCapabilityProbe, probeIsFresh, probeModelCapabilities, type CapabilityProbeState } from "./capability-probe.js";
import { ClipboardAttachmentManager } from "./clipboard.js";
import { resolveConfig, type AgentConfig } from "./config.js";
import { EnvironmentCredentialStore, type CredentialBackendStatus } from "./credential-store.js";
import { createWindowsSystemCredentialStore, probeWindowsSystemCredentialStore, type WindowsCredentialProbeResult, type WindowsSystemCredentialStore } from "./system-credential-store.js";
import { languageName, localize, normalizeLanguage, type UiLanguage } from "./i18n.js";
import { DraftStore } from "./draft.js";
import { createProvider, probeProvider } from "./providers.js";
import { ProviderRegistry, resolveStartupModel, resolveStartupProviderId, type ProviderProfile } from "./provider-registry.js";
import { createMediaTools } from "./media-tools.js";
import { MediaOperationStore, type MediaOperationRecord } from "./media-operations.js";
import { McpAuthStore, type McpAuthSecretRecord } from "./mcp-auth-store.js";
import { McpManager, type McpOAuthConfig } from "./mcp.js";
import { createMultiAgentTools, formatAgentRun, MultiAgentCoordinator, selectSubagentTools, type SubagentTask } from "./multi-agent.js";
import { readInteractiveInput, selectTerminalOption, type SlashCommand } from "./interactive-ui.js";
import { createProjectIndexTools, ProjectIndex } from "./project-index.js";
import { createPlanTools, TaskPlanManager } from "./plan.js";
import { listSessions, loadSession, type RestoredSession, type SessionReplayTurn } from "./session.js";
import { createSkillTools, SkillRegistry } from "./skills.js";
import { StatusLine } from "./status.js";
import { SettingsStore } from "./settings.js";
import { renderTerminalMarkdown } from "./terminal-markdown.js";
import { localizeToolDescription, localizeToolProgress } from "./tool-display.js";
import { failureRecoveryOptions, formatRunningInputFooter, RunningTaskView, TaskInputQueue } from "./task-queue.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import { builtinTools, classifyCommand } from "./tools.js";
import { isWorkspaceTrusted, trustWorkspace } from "./trust.js";
import { formatPromptDashboard, renderWelcome } from "./welcome.js";
import { formatTaskDiagnostics, formatTaskDiagnosticSummary } from "./diagnostics.js";
import type { AgentTool } from "./types.js";
import type { ProviderFailoverRequest, ProviderFailoverResolution } from "./provider-failover.js";
import { isProviderRoutingPhase, PROVIDER_ROUTING_PHASES } from "./provider-routing.js";
import { SecurityAuditLog, type SecurityAuditCategory, type SecurityAuditOutcome } from "./security-audit.js";
import { recoveryContinuation, TaskRunJournal, type InterruptedTaskRun } from "./task-run.js";
import { buildExecutionReport, formatExecutionReport, originalTaskGoal, serializeExecutionReport, writeExecutionReport, type ExecutionReportFormat, type ExecutionReportScope } from "./execution-report.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

function slashCommands(language: UiLanguage): SlashCommand[] {
  const item = (name: string, zh: string, en: string): SlashCommand => ({ name, description: localize(language, zh, en) });
  return [
    item("/resume", "选择并恢复项目会话", "Choose and restore a project session"),
    item("/recover", "恢复上次异常中断的任务", "Recover the last interrupted task"),
    item("/history", "查看最近对话", "Show recent conversation"),
    item("/history sessions", "列出本项目会话", "List sessions in this project"),
    item("/compact", "压缩对话上下文", "Compress conversation context"),
    item("/plan", "查看计划或切换只读规划模式", "Show plan or toggle read-only plan mode"),
    item("/tasks", "查看当前任务计划", "Show the live task plan"),
    item("/diff", "查看本会话修改的文件与 Git 差异", "Show files and Git diff changed this session"),
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
    item("/provider add", "添加 OpenAI-compatible Provider", "Add an OpenAI-compatible provider"),
    item("/provider edit", "编辑自定义 Provider", "Edit a custom provider"),
    item("/provider remove", "删除自定义 Provider", "Remove a custom provider"),
    item("/language", "设置界面与会话语言", "Set interface and conversation language"),
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
    item("/queue", "查看或安排下一项任务", "Show or schedule the next task"),
    item("/clear-queue", "清空运行期排队任务", "Clear queued follow-ups while a task is running"),
    item("/cancel", "取消当前任务", "Cancel the task that is currently running"),
    item("/clear", "开始新会话", "Start a new conversation session"),
    item("/help", "显示全部命令", "Show all commands"),
    item("/exit", "退出 Xiu", "Exit Xiu"),
  ];
}

const program = new Command()
  .name("xiu")
  .version(packageJson.version)
  .description("A safe, autonomous coding agent for your terminal")
  .argument("[task...]", "coding task to perform")
  .option("-p, --provider <provider>", "provider profile id (see /providers)")
  .option("-m, --model <model>", "model name")
  .option("-C, --cwd <directory>", "workspace directory")
  .option("--base-url <url>", "OpenAI-compatible API base URL")
  .option("--media-base-url <url>", "media generation API base URL")
  .option("--proxy <url>", "HTTP(S) proxy URL, for example http://127.0.0.1:12334")
  .option("--vision-model <model>", "model used to analyze images")
  .option("--image-model <model>", "model used to generate and edit images")
  .option("--video-model <model>", "model used to generate videos")
  .option("--unified-model <model>", "use one model for text, vision, image, and video capabilities")
  .option("-r, --resume [session]", "choose a workspace session to resume, or resume a specific session id")
  .option("--list-sessions", "list resumable sessions in this workspace")
  .option("--context-window <tokens>", "override the model context window when provider metadata is unavailable")
  .option("--context-limit <tokens>", "override the automatic compaction threshold (maximum 90% of the window)")
  .option("--max-turns <number>", "optional user-selected agent turn limit (unlimited by default)")
  .option("--budget-tokens <number>", "stop safely after this many task tokens")
  .option("--budget-model-calls <number>", "stop safely after this many model calls")
  .option("--budget-tool-calls <number>", "stop safely after this many tool calls")
  .option("--budget-failures <number>", "stop safely after this many model or tool failures")
  .option("--budget-seconds <number>", "stop safely after this many elapsed seconds")
  .option("--budget-warning-percent <number>", "warn when a task reaches this percentage of a budget", "80")
  .option("--stall-timeout-seconds <number>", "elapsed time without new evidence before stall diagnosis", "120")
  .option("--agent-concurrency <number>", "maximum concurrent specialist agents", "3")
  .option("--language <language>", "interface and conversation language: zh-CN or en-US")
  .option("-y, --yes", "approve writes and execution automatically (dangerous actions still prompt)", false)
  .showHelpAfterError()
  .parse();

async function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); }
  finally { rl.close(); }
}

async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) return askQuestion(prompt);
  const input = process.stdin;
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("API key entry cancelled"));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          const characters = [...value];
          if (characters.length) {
            characters.pop();
            value = characters.join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

async function confirmWorkspaceTrust(workspace: string, language: UiLanguage): Promise<boolean> {
  if (await isWorkspaceTrusted(workspace)) return true;
  console.log(chalk.bold(localize(language, "是否信任此工作区中的文件？", "Do you trust the files in this workspace?")));
  console.log(chalk.dim(localize(language, "Xiu 可以在这里读取文件和项目指令、加载 MCP、修改代码并运行命令。", "Xiu may read files, load project instructions and MCP servers, modify code, and run commands here.")));
  console.log(`\n  ${chalk.green("1.")} ${localize(language, "信任此工作区", "Trust this workspace")}`);
  console.log(`  ${chalk.red("2.")} ${localize(language, "退出", "Exit")}\n`);
  const choice = (await askQuestion(chalk.cyan(localize(language, "选择 [1]：", "Select [1]: ")))).trim();
  if (choice !== "" && choice !== "1") {
    console.log(chalk.dim(localize(language, "未信任工作区，Xiu 没有检查或修改其中内容。", "Workspace was not trusted. Xiu did not inspect or modify it.")));
    return false;
  }
  await trustWorkspace(workspace);
  console.log(chalk.green(localize(language, "已信任工作区。\n", "Workspace trusted.\n")));
  return true;
}

async function chooseSession(workspace: string, language: UiLanguage) {
  const sessions = await listSessions(workspace);
  if (!sessions.length) return undefined;
  const selected = await selectTerminalOption(localize(language, "恢复哪个会话？", "Resume which session?"), sessions.map((session) => ({
    label: session.firstTask.replace(/\s+/g, " ").slice(0, 72) || localize(language, "未命名会话", "Untitled session"),
    description: `${new Date(session.updatedAt).toLocaleString()}  ${session.model ?? localize(language, "未知模型", "unknown model")}  ${session.id}`,
    value: session.id,
  })), language);
  return selected ? await loadSession(workspace, selected) : undefined;
}

async function main(): Promise<void> {
  const options = program.opts();
  const settingsStore = new SettingsStore();
  const settings = await settingsStore.load();
  let systemCredentialStore: WindowsSystemCredentialStore<string, "provider-api-key"> | undefined;
  try { systemCredentialStore = await createWindowsSystemCredentialStore("provider-api-key"); }
  catch { /* The CLI remains usable with environment and legacy credentials. */ }
  let mcpSystemCredentialStore: WindowsSystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record"> | undefined;
  try { mcpSystemCredentialStore = await createWindowsSystemCredentialStore("mcp-oauth-record"); }
  catch { /* OAuth remains usable through the compatibility store until explicitly migrated. */ }
  const providerRegistry = new ProviderRegistry(undefined, systemCredentialStore);
  await providerRegistry.load();
  const runtimeProfile = (profile: ProviderProfile, model = profile.model): ProviderProfile => ({
    ...profile,
    features: applyCapabilityProbe(profile.features, providerRegistry.capabilityProbe(profile.id, model)),
  });
  const profileConfig = (profile: ProviderProfile, model?: string, discoveredContextWindow?: number) => {
    const selectedModel = model ?? profile.model;
    const effective = runtimeProfile(profile, selectedModel);
    const cachedProbe = providerRegistry.capabilityProbe(profile.id, selectedModel);
    const apiContextWindow = discoveredContextWindow ?? cachedProbe?.contextWindow;
    const resolved = resolveConfig({
      ...options,
      provider: effective.kind,
      providerId: effective.id,
      providerLabel: effective.name,
      apiKeyEnv: effective.apiKeyEnv,
      apiKey: effective.apiKey,
      credentialRevision: providerRegistry.credentialRevision(effective.id),
      providerFeatures: effective.features,
      baseURL: options.baseURL ?? effective.baseURL,
      proxy: options.proxy ?? effective.proxy,
      contextWindow: options.contextWindow ?? (effective.contextWindow ? String(effective.contextWindow) : apiContextWindow ? String(apiContextWindow) : undefined),
      model: selectedModel,
      language: options.language ?? process.env.XIU_LANGUAGE ?? settings.language,
    });
    if (options.contextWindow === undefined && effective.contextWindow === undefined && apiContextWindow) resolved.contextWindowSource = "api";
    return resolved;
  };
  const savedProviderId = providerRegistry.activeId();
  const requestedProviderId = resolveStartupProviderId(options.provider, savedProviderId, process.env.XIU_PROVIDER);
  const startupProfile = providerRegistry.get(requestedProviderId);
  if (!startupProfile) throw new Error(`Provider profile not found: ${requestedProviderId}. Run xiu and use /providers.`);
  const startupModel = resolveStartupModel(
    options.model,
    requestedProviderId === savedProviderId ? providerRegistry.activeModel(requestedProviderId) : undefined,
    process.env.XIU_MODEL,
    startupProfile.model,
  );
  const config = profileConfig(startupProfile, startupModel);
  configureBackgroundWorkspace(config.cwd);
  const taskRunJournal = new TaskRunJournal(config.cwd);
  let recoverySource: InterruptedTaskRun | undefined;
  let confirmedRecoveryTask: string | undefined;
  const securityAudit = new SecurityAuditLog(undefined, config.cwd);
  const auditCredential = async (action: string, subject: string | undefined, outcome: SecurityAuditOutcome): Promise<void> => {
    await securityAudit.record({ category: "credential", action, outcome, ...(subject ? { subject } : {}), source: "command" });
  };
  let language = config.language ?? "en-US";
  const stat = await fs.stat(config.cwd).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Workspace does not exist: ${config.cwd}`);

  const status = new StatusLine();
  const activities = new ActivityLog();
  const mcpManager = new McpManager(config.cwd, undefined, new McpAuthStore(undefined, mcpSystemCredentialStore));
  let mcpStartup: Promise<ReturnType<McpManager["status"]>> | undefined;
  const formatCredentialBackend = (label: string, backend: CredentialBackendStatus): string => {
    const storage = backend.backend === "environment"
      ? localize(language, "进程环境变量", "process environment")
      : backend.secure
      ? localize(language, "系统安全存储", "system secure storage")
      : localize(language, "本机明文兼容存储", "local plaintext compatibility storage");
    const state = backend.available ? localize(language, "可用", "available") : localize(language, "不可用", "unavailable");
    return `${label}: ${backend.backend} · ${state} · ${backend.entries} ${localize(language, "项", "item(s)")} · ${storage}${backend.reason ? ` · ${backend.reason}` : ""}`;
  };
  const printCredentialStatus = async (): Promise<void> => {
    const environmentCredentials = new EnvironmentCredentialStore({
      kind: "provider-api-key",
      ids: [...new Set(providerRegistry.list().map((profile) => profile.apiKeyEnv).filter((id): id is string => Boolean(id)))],
    });
    const providerCredentials = providerRegistry.credentialStatus();
    const mcpCredentials = await mcpManager.credentialStatus();
    const systemCredentials = await probeWindowsSystemCredentialStore(false);
    const providerDetails = providerRegistry.credentialInfo().filter((item) => item.source !== "missing" || item.legacyCopyPresent || item.systemCopyPresent);
    console.log([
      chalk.cyan(localize(language, "凭证状态（不会显示 Key 或 Token）", "Credential status (keys and tokens are never shown)")),
      formatCredentialBackend("Provider env", environmentCredentials.status()),
      formatCredentialBackend("Provider", providerCredentials),
      formatCredentialBackend("MCP OAuth", mcpCredentials),
      formatCredentialBackend("Windows", systemCredentials.status),
      ...(providerDetails.length ? [
        chalk.cyan(localize(language, "Provider 凭证引用", "Provider credential references")),
        ...providerDetails.map((item) => `  ${item.providerName} (${item.providerId}) · ${item.source}${item.systemCopyPresent ? localize(language, " · 有系统副本", " · system copy present") : ""}${item.legacyCopyPresent ? localize(language, " · 有旧明文副本", " · legacy plaintext copy present") : ""}${item.interruptedMigration ? localize(language, " · 有可恢复的中断迁移", " · interrupted migration recoverable") : ""}`),
      ] : []),
      chalk.dim(localize(language,
        "迁移与清理必须显式执行；Xiu 不会自动移动或删除凭证。使用 /credentials migrate 开始。",
        "Migration and cleanup are explicit; Xiu never moves or deletes credentials automatically. Use /credentials migrate to begin.")),
    ].join("\n") + "\n");
  };
  const formatCredentialProbe = (probe: WindowsCredentialProbeResult): string => {
    const check = (value: boolean | undefined) => value === undefined ? "-" : value ? "✓" : "!";
    return [
      formatCredentialBackend("Windows", probe.status),
      `${localize(language, "探测", "Probe")}: module ${check(probe.checks.module)} · write ${check(probe.checks.write)} · read ${check(probe.checks.read)} · delete ${check(probe.checks.delete)}`,
      `${localize(language, "时间", "Time")}: ${probe.testedAt}`,
    ].join("\n");
  };
  try {
    if (options.listSessions) {
      const sessions = await listSessions(config.cwd);
      if (!sessions.length) console.log(localize(language, "此工作区没有 Xiu 会话。", "No Xiu sessions in this workspace."));
      else for (const session of sessions) console.log(`${session.id}  ${session.updatedAt}  ${session.model ?? localize(language, "未知模型", "unknown model")}  ${session.firstTask.slice(0, 80)}`);
      return;
    }
    const resumeRequested = options.resume !== undefined && options.resume !== false;
    let restored = resumeRequested && typeof options.resume === "string"
      ? await loadSession(config.cwd, options.resume)
      : undefined;
    if (restored?.providerId && !options.provider) {
      const restoredProfile = providerRegistry.get(restored.providerId);
      if (restoredProfile) Object.assign(config, profileConfig(restoredProfile, restored.model));
    }
    if (restored?.model) {
      const previous = config.model;
      config.model = restored.model;
      if (config.capabilities) {
        config.capabilities.text = restored.model;
        if (config.provider !== "agnes" || config.capabilities.vision === previous) config.capabilities.vision = restored.model;
      }
    }
    const initialTask = (program.args as string[]).join(" ").trim();
    const skillRegistry = new SkillRegistry(config.cwd);
    const trustedBeforePrompt = await isWorkspaceTrusted(config.cwd);
    await skillRegistry.refresh(trustedBeforePrompt);
    if (initialTask) {
      console.log(chalk.bold(`\nXiu - ${config.providerId}/${config.model}`));
      console.log(chalk.dim(`${localize(language, "工作区", "Workspace")}: ${config.cwd}\n`));
    } else {
      renderWelcome(config, packageJson.version, skillRegistry.list().length);
    }

    const windowsDirectory = process.env.WINDIR;
    if (windowsDirectory && config.cwd.toLowerCase() === path.join(windowsDirectory, "System32").toLowerCase()) {
      console.log(chalk.yellow(localize(language, "警告：Xiu 正在 Windows System32 中运行。请退出并进入项目目录后重新启动，以免误改系统文件。\n", "Warning: Xiu is running in Windows System32. Exit, enter your project directory, and start Xiu there before making changes.\n")));
    }

    if (!(await confirmWorkspaceTrust(config.cwd, language))) return;
    config.projectConfigurationTrusted = true;
    await skillRegistry.refresh(true);
    let mcpStatuses = [] as ReturnType<McpManager["status"]>;
    let mcpConfigError: unknown;
    const projectMcpTrusted = true;
    const startMcp = async (): Promise<ReturnType<McpManager["status"]>> => {
      try {
        mcpStatuses = await mcpManager.start(projectMcpTrusted);
        return mcpStatuses;
      } catch (error) {
        mcpConfigError = error;
        return [];
      }
    };
    if (initialTask) {
      status.start(localize(language, "正在连接 MCP 服务", "Connecting MCP servers"));
      try { await startMcp(); }
      finally { status.stop(); }
    } else {
      // Interactive startup must remain immediately usable. MCP connections are
      // established in the background and attached to the agent once ready.
      mcpStartup = startMcp();
    }
    if (initialTask && mcpConfigError) console.log(chalk.yellow(localize(language, `未加载 MCP 配置：${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`, `MCP configuration was not loaded: ${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`)));
    if (!projectMcpTrusted && initialTask && await fs.stat(path.join(config.cwd, ".xiu", "mcp.json")).then(() => true).catch(() => false)) {
      console.log(chalk.yellow(localize(language, "工作区尚未信任，因此已跳过项目 MCP 配置。请先以交互方式启动 Xiu 并确认信任。\n", "Project MCP configuration was skipped because this workspace has not been trusted. Start interactive Xiu once to review and trust it.\n")));
    }
    if (initialTask && mcpStatuses.length) {
      const connected = mcpStatuses.filter((server) => server.state === "connected");
      const failed = mcpStatuses.filter((server) => server.state === "failed");
      const permissions = mcpStatuses.filter((server) => server.state === "permission-required");
      console.log(chalk.dim(localize(language, `MCP：${connected.length} 个已连接，${mcpManager.tools().length} 个工具${permissions.length ? `，${permissions.length} 个待确认权限` : ""}${failed.length ? `，${failed.length} 个失败` : ""}。使用 /mcp 查看详情。\n`, `MCP: ${connected.length} connected, ${mcpManager.tools().length} tools${permissions.length ? `, ${permissions.length} awaiting permission approval` : ""}${failed.length ? `, ${failed.length} failed` : ""}. Use /mcp for details.\n`)));
    }
    if (resumeRequested && !restored) {
      restored = await chooseSession(config.cwd, language);
      if (!restored) {
        console.log(chalk.dim(localize(language, "未选择会话，将开始新会话。\n", "No session selected. Starting a new session.\n")));
      }
    }
    if (restored?.providerId && !options.provider) {
      const restoredProfile = providerRegistry.get(restored.providerId);
      if (restoredProfile) Object.assign(config, profileConfig(restoredProfile, restored.model));
    }
    if (restored?.model && restored.model !== config.model) {
      const previous = config.model;
      config.model = restored.model;
      if (config.capabilities) {
        config.capabilities.text = restored.model;
        if (config.provider !== "agnes" || config.capabilities.vision === previous) config.capabilities.vision = restored.model;
      }
    }

    status.start(localize(language, "正在索引项目", "Indexing project"));
    const projectIndex = new ProjectIndex(config.cwd);
    await projectIndex.initialize();
    const draftStore = new DraftStore(config.cwd);
    const clipboard = new ClipboardAttachmentManager(config.cwd, undefined, language);
    const rightClickPasteEnabled = await clipboard.supportsRightClickPaste();
    let restoredDraft = await draftStore.load();
    status.stop();
    const planManager = new TaskPlanManager(restored?.plan, restored?.planMode, language);
    const checkpointManager = new CheckpointManager(config.cwd, restored?.id);
    let runningTaskView: RunningTaskView | undefined;
    const oneShotChanges: WorkspaceChangeNotice[] = [];
    let activeQueuedInputController: AbortController | undefined;
    const emitLine = (value = ""): void => {
      if (runningTaskView) runningTaskView.line(value);
      else console.log(value);
    };
    const emitWrite = (value: string): void => {
      if (runningTaskView) runningTaskView.write(value);
      else process.stdout.write(value);
    };
    const formatByteSize = (bytes: number): string => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    const fileKind = (filename: string): string => ({
      ".html": "HTML", ".htm": "HTML", ".ts": "TypeScript", ".tsx": "TSX", ".js": "JavaScript", ".jsx": "JSX",
      ".css": "CSS", ".json": "JSON", ".md": "Markdown", ".py": "Python", ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG",
    } as Record<string, string>)[path.extname(filename).toLowerCase()] ?? localize(language, "文件", "file");
    const printWorkspaceChanges = (notices: WorkspaceChangeNotice[]): void => {
      if (!notices.length) return;
      const files = new Map<string, WorkspaceChangeNotice["files"][number]>();
      for (const notice of notices) for (const file of notice.files) {
        const previous = files.get(file.path);
        files.set(file.path, previous ? {
          ...file,
          kind: previous.kind === "created" && file.kind !== "deleted" ? "created" : file.kind,
          additions: previous.additions !== undefined && file.additions !== undefined ? previous.additions + file.additions : file.additions,
          deletions: previous.deletions !== undefined && file.deletions !== undefined ? previous.deletions + file.deletions : file.deletions,
          bytesBefore: previous.bytesBefore,
        } : file);
      }
      console.log(chalk.cyan(localize(language, "文件变化", "File changes")));
      for (const file of files.values()) {
          const label = ({ created: localize(language, "已创建", "Created"), modified: localize(language, "已修改", "Modified"), deleted: localize(language, "已删除", "Deleted") } as const)[file.kind];
          const counts = file.additions !== undefined && file.deletions !== undefined
            ? ` ${chalk.green(`+${file.additions}`)} ${chalk.red(`-${file.deletions}`)}`
            : ` ${chalk.dim(`${formatByteSize(file.bytesBefore)} → ${formatByteSize(file.bytesAfter)}`)}`;
          console.log(`  ${chalk.green("√")} ${label} ${chalk.bold(file.path)}${counts}`);
          if (file.kind !== "modified") console.log(chalk.dim(`      ${fileKind(file.path)} · ${formatByteSize(file.bytesAfter)}`));
          if (file.hunk) console.log(chalk.dim(`      ${file.hunk}`));
          for (const line of file.preview) {
            const color = line.startsWith("+") ? chalk.green : line.startsWith("-") ? chalk.red : chalk.dim;
            console.log(`      ${color(line)}`);
          }
      }
      console.log();
    };
    const printUserQuestion = (question: string): void => {
      const title = localize(language, " Xiu 需要你的回答 ", " Xiu needs your answer ");
      console.log(chalk.bgYellow.black.bold(title));
      console.log(chalk.yellow.bold(`? ${question}`));
      console.log(chalk.dim(localize(language, "请在下方输入答案；当前会话和任务上下文会继续保留。\n", "Type your answer below; the current session and task context are preserved.\n")));
    };
    const oldAnswerFromTask = (task: string): string | undefined => {
      const match = /(?:用户回答|User answer)[:：]\s*\n([\s\S]*?)(?:\n\n(?:请根据回答|Use the answer)|$)/i.exec(task);
      return match?.[1]?.trim() || undefined;
    };
    const renderReplay = (session: RestoredSession): void => {
      console.log(chalk.green(localize(language, `已恢复会话 ${session.id}`, `Resumed session ${session.id}`)), chalk.dim(localize(language, `（${session.replay.length} 轮对话，${session.messages.length} 条上下文消息，${session.model ?? config.model}）`, `(${session.replay.length} conversation turns, ${session.messages.length} context messages, ${session.model ?? config.model})`)));
      console.log(chalk.dim(localize(language, session.replay.some((turn) => !turn.exact)
        ? "以下旧会话由已保存事件完整重建；从 v0.9.10 起，新会话会保存原始终端语义格式。"
        : "以下内容使用原始终端语义格式回放。",
      session.replay.some((turn) => !turn.exact)
        ? "This older session is reconstructed from all saved events. New sessions from v0.9.10 preserve terminal semantics."
        : "The conversation below is replayed from saved terminal semantics.")));
      console.log();
      for (const turn of session.replay) {
        const oldAnswer = turn.inputKind === "system" ? oldAnswerFromTask(turn.task) : undefined;
        if (turn.inputKind === "answer" || oldAnswer) console.log(`${chalk.cyan(localize(language, "请回答> ", "answer> "))}${oldAnswer ?? turn.task}`);
        else if (turn.inputKind === "system") console.log(chalk.dim(localize(language, "↻ 继续此前未完成的任务", "↻ Continuing the unfinished task")));
        else console.log(`${chalk.cyan("xiu> ")}${turn.task}`);
        for (const supplement of turn.supplements) console.log(`${chalk.cyan(localize(language, "补充> ", "steer> "))}${supplement}`);
        if (turn.changes.length) printWorkspaceChanges(turn.changes);
        if (turn.receipts.length) console.log(`${chalk.cyan(localize(language, "关键操作", "Key actions"))}\n${turn.receipts.map((line) => chalk.green(line)).join("\n")}\n`);
        if (turn.response?.trim()) console.log(`${chalk.cyan.bold("Xiu")}\n${renderTerminalMarkdown(turn.response)}\n`);
        if (turn.question) printUserQuestion(turn.question);
        const completion = turn.completion ?? (turn.diagnostics && turn.diagnostics.outcome !== "running" ? {
          message: localize(language,
            `${turn.diagnostics.outcome === "completed" ? "✓ 已完成" : `! ${turn.diagnostics.outcome}`} · ${(turn.diagnostics.durationMs / 1000).toFixed(1)} 秒 · ${turn.diagnostics.model.attempts} 轮模型调用 · ${turn.diagnostics.tools.calls} 次工具调用`,
            `${turn.diagnostics.outcome === "completed" ? "✓ Done" : `! ${turn.diagnostics.outcome}`} · ${(turn.diagnostics.durationMs / 1000).toFixed(1)}s · ${turn.diagnostics.model.attempts} model turn(s) · ${turn.diagnostics.tools.calls} tool call(s)`),
          success: turn.diagnostics.outcome === "completed",
        } : undefined);
        if (completion && !turn.question) console.log(completion.success ? chalk.green(completion.message) : chalk.yellow(completion.message));
        console.log(chalk.dim("─".repeat(Math.max(20, Math.min((process.stdout.columns || 100) - 2, 120)))));
      }
      if (!session.replay.length) console.log(chalk.dim(localize(language, "此会话没有可回放的用户对话。", "This session has no user conversation to replay.")));
      console.log();
    };
    if (restored) renderReplay(restored);
    const startPhase = (value: string): void => {
      if (runningTaskView) {
        status.stop();
        runningTaskView.setPhase(value);
      } else status.start(value);
    };
    const stopPhase = (): void => {
      if (runningTaskView) runningTaskView.setPhase(localize(language, "正在处理回复", "Processing response"));
      else status.stop();
    };
    let approvalQueue = Promise.resolve();
    let activeApproval = Promise.resolve();
    const sessionApprovalScopes = new Set<string>();
    const approveRequest = async (request: Parameters<ConstructorParameters<typeof Agent>[3]>[0]): Promise<boolean> => {
      let release!: () => void;
      const previous = approvalQueue;
      approvalQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      let finishActiveApproval!: () => void;
      let approvalDecision: boolean | undefined;
      try {
        if (config.autoApprove && request.risk !== "dangerous") {
          request.decisionSource = "automatic";
          approvalDecision = true;
          return approvalDecision;
        }
        if (request.sessionScope && sessionApprovalScopes.has(request.sessionScope)) {
          request.decisionSource = "remembered";
          approvalDecision = true;
          return approvalDecision;
        }
        activeApproval = new Promise<void>((resolve) => { finishActiveApproval = resolve; });
        status.stop();
        activeQueuedInputController?.abort();
        runningTaskView?.discard();
        request.decisionSource = "prompted";
        if (!process.stdin.isTTY) {
          if (config.backgroundMode) throw new BackgroundApprovalRequiredError(request.description);
          approvalDecision = false;
          return approvalDecision;
        }
        if (request.preview) console.log(`${chalk.dim(localize(language, "拟议修改：", "Proposed change:"))}\n${request.preview}\n`);
        const options = [
          { label: localize(language, "否，拒绝", "No, deny"), description: localize(language, "不执行此操作", "Do not run this operation"), value: "deny" as const },
          { label: localize(language, "是，仅允许一次", "Yes, allow once"), description: request.description, value: "once" as const },
          ...(request.sessionScope ? [{
            label: localize(language, "是，本次会话始终允许", "Yes, always allow this session"),
            description: localize(language, "仅记住这一类操作；重新启动 Xiu 后失效", "Remember only this operation family until Xiu exits"),
            value: "session" as const,
          }] : []),
        ];
        const selected = await selectTerminalOption(localize(language, `${request.risk.toUpperCase()} 审批：允许 Xiu ${request.description}？`, `${request.risk.toUpperCase()} approval: allow Xiu to ${request.description}?`), options, language);
        if (selected === "session" && request.sessionScope) sessionApprovalScopes.add(request.sessionScope);
        approvalDecision = selected === "once" || selected === "session";
        return approvalDecision;
      } finally {
        await securityAudit.record({
          category: "approval",
          action: "tool-approval",
          outcome: approvalDecision ? "allowed" : "denied",
          risk: request.risk,
          source: request.decisionSource ?? "prompted",
          scope: request.sessionScope ?? "unscoped",
        });
        finishActiveApproval?.();
        release();
      }
    };

    const resolveProviderFailover = async (
      request: ProviderFailoverRequest,
      buildCandidateTools: (candidateConfig: AgentConfig) => AgentTool[],
    ): Promise<ProviderFailoverResolution> => {
      const chain = providerRegistry.failoverChain(request.originProviderId);
      if (!chain.length) return { reason: localize(language, `主 Provider ${request.originProviderId} 未配置备用链`, `No failover chain is configured for primary provider ${request.originProviderId}`) };
      const skipped: Array<{ providerId: string; reason: string }> = [];
      for (const providerId of chain) {
        if (request.attemptedProviderIds.includes(providerId)) {
          skipped.push({ providerId, reason: localize(language, "本次任务已尝试", "already attempted in this task") });
          continue;
        }
        const profile = providerRegistry.get(providerId);
        if (!profile) {
          skipped.push({ providerId, reason: localize(language, "配置不存在", "profile not found") });
          continue;
        }
        const model = providerRegistry.activeModel(providerId) ?? profile.model;
        const effective = runtimeProfile(profile, model);
        if (request.requiresTools && !effective.features.tools) {
          skipped.push({ providerId, reason: localize(language, "当前请求需要工具能力", "the current request requires tool support") });
          continue;
        }
        const candidateConfig = profileConfig(profile, model);
        const safeInputLimit = candidateConfig.contextLimit ?? Math.floor((candidateConfig.contextWindow ?? 128_000) * 0.8);
        if (request.estimatedInputTokens >= safeInputLimit) {
          skipped.push({ providerId, reason: localize(language, `当前上下文约 ${request.estimatedInputTokens.toLocaleString()} tokens，超过安全输入线 ${safeInputLimit.toLocaleString()}`, `current context is about ${request.estimatedInputTokens.toLocaleString()} tokens, above the safe input limit ${safeInputLimit.toLocaleString()}`) });
          continue;
        }
        return {
          candidate: {
            config: candidateConfig,
            provider: createProvider(candidateConfig),
            tools: buildCandidateTools(candidateConfig),
            label: profile.name,
          },
          skipped,
        };
      }
      return { skipped, reason: localize(language, "备用链中没有满足上下文与能力要求的 Provider", "No provider in the failover chain satisfies the context and capability requirements") };
    };

    try {
      recoverySource = await taskRunJournal.interrupted();
    } catch (error) {
      console.log(chalk.red(localize(language,
        `任务恢复日志无法读取：${error instanceof Error ? error.message : String(error)}。为避免错误重放，Xiu 不会开始新任务。`,
        `The task recovery journal could not be read: ${error instanceof Error ? error.message : String(error)}. Xiu will not start a new task because replay safety cannot be established.`)));
      return;
    }
    if (recoverySource) {
      if (initialTask) {
        console.log(chalk.red(localize(language,
          `检测到异常中断任务 ${recoverySource.runId.slice(0, 8)}。请先不带任务参数启动 xiu，确认恢复或放弃后再运行新任务。`,
          `Interrupted task ${recoverySource.runId.slice(0, 8)} was detected. Start xiu without a task first and explicitly resume or abandon it before running a new task.`)));
        return;
      }
      const point = recoverySource.recoveryPoints.at(-1);
      console.log(chalk.yellow(localize(language,
        `检测到异常中断任务：${recoverySource.taskPreview || "（无摘要）"}\n最后恢复点：${point?.evidence ?? "尚无安全恢复点"}\n待核验副作用：${recoverySource.pendingSideEffects.length} 项。Xiu 不会自动重放这些操作。`,
        `Interrupted task detected: ${recoverySource.taskPreview || "(no summary)"}\nLast recovery point: ${point?.evidence ?? "no safe recovery point"}\nSide effects awaiting verification: ${recoverySource.pendingSideEffects.length}. Xiu will not replay them automatically.`)));
      const action = await selectTerminalOption(localize(language, "如何处理异常中断任务？", "How should the interrupted task be handled?"), [
        { label: localize(language, "确认恢复", "Resume after confirmation"), description: localize(language, "恢复会话，先核验未知副作用，再继续剩余任务", "Restore the session, verify unknown side effects, then continue"), value: "resume" as const },
        { label: localize(language, "放弃旧任务", "Abandon old task"), description: localize(language, "将旧任务标记为已放弃，不执行任何旧操作", "Mark it abandoned without executing any old operation"), value: "abandon" as const },
        { label: localize(language, "退出", "Exit"), description: localize(language, "保持恢复记录，暂不继续", "Keep the recovery record and do nothing"), value: "exit" as const },
      ], language);
      if (action === "resume") {
        try {
          restored = await loadSession(config.cwd, recoverySource.sessionId);
        } catch (error) {
          console.log(chalk.red(localize(language,
            `无法加载关联会话：${error instanceof Error ? error.message : String(error)}。恢复记录已保留。`,
            `The linked session could not be loaded: ${error instanceof Error ? error.message : String(error)}. The recovery record was preserved.`)));
          return;
        }
        if (restored.providerId) {
          const profile = providerRegistry.get(restored.providerId);
          if (profile) Object.assign(config, profileConfig(profile, restored.model));
        }
        confirmedRecoveryTask = recoveryContinuation(recoverySource, language);
      } else if (action === "abandon") {
        await taskRunJournal.abandon(recoverySource.runId);
        console.log(chalk.green(localize(language, "旧任务已标记为放弃；没有重放任何操作。\n", "The old task was abandoned; no operation was replayed.\n")));
        recoverySource = undefined;
      } else {
        return;
      }
    }

    const visibleAgentStates = new Map<string, string>();
    const agentActivities = new Map<string, string>();
    const coordinator = new MultiAgentCoordinator(
      config.cwd,
      async (task: SubagentTask, context) => {
        const childConfig = {
          ...config,
          cwd: context.cwd,
          maxTurns: task.maxTurns ?? config.maxTurns,
          capabilities: config.capabilities ? { ...config.capabilities } : undefined,
          sessionNamespace: "agent-sessions",
        };
        const childIndex = new ProjectIndex(context.cwd);
        await childIndex.initialize();
        const childPlan = new TaskPlanManager(undefined, task.mode === "shared_readonly", language);
        const childCheckpoint = new CheckpointManager(context.cwd);
        const candidateTools = [...builtinTools, ...createProjectIndexTools(childIndex), ...createPlanTools(childPlan)];
        const childTools = selectSubagentTools(candidateTools, task.mode);
        const childAgent = new Agent(
          childConfig,
          createProvider(childConfig),
          childTools,
          approveRequest,
          {
            onModelStart: (turn) => context.reportProgress(localize(language, `思考中 - 第 ${turn} 轮`, `Thinking - turn ${turn}`)),
            onToolStart: (name, description) => context.reportProgress(`${name}: ${localizeToolDescription(name, description, language)}`),
            onToolProgress: (name, message) => context.reportProgress(`${name}: ${localizeToolProgress(message, language)}`),
            onRetry: (message) => context.reportProgress(localizeToolProgress(message, language)),
            onBudgetWarning: (message) => context.reportProgress(message),
            onProviderFailover: (details) => context.reportProgress(localize(language,
              `Provider 故障转移：${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`,
              `Provider failover: ${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`)),
          },
          undefined,
          childIndex,
          childPlan,
          childCheckpoint,
          skillRegistry,
        );
        childAgent.setFailoverController({
          resolve: async (request) => {
            const resolution = await resolveProviderFailover(request, () => childTools);
            if (resolution.candidate) {
              resolution.candidate.config = {
                ...resolution.candidate.config,
                cwd: childConfig.cwd,
                maxTurns: childConfig.maxTurns,
                sessionNamespace: childConfig.sessionNamespace,
              };
            }
            return resolution;
          },
        });
        const cancel = () => childAgent.cancel();
        context.signal.addEventListener("abort", cancel, { once: true });
        try {
          const dependencyContext = context.dependencyResults.length
            ? `\n\nCompleted dependency results:\n${context.dependencyResults.map((item) => `[${item.id}]\n${item.result}`).join("\n\n")}`
            : "";
          const roleGuidance = task.role === "explorer"
            ? "Investigate only. Return concrete file paths, evidence, risks, and a recommended approach. Do not modify files."
            : task.role === "reviewer"
              ? "Review critically. Find correctness, safety, regression, and test gaps. Do not modify files."
              : task.role === "tester"
                ? "Analyze verification needs and use only the tools available under your safety mode. Report exact evidence and limitations."
                : "Implement the scoped change only inside your isolated Worktree. Run relevant verification and summarize every changed file.";
          const result = await childAgent.run(`You are the ${task.role} specialist for a parent Xiu agent.\nGoal: ${task.title}\n\n${task.instructions}\n\nRole requirements: ${roleGuidance}${dependencyContext}`);
          const childStatus = childAgent.status();
          if (childStatus.outcome === "unverified") throw new Error(`Agent ${task.id} changed files but no verification passed.`);
          return {
            result,
            stats: {
              modelCalls: childStatus.stats.modelCalls,
              toolCalls: childStatus.stats.toolCalls,
              inputTokens: childStatus.stats.inputTokens,
              outputTokens: childStatus.stats.outputTokens,
              activeMs: childStatus.stats.activeMs,
            },
          };
        } finally {
          context.signal.removeEventListener("abort", cancel);
        }
      },
      {
        onTaskUpdate: (run, task) => {
          const key = `${run.id}:${task.id}`;
          if (visibleAgentStates.get(key) === task.status) return;
          visibleAgentStates.set(key, task.status);
          status.stop();
          let activityId = agentActivities.get(key);
          if (!activityId) {
            activityId = activities.start("agent", `${task.role}:${task.id}`, task.title);
            agentActivities.set(key, activityId);
          }
          activities.progress(activityId, task.progress ?? task.status);
          if (["completed", "failed", "cancelled", "blocked"].includes(task.status)) activities.finish(activityId, task.result ?? task.error ?? task.status, task.status !== "completed");
          const color = task.status === "completed" ? chalk.green : task.status === "failed" || task.status === "blocked" ? chalk.red : chalk.cyan;
          const displayStatus = localize(language, ({ pending: "等待中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", blocked: "已阻塞", interrupted: "已中断" } as Record<string, string>)[task.status] ?? task.status, task.status);
          const displayRole = localize(language, ({ explorer: "调查", implementer: "实现", reviewer: "审查", tester: "测试" } as Record<string, string>)[task.role] ?? task.role, task.role);
          emitLine(`${color(`[Agent ${task.id}] ${displayStatus}`)} ${chalk.dim(`${displayRole} - ${task.title}`)}`);
        },
        onRunUpdate: (run) => {
          const displayStatus = localize(language, ({ pending: "等待中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", blocked: "已阻塞", interrupted: "已中断" } as Record<string, string>)[run.status] ?? run.status, run.status);
          emitLine(chalk.cyan(localize(language, `多 Agent 任务 ${run.id}：${displayStatus}。`, `Multi-agent run ${run.id} ${run.status}.`)));
        },
      },
      config.agentConcurrency,
    );
    await coordinator.initialize();
    const coordinatorTools = createMultiAgentTools(coordinator);
    const buildBaseTools = (toolConfig = config) => [...builtinTools, ...createProjectIndexTools(projectIndex), ...createPlanTools(planManager), ...createSkillTools(skillRegistry), ...createMediaTools(toolConfig), ...coordinatorTools];
    let baseTools = buildBaseTools();
    const tools = [...baseTools, ...mcpManager.tools()];
    const provider = createProvider(config);

    let activeToolActivity: string | undefined;
    let activeToolDetails: { name: string; description: string; verification: boolean; risk: "read" | "write" | "execute" | "dangerous" } | undefined;
    let verificationReadyForSummary = false;
    const agent = new Agent(
      config,
      provider,
      tools,
      approveRequest,
      {
        onModelStart: (turn) => {
          runningTaskView?.setTurn(turn, config.maxTurns);
          runningTaskView?.activity(localize(language, `模型第 ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} 轮开始`, `Model turn ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} started`));
          startPhase(verificationReadyForSummary
            ? localize(language, "验证已通过，正在整理最终结果", "Verification passed; preparing the final result")
            : localize(language, "思考中", "Thinking"));
        },
        onModelEnd: () => stopPhase(),
        onText: (text) => emitLine(`${text}\n`),
        onTextDelta: (text) => {
          stopPhase();
          emitWrite(text);
        },
        onTextStreamEnd: () => emitWrite("\n\n"),
        onAssistantTurn: (text, hasToolCalls) => {
          if (hasToolCalls) runningTaskView?.narrate(text);
        },
        onToolStart: (name, description, details) => {
          if (!details.verification) verificationReadyForSummary = false;
          const displayDescription = localizeToolDescription(name, description, language);
          activeToolActivity = activities.start("tool", name, displayDescription);
          activeToolDetails = { name, description: displayDescription, verification: details.verification, risk: details.risk };
          runningTaskView?.beginTool(name, displayDescription, details.changesWorkspace, details.verification);
          emitLine(`${chalk.cyan(`> ${name}`)} ${chalk.dim(displayDescription)}`);
          startPhase(localize(language, `正在运行 ${name}`, `Running ${name}`));
        },
        onToolProgress: (name, message) => {
          const displayMessage = localizeToolProgress(message, language);
          if (activeToolActivity) activities.progress(activeToolActivity, displayMessage);
          runningTaskView?.activity(`${name}: ${displayMessage}`);
          startPhase(`${name}: ${displayMessage}`);
        },
        onToolEnd: (_name, result) => {
          stopPhase();
          const failed = /^(?:Tool error:|Tool execution denied|Tool execution blocked by crash recovery:|Unknown tool:|Exit code: (?!0\b)|Process timed out|Command timed out|Verification (?:timed out|unavailable|failed))/i.test(result);
          if (activeToolActivity) activities.finish(activeToolActivity, result, failed);
          activeToolActivity = undefined;
          const summary = result.replace(/\s+/g, " ").trim();
          runningTaskView?.activity(`${_name}: ${failed ? localize(language, "失败", "failed") : localize(language, "已完成", "finished")} - ${summary.slice(0, 100)}`);
          emitLine(`${chalk.dim(summary.length > 240 ? `${summary.slice(0, 240)}... ${localize(language, "（使用 /details 查看完整输出）", "(/details for full output)")}` : summary)}\n`);
          if (!failed && activeToolDetails) {
            if (activeToolDetails.verification) {
              verificationReadyForSummary = true;
              runningTaskView?.markVerificationPassed();
              runningTaskView?.recordImportantAction(localize(language, `验证通过：${activeToolDetails.description}`, `Verified: ${activeToolDetails.description}`));
            }
            else if (activeToolDetails.risk === "execute" || activeToolDetails.risk === "dangerous") runningTaskView?.recordImportantAction(localize(language, `已执行：${activeToolDetails.description}`, `Ran: ${activeToolDetails.description}`));
          }
          activeToolDetails = undefined;
        },
        onCompletionGate: () => emitLine(chalk.yellow(localize(language, "完成前需要验证。\n", "Verification required before completion.\n"))),
        onCompaction: (message) => startPhase(message),
        onRetry: (message) => startPhase(localizeToolProgress(message, language)),
        onBudgetWarning: (message) => {
          runningTaskView?.activity(message);
          emitLine(chalk.yellow(`! ${message}\n`));
        },
        onFailure: (message) => {
          stopPhase();
          runningTaskView?.activity(`${localize(language, "失败", "Failure")}: ${message}`);
          emitLine(chalk.red(`${message}\n`));
        },
        onProviderFailover: (details) => {
          stopPhase();
          const message = localize(language,
            `Provider 故障转移：${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}（原请求在输出前连续失败）`,
            `Provider failover: ${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel} (the original request failed repeatedly before output)`);
          runningTaskView?.activity(message);
          emitLine(`${chalk.yellow(`↪ ${message}`)}\n`);
          if (details.skipped.length) emitLine(`${chalk.dim(details.skipped.map((item) => `${item.providerId}: ${item.reason}`).join(" · "))}\n`);
          startPhase(localize(language, `已切换到 ${details.toProviderId}，正在继续任务`, `Continuing with ${details.toProviderId}`));
        },
        onProviderFailoverUnavailable: (details) => {
          const skipped = details.skipped.length ? ` ${details.skipped.map((item) => `${item.providerId}: ${item.reason}`).join(" · ")}` : "";
          runningTaskView?.activity(localize(language, `备用 Provider 不可用：${details.reason}`, `No fallback provider available: ${details.reason}`));
          emitLine(`${chalk.dim(localize(language, `未执行故障转移：${details.reason}${skipped}`, `Failover not performed: ${details.reason}${skipped}`))}\n`);
        },
        onProviderRoute: (details) => {
          stopPhase();
          const message = localize(language,
            `阶段路由（${details.phase}）：${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`,
            `Stage route (${details.phase}): ${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`);
          runningTaskView?.activity(message);
          emitLine(`${chalk.cyan(`↪ ${message}`)}\n${chalk.dim(details.reason)}\n`);
        },
        onProviderRouteSkipped: (details) => {
          const message = localize(language,
            `阶段路由（${details.phase}）未切换${details.targetProviderId ? `到 ${details.targetProviderId}` : ""}：${details.reason}`,
            `Stage route (${details.phase}) did not switch${details.targetProviderId ? ` to ${details.targetProviderId}` : ""}: ${details.reason}`);
          runningTaskView?.activity(message);
          emitLine(`${chalk.dim(message)}\n`);
        },
        onProviderRouteRestore: (details) => {
          runningTaskView?.activity(localize(language, `已恢复用户选择的 Provider：${details.providerId}/${details.model}`, `Restored the user-selected provider: ${details.providerId}/${details.model}`));
        },
        onPlanUpdate: (plan) => {
          runningTaskView?.setPlan(plan);
          emitLine(`${chalk.cyan(localize(language, "任务计划已更新", "Task plan updated"))}\n${chalk.dim(planManager.format())}\n`);
        },
        onWorkspaceChange: (change) => {
          if (runningTaskView) {
            runningTaskView.recordWorkspaceChange(change);
          } else {
            if (initialTask) oneShotChanges.push(change);
            printWorkspaceChanges([change]);
          }
        },
        onCheckpoint: (message) => emitLine(chalk.dim(`${message}\n`)),
        onTaskComplete: (summary) => {
          runningTaskView?.markFinishing();
          const verification = summary.changed ? (summary.verified ? localize(language, "已验证", "verified") : localize(language, "已尝试验证", "verification noted")) : localize(language, "无文件变化", "no changes");
          const recoveredFailures = (summary.diagnostics?.model.failures ?? 0) + (summary.diagnostics?.tools.failures ?? 0);
          const outcomeLabel = summary.outcome === "completed"
            ? localize(language, "✓ 已完成", "✓ Done")
            : summary.outcome === "failed"
              ? localize(language, "! 任务未完成", "! Task incomplete")
              : localize(language, "! 未验证完成", "! Stopped unverified");
          const recoveryNote = summary.outcome === "completed" && recoveredFailures
            ? localize(language, `（过程中有 ${recoveredFailures} 次可恢复失败）`, ` (${recoveredFailures} recoverable failure(s) during execution)`)
            : "";
          const message = `${outcomeLabel}${recoveryNote} · ${(summary.durationMs / 1000).toFixed(1)}${localize(language, " 秒", "s")} · ${summary.turns} ${localize(language, "轮模型调用", "model turn(s)")} · ${summary.toolCalls} ${localize(language, "次工具调用", "tool call(s)")} · ${summary.diagnostics ? `${(summary.diagnostics.model.inputTokens + summary.diagnostics.model.outputTokens).toLocaleString()} tokens · ${localize(language, `失败 ${summary.diagnostics.model.failures + summary.diagnostics.tools.failures} 次`, `${summary.diagnostics.model.failures + summary.diagnostics.tools.failures} failure(s)`)} · ` : ""}${verification}`;
          if (runningTaskView) runningTaskView.setCompletion(message, summary.outcome === "completed");
          else emitLine(summary.outcome === "completed" ? chalk.green(message) : chalk.yellow(message));
        },
      },
      restored,
      projectIndex,
      planManager,
      checkpointManager,
      skillRegistry,
      taskRunJournal,
    );
    const attachMcpTools = (): void => agent.replaceTools([...baseTools, ...mcpManager.tools()]);
    const ensureMcpReady = async (): Promise<void> => {
      if (mcpStartup) await mcpStartup;
      attachMcpTools();
    };
    if (mcpStartup) {
      // Do not print from this continuation: asynchronous output would corrupt
      // the active line editor. /mcp exposes connection failures on demand.
      void mcpStartup.then(attachMcpTools);
    }
    if (recoverySource) agent.setRecoverySource(recoverySource);
    const featureNames = (profile: ProviderProfile, model = profile.model): string => {
      profile = runtimeProfile(profile, model);
      const names = [localize(language, "文本", "text")];
      if (profile.features.tools) names.push(localize(language, "工具", "tools"));
      if (profile.features.vision) names.push(localize(language, "视觉", "vision"));
      if (profile.features.image) names.push(localize(language, "生图", "image"));
      if (profile.features.video) names.push(localize(language, "视频", "video"));
      return names.join("/");
    };
    const capabilityStateName = (state: CapabilityProbeState): string => ({
      supported: localize(language, "支持", "supported"),
      unsupported: localize(language, "不支持", "unsupported"),
      unknown: localize(language, "未知", "unknown"),
      "not-tested": localize(language, "未测试", "not tested"),
    })[state];
    const capabilityProbeSummary = (profile: ProviderProfile, model = profile.model): string => {
      const probe = providerRegistry.capabilityProbe(profile.id, model);
      if (!probe) return localize(language, "能力未探测", "capabilities not tested");
      const context = probe.contextWindow ? localize(language, ` · 上下文 ${probe.contextWindow.toLocaleString()}（API）`, ` · context ${probe.contextWindow.toLocaleString()} (API)`) : "";
      return localize(language,
        `探测：工具 ${capabilityStateName(probe.tools)} · 视觉 ${capabilityStateName(probe.vision)}${context} · ${new Date(probe.checkedAt).toLocaleString()}`,
        `Probe: tools ${capabilityStateName(probe.tools)} · vision ${capabilityStateName(probe.vision)}${context} · ${new Date(probe.checkedAt).toLocaleString()}`);
    };
    const compactCapabilityProbeSummary = (profile: ProviderProfile, model = profile.model): string => {
      const probe = providerRegistry.capabilityProbe(profile.id, model);
      if (!probe) return localize(language, "未探测", "not tested");
      return localize(language,
        `工具 ${capabilityStateName(probe.tools)} / 视觉 ${capabilityStateName(probe.vision)}`,
        `tools ${capabilityStateName(probe.tools)} / vision ${capabilityStateName(probe.vision)}`);
    };
    agent.setFailoverController({
      resolve: async (request) => {
        const chain = providerRegistry.failoverChain(request.originProviderId);
        if (!chain.length) return { reason: localize(language, `主 Provider ${request.originProviderId} 未配置备用链`, `No failover chain is configured for primary provider ${request.originProviderId}`) };
        const skipped: Array<{ providerId: string; reason: string }> = [];
        for (const providerId of chain) {
          if (request.attemptedProviderIds.includes(providerId)) {
            skipped.push({ providerId, reason: localize(language, "本次任务已尝试", "already attempted in this task") });
            continue;
          }
          const profile = providerRegistry.get(providerId);
          if (!profile) {
            skipped.push({ providerId, reason: localize(language, "配置不存在", "profile not found") });
            continue;
          }
          const model = providerRegistry.activeModel(providerId) ?? profile.model;
          const effective = runtimeProfile(profile, model);
          if (request.requiresTools && !effective.features.tools) {
            skipped.push({ providerId, reason: localize(language, "当前请求需要工具能力", "the current request requires tool support") });
            continue;
          }
          const candidateConfig = profileConfig(profile, model);
          const safeInputLimit = candidateConfig.contextLimit ?? Math.floor((candidateConfig.contextWindow ?? 128_000) * 0.8);
          if (request.estimatedInputTokens >= safeInputLimit) {
            skipped.push({ providerId, reason: localize(language, `当前上下文约 ${request.estimatedInputTokens.toLocaleString()} tokens，超过安全输入线 ${safeInputLimit.toLocaleString()}`, `current context is about ${request.estimatedInputTokens.toLocaleString()} tokens, above the safe input limit ${safeInputLimit.toLocaleString()}`) });
            continue;
          }
          return {
            candidate: {
              config: candidateConfig,
              provider: createProvider(candidateConfig),
              tools: [...buildBaseTools(candidateConfig), ...mcpManager.tools()],
              label: profile.name,
            },
            skipped,
          };
        }
        return { skipped, reason: localize(language, "备用链中没有满足上下文与能力要求的 Provider", "No provider in the failover chain satisfies the context and capability requirements") };
      },
    });
    agent.setRoutingController({
      resolve: async (request) => {
        const policy = providerRegistry.routingPolicy();
        if (!policy.enabled) return {};
        const targetProviderId = policy.phases[request.phase];
        if (!targetProviderId) {
          if (request.currentProviderId === request.defaultProviderId && request.currentModel === request.defaultModel) return {};
          return { useDefault: true, targetProviderId: request.defaultProviderId, reason: localize(language, `当前阶段未绑定 Provider，恢复任务默认模型`, `no provider is assigned to this stage; restoring the task default model`) };
        }
        const profile = providerRegistry.get(targetProviderId);
        if (!profile) return { targetProviderId, reason: localize(language, "目标 Provider 配置不存在", "the target provider profile does not exist") };
        const model = providerRegistry.activeModel(targetProviderId) ?? profile.model;
        const effective = runtimeProfile(profile, model);
        if (request.requiresTools && !effective.features.tools) {
          return { targetProviderId, reason: localize(language, "当前阶段需要工具能力，但目标模型不支持工具", "this stage requires tools, but the target model does not support tools") };
        }
        const candidateConfig = profileConfig(profile, model);
        if (candidateConfig.providerId === request.currentProviderId && candidateConfig.model === request.currentModel) return {};
        const safeInputLimit = candidateConfig.contextLimit ?? Math.floor((candidateConfig.contextWindow ?? 128_000) * 0.8);
        if (request.estimatedInputTokens >= safeInputLimit) {
          return { targetProviderId, reason: localize(language,
            `当前上下文约 ${request.estimatedInputTokens.toLocaleString()} tokens，超过目标模型安全输入线 ${safeInputLimit.toLocaleString()}`,
            `current context is about ${request.estimatedInputTokens.toLocaleString()} tokens, above the target model safe input limit ${safeInputLimit.toLocaleString()}`) };
        }
        return {
          targetProviderId,
          reason: localize(language, `用户已将 ${request.phase} 阶段绑定到 ${profile.name}`, `the user assigned the ${request.phase} stage to ${profile.name}`),
          candidate: {
            config: candidateConfig,
            provider: createProvider(candidateConfig),
            tools: [...buildBaseTools(candidateConfig), ...mcpManager.tools()],
            label: profile.name,
          },
        };
      },
    });
    const switchProviderProfile = async (profile: ProviderProfile, persist = true, preferredModel?: string, forceCapabilityProbe = false): Promise<boolean> => {
      status.start(localize(language, `正在测试 ${profile.name} 连接`, `Testing ${profile.name}`));
      try {
        let targetModel = preferredModel ?? profile.model;
        let candidateConfig = profileConfig(profile, targetModel);
        const connectionModel = candidateConfig.model;
        const connection = await probeProvider(candidateConfig);
        let nextProvider = connection.provider;
        const discovered = connection.models;
        if (candidateConfig.model === "local-model" && discovered[0]?.id) {
          targetModel = discovered[0].id;
        }
        let capabilityProbe = providerRegistry.capabilityProbe(profile.id, targetModel);
        const discoveredWindow = discovered.find((model) => model.id === targetModel)?.contextWindow;
        const apiContextWindow = discoveredWindow ?? capabilityProbe?.contextWindow;
        candidateConfig = profileConfig(profile, targetModel, apiContextWindow);
        if (candidateConfig.model !== connectionModel) nextProvider = createProvider(candidateConfig);
        if (forceCapabilityProbe || !probeIsFresh(capabilityProbe)) {
          status.start(localize(language, `正在探测 ${targetModel} 的工具与视觉能力`, `Probing tool and vision capabilities for ${targetModel}`));
          capabilityProbe = await probeModelCapabilities(candidateConfig, { provider: nextProvider });
          if (apiContextWindow) {
            capabilityProbe.contextWindow = apiContextWindow;
            capabilityProbe.contextWindowSource = "api";
          }
          await providerRegistry.setCapabilityProbe(capabilityProbe);
        }
        const nextConfig = profileConfig(profile, targetModel, apiContextWindow);
        await agent.replaceProvider(nextConfig, nextProvider);
        baseTools = buildBaseTools();
        agent.replaceTools([...baseTools, ...mcpManager.tools()]);
        if (persist) await providerRegistry.setActive(profile.id, targetModel);
        status.stop();
        const activeContextWindow = nextConfig.contextWindow ?? 128_000;
        const activeContextLimit = nextConfig.contextLimit ?? Math.floor(activeContextWindow * 0.8);
        console.log(chalk.green(localize(language, `Provider 已切换为 ${profile.name}，模型 ${nextConfig.model}。`, `Provider changed to ${profile.name}, model ${nextConfig.model}.`)));
        console.log(chalk.dim(localize(language, `上下文：${activeContextWindow.toLocaleString()} · 压缩点 ${activeContextLimit.toLocaleString()}（${nextConfig.contextWindowSource ?? "fallback"}）`, `Context: ${activeContextWindow.toLocaleString()} · compact at ${activeContextLimit.toLocaleString()} (${nextConfig.contextWindowSource ?? "fallback"})`)));
        console.log(chalk.dim(localize(language, `能力：${featureNames(profile, targetModel)}${discovered.length ? ` · 发现 ${discovered.length} 个模型` : ""}`, `Capabilities: ${featureNames(profile, targetModel)}${discovered.length ? ` · discovered ${discovered.length} models` : ""}`)));
        console.log(chalk.dim(`${capabilityProbeSummary(profile, targetModel)}\n`));
        if (connection.discoveryError) console.log(chalk.dim(localize(language, "该服务未提供兼容的模型列表接口；已通过最小聊天请求验证连接。\n", "The service has no compatible model-list endpoint; connection verified with a minimal chat request.\n")));
        return true;
      } catch (error) {
        status.stop();
        console.error(chalk.red(`${localize(language, "Provider 连接失败", "Provider connection failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        return false;
      }
    };

    const onSigint = () => {
      status.stop();
      if (agent.cancel()) {
        runningTaskView?.setPhase(localize(language, "正在取消", "Cancelling"));
        console.log(chalk.yellow(localize(language, "\n正在取消当前任务……", "\nCancelling current task...")));
      }
      else console.log(chalk.dim(localize(language, "\n使用 /exit 退出 Xiu。", "\nUse /exit to leave Xiu.")));
    };
    process.on("SIGINT", onSigint);

    if (initialTask) {
      try {
        await agent.run(initialTask);
      } finally {
        await agent.recordReplayTurn({
          task: initialTask,
          inputKind: "task",
          supplements: [],
          changes: oneShotChanges,
          receipts: [],
          completion: {
            message: agent.status().outcome,
            success: agent.status().outcome === "completed",
          },
          diagnostics: agent.status().diagnostics,
          exact: true,
        }).catch(() => undefined);
      }
      if (agent.status().outcome === "unverified") process.exitCode = 2;
      return;
    }

    console.log(chalk.dim(localize(language, "交互模式 · 输入 / 查看命令 · Ctrl+C 或 /exit 退出\n", "Interactive mode · type / for commands · Ctrl+C or /exit to quit\n")));
    const inputHistory: string[] = [];
    let awaitingReply: { question: string; originalTask: string } | undefined;
    const promptFooter = (): string => {
      const dashboard = agent.status();
      const agentRuns = coordinator.list();
      const plan = planManager.snapshot();
      const activeStep = plan?.steps.find((step) => step.status === "in_progress") ?? plan?.steps.find((step) => step.status === "pending");
      return formatPromptDashboard({
        model: `${config.providerId}/${dashboard.model}`,
        contextTokens: dashboard.stats.estimatedTokens,
        contextLimit: dashboard.contextLimit,
        skills: skillRegistry.list().length,
        cwd: config.cwd,
        planMode: dashboard.planMode,
        mcpTools: mcpManager.tools().length,
        agents: agentRuns.reduce((count, run) => count + run.tasks.filter((task) => task.status === "running").length, 0),
        backgroundTasks: listBackgroundProcesses().filter((item) => item.running).length,
        phase: activeStep ? `${activeStep.status}:${activeStep.title}` : undefined,
        language,
      });
    };

    const chooseRuntimeLanguage = async (command: string): Promise<UiLanguage | undefined> => {
      const requested = command.slice("/language".length).trim();
      if (requested) {
        try { return normalizeLanguage(requested); }
        catch (error) {
          console.error(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
          return undefined;
        }
      }
      return await selectTerminalOption(localize(language, "选择界面与会话语言", "Choose interface and conversation language"), [
        { label: "简体中文", description: localize(language, "界面、进展、计划和模型回复使用中文", "Use Chinese for UI, progress, plans, and model responses"), value: "zh-CN" as const },
        { label: "English", description: localize(language, "界面、进展、计划和模型回复使用英文", "Use English for UI, progress, plans, and model responses"), value: "en-US" as const },
      ], language);
    };

    const applyRuntimeLanguage = async (selected: UiLanguage, redrawScreen: boolean): Promise<void> => {
      language = selected;
      agent.setLanguage(selected);
      if (runningTaskView) {
        runningTaskView.setLanguage(selected);
        agent.steer(localize(selected,
          "运行时语言已切换为简体中文。继续原始任务，并确保后续所有用户可见的进展、问题和最终回答使用简体中文。",
          "The runtime language changed to English. Continue the original task and use English for all subsequent user-visible progress, questions, and the final answer."));
      }
      settings.language = selected;
      await settingsStore.save(settings);
      if (redrawScreen) {
        if (process.stdout.isTTY) console.clear();
        renderWelcome(config, packageJson.version, skillRegistry.list().length);
        console.log(chalk.dim(localize(language, "交互模式 · 输入 / 查看命令 · Ctrl+C 或 /exit 退出\n", "Interactive mode · type / for commands · Ctrl+C or /exit to quit\n")));
      }
      console.log(chalk.green(localize(language, `语言已立即切换为${languageName(selected, language)}。当前界面、进度、命令和下一次模型调用均已更新。\n`, `Language switched immediately to ${languageName(selected, language)}. The current UI, progress, commands, and next model call are updated.\n`)));
    };

    const runTaskSequence = async (firstTask: string, firstDisplay?: Pick<SessionReplayTurn, "task" | "inputKind">): Promise<boolean> => {
      const queue = new TaskInputQueue();
      queue.enqueue(firstTask);
      let exitRequested = false;
      let first = true;

      while (queue.size && !exitRequested) {
        const current = queue.dequeue()!;
        const replayInput = first && firstDisplay ? firstDisplay : { task: current.text, inputKind: "task" as const };
        first = false;
        const replayChanges: WorkspaceChangeNotice[] = [];
        const replaySupplements: string[] = [];
        verificationReadyForSummary = false;
        const skillsBeforeTask = new Set(skillRegistry.list().map((skill) => skill.name.toLowerCase()));
        const view = new RunningTaskView(256_000, language);
        const existingPlan = planManager.snapshot();
        view.setPlan(existingPlan?.steps.some((step) => step.status !== "completed") ? existingPlan : undefined);
        runningTaskView = view;
        let settled = false;
        let failure: unknown;
        let finalResponse = "";
        const runPromise = agent.run(current.text)
          .then((response) => { finalResponse = response; })
          .catch((error) => { failure = error; })
          .finally(() => {
            settled = true;
            activeQueuedInputController?.abort();
          });

        while (!settled) {
          const inputController = new AbortController();
          activeQueuedInputController = inputController;
          let cancelledFromKeyboard = false;
          const queuedDraft = await draftStore.load();
          const followUp = (await readInteractiveInput(localize(language, "补充> ", "steer> "), slashCommands(language), inputHistory, () => {
            const runningStatus = agent.status();
            view.setDiagnostics(runningStatus.diagnostics);
            return formatRunningInputFooter(view, queue.size, runningStatus.pendingSteering, promptFooter());
          }, {
            paths: projectIndex.paths("", 1_000),
            initialValue: queuedDraft,
            onChange: (value) => { void draftStore.save(value); },
            onCancel: () => {
              cancelledFromKeyboard = true;
              view.setPhase(localize(language, "正在取消", "Cancelling"));
              view.activity(localize(language, "用户按下 Ctrl+C，正在中止当前模型或工具调用", "Ctrl+C pressed; aborting the active model or tool call"));
              agent.cancel();
            },
            onToggleDetails: () => { view.toggleDetails(); },
            onPaste: () => clipboard.paste(),
            enableRightClickPaste: rightClickPasteEnabled,
            signal: inputController.signal,
            refreshMs: 250,
            language,
            persistPrompt: false,
          })).trim();
          if (activeQueuedInputController === inputController) activeQueuedInputController = undefined;
          const liveChanges = view.drainWorkspaceChanges();
          replayChanges.push(...liveChanges);
          printWorkspaceChanges(liveChanges);
          await draftStore.flush();
          await activeApproval;
          if (cancelledFromKeyboard) {
            console.log(chalk.yellow(localize(language, "正在取消当前任务，排队任务会保留。\n", "Cancelling current task. Queued follow-ups are preserved.\n")));
            break;
          }
          if (!followUp && settled) break;
          if (!followUp) continue;
          inputHistory.push(followUp);

          if (followUp === "/cancel") {
            agent.cancel();
            console.log(chalk.yellow(localize(language, "正在取消当前任务，排队任务会保留。\n", "Cancelling current task. Queued follow-ups are preserved.\n")));
            break;
          }
          if (followUp === "/exit" || followUp === "/quit") {
            exitRequested = true;
            queue.clear();
            agent.cancel();
            console.log(chalk.yellow(localize(language, "退出前正在取消当前任务。\n", "Cancelling current task before exit.\n")));
            break;
          }
          if (followUp === "/queue") {
            const pending = queue.list();
            console.log(pending.length
              ? `${chalk.cyan(localize(language, "排队任务", "Queued follow-ups"))}\n${pending.map((item, index) => `${index + 1}. ${item.text.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")}\n`
              : chalk.dim(localize(language, "后续任务队列为空。\n", "The follow-up queue is empty.\n")));
            continue;
          }
          if (followUp.startsWith("/queue ")) {
            try {
              const queued = queue.enqueue(followUp.slice("/queue ".length));
              console.log(chalk.green(localize(language, `已安排下一项 ${queued.id}：${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`, `Scheduled next ${queued.id}: ${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`)));
            } catch (error) {
              console.error(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
            }
            continue;
          }
          if (followUp === "/clear-queue") {
            const cleared = queue.clear();
            console.log(chalk.dim(localize(language, `已清空 ${cleared} 个排队任务。\n`, `Cleared ${cleared} queued follow-up(s).\n`)));
            continue;
          }
          if (followUp === "/language" || followUp.startsWith("/language ")) {
            const selected = await chooseRuntimeLanguage(followUp);
            if (!selected) console.log(chalk.dim(localize(language, "已取消语言选择。\n", "Language selection cancelled.\n")));
            else await applyRuntimeLanguage(selected, false);
            continue;
          }
          if (followUp === "/status") {
            const currentStatus = agent.status();
            const turnStatus = currentStatus.maxTurns ? `${currentStatus.turn}/${currentStatus.maxTurns}` : `${currentStatus.turn}`;
            console.log(chalk.dim(localize(language, `运行中：第 ${turnStatus} 轮 | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)} 秒 | ${currentStatus.pendingSteering} 条补充 | ${queue.size} 个排队 | ${currentStatus.stats.modelCalls} 次模型调用 | ${currentStatus.stats.toolCalls} 次工具调用${currentStatus.diagnostics ? `\n诊断：${formatTaskDiagnosticSummary(currentStatus.diagnostics, language)}` : ""}\n`, `Working: turn ${turnStatus} | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)}s | ${currentStatus.pendingSteering} steering | ${queue.size} queued | ${currentStatus.stats.modelCalls} model call(s) | ${currentStatus.stats.toolCalls} tool call(s)${currentStatus.diagnostics ? `\nDiagnostics: ${formatTaskDiagnosticSummary(currentStatus.diagnostics, language)}` : ""}\n`)));
            continue;
          }
          if (followUp === "/diagnostics") {
            console.log(`${formatTaskDiagnostics(agent.status().diagnostics, language)}\n`);
            continue;
          }
          if (followUp === "/credentials" || followUp === "/credentials status") {
            try { await printCredentialStatus(); }
            catch (error) { console.error(chalk.red(`${localize(language, "读取凭证状态失败", "Could not read credential status")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
            continue;
          }
          if (followUp === "/credentials probe") {
            console.log(chalk.dim(localize(language, "/credentials probe 请在当前任务结束后执行。\n", "Run /credentials probe after the current task finishes.\n")));
            continue;
          }
          if (followUp.startsWith("/credentials migrate") || followUp.startsWith("/credentials cleanup") || followUp.startsWith("/credentials rollback") || followUp.startsWith("/credentials forget")) {
            console.log(chalk.dim(localize(language, "凭证修改请在当前任务结束后执行。\n", "Change credentials after the current task finishes.\n")));
            continue;
          }
          if (followUp === "/paste") {
            try {
              const pasted = await clipboard.paste();
              await draftStore.save(pasted.insertText);
              await draftStore.flush();
              console.log(chalk.green(`${pasted.notice ?? localize(language, "剪贴板内容已加入输入草稿。", "Clipboard content added to the input draft.")}\n`));
            } catch (error) {
              console.error(chalk.red(`${localize(language, "剪贴板粘贴失败", "Clipboard paste failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
            }
            continue;
          }
          if (followUp === "/details") {
            const visible = view.toggleDetails();
            console.log(chalk.dim(localize(language, `实时视图已切换为${visible ? "详细工具活动" : "任务步骤摘要"}，Ctrl+O 可直接切换。\n`, `Live view switched to ${visible ? "detailed tool activity" : "task step summary"}. Ctrl+O toggles it without submitting the prompt.\n`)));
            continue;
          }

          if (!settled && agent.steer(followUp)) {
            replaySupplements.push(followUp);
            view.activity(localize(language, `已接受用户补充：${followUp.slice(0, 100)}`, `User steering accepted: ${followUp.slice(0, 100)}`));
            console.log(chalk.green(localize(language, `\u21B3 已补充当前任务：${followUp.replace(/\s+/g, " ").slice(0, 100)}\n`, `\u21B3 Steering current task: ${followUp.replace(/\s+/g, " ").slice(0, 100)}\n`)));
          } else {
            try {
              const queued = queue.enqueue(followUp);
              console.log(chalk.green(localize(language, `当前任务已结束，已安排 ${queued.id}：${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`, `Current task already ended; scheduled ${queued.id}: ${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`)));
            } catch (error) {
              console.error(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
            }
          }
        }

        await runPromise;
        if (activeQueuedInputController) {
          activeQueuedInputController.abort();
          activeQueuedInputController = undefined;
        }
        runningTaskView = undefined;
        const refreshedSkills = await skillRegistry.refresh(true);
        agent.reloadInstructions();
        const discoveredSkills = refreshedSkills.filter((skill) => !skillsBeforeTask.has(skill.name.toLowerCase()));
        if (discoveredSkills.length) console.log(chalk.green(localize(language, `已发现并加载新技能：${discoveredSkills.map((skill) => skill.name).join("、")}。`, `Discovered and loaded new skill(s): ${discoveredSkills.map((skill) => skill.name).join(", ")}.`)));
        const finalChanges = view.drainWorkspaceChanges();
        replayChanges.push(...finalChanges);
        printWorkspaceChanges(finalChanges);
        view.discard();
        const receipts = view.receiptLines();
        if (receipts.length) console.log(`${chalk.cyan(localize(language, "关键操作", "Key actions"))}\n${receipts.map((line) => chalk.green(line)).join("\n")}\n`);
        const interaction = parseAssistantInteraction(finalResponse, language);
        finalResponse = interaction.text;
        if (interaction.question) await agent.markWaitingForUser(interaction.question);
        if (finalResponse.trim()) console.log(`${chalk.cyan.bold("Xiu")}\n${renderTerminalMarkdown(finalResponse)}\n`);
        awaitingReply = interaction.question ? { question: interaction.question, originalTask: current.text } : undefined;
        if (interaction.question) printUserQuestion(interaction.question);
        const completion = view.completionSummary();
        if (completion && !interaction.question) {
          console.log(completion.success ? chalk.green(completion.message) : chalk.yellow(completion.message));
          console.log(chalk.dim("─".repeat(Math.max(20, Math.min((process.stdout.columns || 100) - 2, 120)))));
        } else if (interaction.question) {
          console.log(chalk.yellow(localize(language, "等待你的回答 · 当前上下文已保存", "Waiting for your answer · current context saved")));
          console.log(chalk.dim("─".repeat(Math.max(20, Math.min((process.stdout.columns || 100) - 2, 120)))));
        }
        await agent.recordReplayTurn({
          ...replayInput,
          supplements: replaySupplements,
          response: finalResponse,
          changes: replayChanges,
          receipts,
          question: interaction.question,
          completion,
          diagnostics: agent.status().diagnostics,
          exact: true,
        });
        if (!failure && agent.status().outcome === "unverified") failure = new Error(localize(language, "任务修改了文件，但没有通过验证。", "The task changed files but no verification passed."));
        if (!failure && agent.status().outcome === "failed") failure = new Error(localize(language, "最后一次工具操作失败或被拒绝，目标尚未完成。", "The last tool operation failed or was denied, so the goal is incomplete."));
        if (!failure && agent.status().outcome === "paused") failure = new Error(localize(language, "任务已在安全恢复点暂停。处理预算或审批要求后，使用 /recover 继续。", "The task paused at a safe recovery point. Address its budget or approval requirement, then use /recover to continue."));
        if (failure && !exitRequested) {
          console.error(chalk.red(`${localize(language, "任务已停止", "Task stopped")}: ${failure instanceof Error ? failure.message : String(failure)}\n`));
          const action = await selectTerminalOption(localize(language, "当前任务未完成，下一步怎么做？", "The current task did not complete. What next?"), failureRecoveryOptions(queue.size, language), language);
          if (action === "retry") {
            queue.prepend(`Continue the unfinished task from the existing evidence. Do not restart the investigation or repeat successful reads. Original goal: ${current.text}`);
          } else if (action !== "continue") {
            const cleared = queue.clear();
            if (cleared) console.log(chalk.dim(localize(language, `已清空 ${cleared} 个排队任务。\n`, `Cleared ${cleared} scheduled task(s).\n`)));
          }
        } else if (queue.size && !exitRequested) {
          console.log(chalk.cyan(localize(language, `继续运行 ${queue.size} 个明确安排的任务。\n`, `Continuing with ${queue.size} explicitly scheduled task(s).\n`)));
        }
      }
      return exitRequested;
    };

    if (confirmedRecoveryTask && recoverySource) {
      console.log(chalk.cyan(localize(language, "已确认恢复。Xiu 将先核验中断时状态未知的操作，再继续原任务。\n", "Recovery confirmed. Xiu will verify operations left in an unknown state before continuing.\n")));
      const exitAfterRecovery = await runTaskSequence(confirmedRecoveryTask, {
        task: localize(language, `恢复中断任务：${recoverySource.taskPreview}`, `Recover interrupted task: ${recoverySource.taskPreview}`),
        inputKind: "system",
      });
      if (exitAfterRecovery) return;
      confirmedRecoveryTask = undefined;
      recoverySource = undefined;
    }

    while (true) {
      const task = (await readInteractiveInput(awaitingReply ? localize(language, "请回答> ", "answer> ") : "xiu> ", slashCommands(language), inputHistory, promptFooter, {
        paths: projectIndex.paths("", 1_000),
        initialValue: restoredDraft,
        onChange: (value) => { void draftStore.save(value); },
        onPaste: () => clipboard.paste(),
        enableRightClickPaste: rightClickPasteEnabled,
        language,
      })).trim();
      await draftStore.flush();
      restoredDraft = await draftStore.load();
      if (!task) continue;
      inputHistory.push(task);
      if (task === "/mcp" || task.startsWith("/mcp ")) {
        await ensureMcpReady();
        if (mcpConfigError) {
          console.log(chalk.yellow(localize(language, `未加载 MCP 配置：${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`, `MCP configuration was not loaded: ${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`)));
        }
      }
      if (task === "/exit" || task === "/quit") break;
      if (task === "/recover") {
        let interrupted: InterruptedTaskRun | undefined;
        try { interrupted = await taskRunJournal.interrupted(); }
        catch (error) {
          console.error(chalk.red(`${localize(language, "任务恢复日志无法读取", "Could not read the task recovery journal")}: ${error instanceof Error ? error.message : String(error)}\n`));
          continue;
        }
        if (!interrupted) {
          console.log(chalk.dim(localize(language, "当前工作区没有异常中断任务。\n", "There is no interrupted task in this workspace.\n")));
          continue;
        }
        const action = await selectTerminalOption(localize(language, "如何处理异常中断任务？", "How should the interrupted task be handled?"), [
          { label: localize(language, "确认恢复", "Resume after confirmation"), description: localize(language, "先核验未知副作用，再继续", "Verify unknown side effects before continuing"), value: "resume" as const },
          { label: localize(language, "放弃旧任务", "Abandon old task"), description: localize(language, "不重放任何操作", "Do not replay any operation"), value: "abandon" as const },
        ], language);
        if (action === "abandon") {
          await taskRunJournal.abandon(interrupted.runId);
          console.log(chalk.green(localize(language, "旧任务已放弃；没有重放任何操作。\n", "The old task was abandoned; no operation was replayed.\n")));
          continue;
        }
        if (action !== "resume") continue;
        let selected: RestoredSession;
        try { selected = await loadSession(config.cwd, interrupted.sessionId); }
        catch (error) {
          console.error(chalk.red(`${localize(language, "无法加载关联会话", "Could not load the linked session")}: ${error instanceof Error ? error.message : String(error)}\n`));
          continue;
        }
        if (selected.providerId && selected.providerId !== config.providerId) {
          const selectedProfile = providerRegistry.get(selected.providerId);
          if (!selectedProfile || !(await switchProviderProfile(selectedProfile, false, selected.model))) {
            console.log(chalk.yellow(localize(language, "无法恢复该会话使用的 Provider，恢复记录保持不变。\n", "Could not restore the session provider; the recovery record was preserved.\n")));
            continue;
          }
        }
        agent.restoreSession(selected);
        agent.setRecoverySource(interrupted);
        renderReplay(selected);
        await runTaskSequence(recoveryContinuation(interrupted, language), {
          task: localize(language, `恢复中断任务：${interrupted.taskPreview}`, `Recover interrupted task: ${interrupted.taskPreview}`),
          inputKind: "system",
        });
        continue;
      }
      if (task === "/resume") {
        const selected = await chooseSession(config.cwd, language);
        if (!selected) console.log(chalk.dim(localize(language, "未选择会话。\n", "No session selected.\n")));
        else {
          if (selected.providerId && selected.providerId !== config.providerId) {
            const selectedProfile = providerRegistry.get(selected.providerId);
            if (!selectedProfile || !(await switchProviderProfile(selectedProfile, false, selected.model))) {
              console.log(chalk.yellow(localize(language, "无法恢复该会话使用的 Provider，会话未切换。\n", "Could not restore the session provider; the session was not changed.\n")));
              continue;
            }
          }
          agent.restoreSession(selected);
          awaitingReply = undefined;
          renderReplay(selected);
        }
        continue;
      }
      if (task === "/media") {
        const records = await new MediaOperationStore(config.cwd).list(30);
        if (!records.length) {
          console.log(chalk.dim(localize(language, "当前项目还没有媒体生成记录。\n", "This project has no media generation records yet.\n")));
          continue;
        }
        const statusLabel = (record: MediaOperationRecord): string => {
          const labels: Record<MediaOperationRecord["status"], [string, string]> = {
            submitting: ["提交结果未知", "submission unknown"],
            submitted: ["等待生成", "generation pending"],
            asset_ready: ["等待下载", "download pending"],
            completed: ["已完成", "completed"],
            ambiguous: ["结果不明确", "ambiguous"],
            failed: ["已失败", "failed"],
          };
          return localize(language, ...labels[record.status]);
        };
        console.log(chalk.cyan(localize(language, "媒体生成与恢复任务", "Media generation and recovery tasks")));
        for (const record of records) {
          const details = [
            record.kind === "image" ? localize(language, "图片", "image") : localize(language, "视频", "video"),
            statusLabel(record),
            `${record.providerId}/${record.model}`,
            record.taskId ? `task ${record.taskId}` : undefined,
            record.savedPath ? localize(language, `已保存 ${record.savedPath}`, `saved ${record.savedPath}`) : undefined,
          ].filter(Boolean).join(" · ");
          const color = record.status === "completed" ? chalk.green : record.status === "failed" || record.status === "ambiguous" || record.status === "submitting" ? chalk.yellow : chalk.cyan;
          console.log(`${color(`[${record.requestId.slice(0, 8)}]`)} ${details}`);
        }
        console.log(chalk.dim(localize(language,
          "\n需要恢复时，请输入“恢复媒体请求 <ID> 到 <工作区路径>”。恢复只会复用缓存、继续轮询或重新下载，不会创建新的付费请求。\n",
          "\nTo recover one, enter “resume media request <ID> to <workspace path>”. Recovery only reuses cache, continues polling, or retries a download; it never creates a new billable request.\n",
        )));
        continue;
      }
      if (task === "/providers") {
        const profiles = providerRegistry.list();
        const selected = await selectTerminalOption(localize(language, "选择 Provider", "Choose a provider"), profiles.map((profile) => ({
          label: `${profile.name}${profile.id === config.providerId ? localize(language, "（当前）", " (current)") : ""}`,
          description: `${profile.id} · ${profile.kind} · ${profile.model} · ${featureNames(profile)} · ${compactCapabilityProbeSummary(profile)}`,
          value: profile.id,
        })), language);
        if (!selected) console.log(chalk.dim(localize(language, "已取消 Provider 选择。\n", "Provider selection cancelled.\n")));
        else if (selected === config.providerId) console.log(chalk.dim(localize(language, `当前已是 ${selected}。\n`, `${selected} is already active.\n`)));
        else await switchProviderProfile(providerRegistry.get(selected)!);
        continue;
      }
      if (task === "/routing" || task.startsWith("/routing ")) {
        const action = task.slice("/routing".length).trim();
        const phaseLabels: Record<string, string> = {
          planning: localize(language, "规划", "planning"),
          implementation: localize(language, "实现", "implementation"),
          verification: localize(language, "验证", "verification"),
        };
        if (!action) {
          const policy = providerRegistry.routingPolicy();
          console.log(chalk.cyan(localize(language, `阶段路由：${policy.enabled ? "已启用" : "已停用"}`, `Stage routing: ${policy.enabled ? "enabled" : "disabled"}`)));
          for (const phase of PROVIDER_ROUTING_PHASES) {
            const id = policy.phases[phase];
            const profile = id ? providerRegistry.get(id) : undefined;
            console.log(`  ${phaseLabels[phase]}: ${profile ? `${profile.name} (${id}/${providerRegistry.activeModel(id!) ?? profile.model})` : localize(language, "跟随当前 Provider", "use the current provider")}`);
          }
          console.log(chalk.dim(localize(language, "自动路由只在模型请求边界切换；能力或上下文不满足时会保留当前模型。任务结束后恢复用户手动选择。\n", "Automatic routing only switches at model-request boundaries. Xiu keeps the current model when capabilities or context are insufficient, and restores the user's manual selection after the task.\n")));
          continue;
        }
        if (action === "on" || action === "off") {
          await providerRegistry.setRoutingEnabled(action === "on");
          console.log(chalk.green(localize(language, `阶段路由已${action === "on" ? "启用" : "停用"}。\n`, `Stage routing ${action === "on" ? "enabled" : "disabled"}.\n`)));
          continue;
        }
        const match = /^(set|clear)\s+(planning|implementation|verification)$/.exec(action);
        if (match) {
          const operation = match[1]!;
          const phase = match[2]!;
          if (!isProviderRoutingPhase(phase)) continue;
          if (operation === "clear") {
            await providerRegistry.setRoutingPhase(phase);
            console.log(chalk.green(localize(language, `已清除${phaseLabels[phase]}阶段的 Provider。\n`, `Cleared the provider for the ${phase} stage.\n`)));
            continue;
          }
          const selected = await selectTerminalOption(localize(language, `为${phaseLabels[phase]}阶段选择 Provider`, `Choose a provider for the ${phase} stage`), providerRegistry.list().map((profile) => ({
            label: profile.name,
            description: `${profile.id} · ${providerRegistry.activeModel(profile.id) ?? profile.model} · ${featureNames(profile)}`,
            value: profile.id,
          })), language);
          if (!selected) console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n")));
          else {
            await providerRegistry.setRoutingPhase(phase, selected);
            console.log(chalk.green(localize(language, `已将${phaseLabels[phase]}阶段绑定到 ${selected}。使用 /routing on 启用。\n`, `Assigned the ${phase} stage to ${selected}. Enable it with /routing on.\n`)));
          }
          continue;
        }
        console.log(chalk.yellow(localize(language, "用法：/routing [on|off|set <planning|implementation|verification>|clear <planning|implementation|verification>]\n", "Usage: /routing [on|off|set <planning|implementation|verification>|clear <planning|implementation|verification>]\n")));
        continue;
      }
      if (task === "/provider test" || task === "/provider capabilities") {
        const profile = providerRegistry.get(config.providerId) ?? startupProfile;
        await switchProviderProfile(profile, true, agent.status().model, true);
        continue;
      }
      if (task === "/provider fallback" || task.startsWith("/provider fallback ")) {
        const primaryId = config.providerId;
        const action = task.slice("/provider fallback".length).trim();
        const chain = providerRegistry.failoverChain(primaryId);
        if (!action) {
          console.log(chalk.cyan(localize(language, `主 Provider：${primaryId}`, `Primary provider: ${primaryId}`)));
          console.log(chain.length
            ? `${chain.map((id, index) => `${index + 1}. ${providerRegistry.get(id)?.name ?? id} (${id})`).join("\n")}\n`
            : chalk.dim(localize(language, "尚未配置备用链。使用 /provider fallback add 添加。\n", "No failover chain is configured. Add one with /provider fallback add.\n")));
          continue;
        }
        if (action === "clear") {
          await providerRegistry.setFailoverChain(primaryId, []);
          console.log(chalk.green(localize(language, `已清空 ${primaryId} 的备用链。\n`, `Cleared the failover chain for ${primaryId}.\n`)));
          continue;
        }
        if (action === "add") {
          const candidates = providerRegistry.list().filter((profile) => profile.id !== primaryId && !chain.includes(profile.id));
          if (!candidates.length) {
            console.log(chalk.dim(localize(language, "没有可添加的 Provider。\n", "There are no providers available to add.\n")));
            continue;
          }
          const selected = await selectTerminalOption(localize(language, "选择要追加的备用 Provider", "Choose a fallback provider to append"), candidates.map((profile) => ({
            label: profile.name,
            description: `${profile.id} · ${profile.model} · ${featureNames(profile)} · ${compactCapabilityProbeSummary(profile)}`,
            value: profile.id,
          })), language);
          if (!selected) console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n")));
          else {
            await providerRegistry.setFailoverChain(primaryId, [...chain, selected]);
            console.log(chalk.green(localize(language, `已将 ${selected} 添加为第 ${chain.length + 1} 顺位备用 Provider。\n`, `Added ${selected} as fallback provider #${chain.length + 1}.\n`)));
          }
          continue;
        }
        if (action === "remove") {
          if (!chain.length) {
            console.log(chalk.dim(localize(language, "备用链为空。\n", "The failover chain is empty.\n")));
            continue;
          }
          const selected = await selectTerminalOption(localize(language, "移除哪个备用 Provider？", "Remove which fallback provider?"), chain.map((id, index) => ({
            label: providerRegistry.get(id)?.name ?? id,
            description: localize(language, `第 ${index + 1} 顺位 · ${id}`, `Position ${index + 1} · ${id}`),
            value: id,
          })), language);
          if (!selected) console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n")));
          else {
            await providerRegistry.setFailoverChain(primaryId, chain.filter((id) => id !== selected));
            console.log(chalk.green(localize(language, `已从备用链移除 ${selected}。\n`, `Removed ${selected} from the failover chain.\n`)));
          }
          continue;
        }
        console.log(chalk.yellow(localize(language, "用法：/provider fallback [add|remove|clear]\n", "Usage: /provider fallback [add|remove|clear]\n")));
        continue;
      }
      if (task === "/provider key") {
        const profiles = providerRegistry.list();
        const selected = await selectTerminalOption(localize(language, "为哪个 Provider 保存 Key？", "Save a key for which provider?"), profiles.map((profile) => ({
          label: profile.name,
          description: `${profile.id} · ${profile.apiKey ? localize(language, "已有本地 Key", "local key saved") : profile.apiKeyEnv ? `${localize(language, "环境变量", "environment")}: ${profile.apiKeyEnv}` : localize(language, "未配置 Key", "no key configured")}`,
          value: profile.id,
        })), language);
        if (!selected) {
          console.log(chalk.dim(localize(language, "已取消 Key 配置。\n", "Key configuration cancelled.\n")));
          continue;
        }
        try {
          const apiKey = await askSecret(localize(language, "输入 API Key（输入内容不会显示）：", "API key (input is hidden): "));
          if (!apiKey) throw new Error(localize(language, "API Key 不能为空。", "API key cannot be empty."));
          await providerRegistry.setApiKey(selected, apiKey);
          console.log(chalk.green(localize(language, `Key 已保存到本机 Xiu 配置，正在测试 ${selected}……`, `Key saved in the local Xiu configuration. Testing ${selected}...`)));
          if (selected === config.providerId) await switchProviderProfile(providerRegistry.get(selected)!, true, config.model);
          else console.log(chalk.dim(localize(language, "切换到该 Provider 时会使用此 Key。\n", "This key will be used when that provider is selected.\n")));
        } catch (error) {
          console.error(chalk.red(`${localize(language, "保存 Key 失败", "Could not save key")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/provider add") {
        console.log(chalk.cyan(localize(language, "添加 OpenAI-compatible Provider（Key 可保存在本机配置，也可使用环境变量）", "Add an OpenAI-compatible provider (save the key locally or use an environment variable)")));
        try {
          const id = (await askQuestion(localize(language, "Provider ID：", "Provider ID: "))).trim();
          const name = (await askQuestion(localize(language, "显示名称：", "Display name: "))).trim() || id;
          const baseURL = (await askQuestion(localize(language, "API Base URL（需包含 /v1）：", "API base URL (include /v1): "))).trim();
          const model = (await askQuestion(localize(language, "默认模型 ID：", "Default model ID: "))).trim();
          const apiKeyEnv = (await askQuestion(localize(language, "密钥环境变量名（本地无认证可留空）：", "API-key environment variable (blank for unauthenticated local servers): "))).trim() || undefined;
          const apiKey = await askSecret(localize(language, "本地保存的 API Key（可留空，输入内容不会显示）：", "Locally saved API key (optional; input is hidden): ")) || undefined;
          const contextText = (await askQuestion(localize(language, "上下文窗口 Token 数（留空使用 128K）：", "Context-window tokens (blank for 128K): "))).trim();
          const visionText = (await askQuestion(localize(language, "该端点和模型确认支持视觉？[y/N]：", "Does this endpoint and model definitely support vision? [y/N]: "))).trim();
          const profile: ProviderProfile = {
            id, name, kind: "openai-compatible", model, baseURL, apiKeyEnv, apiKey,
            contextWindow: contextText ? Number(contextText) : undefined,
            features: { text: true, tools: true, vision: /^(y|yes)$/i.test(visionText), image: false, video: false },
          };
          await providerRegistry.upsert(profile);
          console.log(chalk.green(localize(language, `已保存 Provider ${id}。正在进行连接测试……`, `Saved provider ${id}. Testing the connection...`)));
          await switchProviderProfile(providerRegistry.get(id)!);
        } catch (error) {
          console.error(chalk.red(`${localize(language, "添加 Provider 失败", "Could not add provider")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/provider edit") {
        const editable = providerRegistry.list().filter((profile) => !profile.builtin);
        if (!editable.length) {
          console.log(chalk.dim(localize(language, "没有可编辑的自定义 Provider。请先使用 /provider add 添加。\n", "There are no custom providers to edit. Add one with /provider add first.\n")));
          continue;
        }
        const selected = await selectTerminalOption(localize(language, "编辑哪个 Provider？", "Edit which provider?"), editable.map((profile) => ({
          label: profile.name, description: `${profile.id} · ${profile.model} · ${profile.baseURL ?? ""}`, value: profile.id,
        })), language);
        if (!selected) {
          console.log(chalk.dim(localize(language, "已取消编辑。\n", "Editing cancelled.\n")));
          continue;
        }
        const current = providerRegistry.get(selected)!;
        console.log(chalk.cyan(localize(language, "直接回车保留当前值；环境变量名或上下文窗口输入 - 可清空。本地 Key 请使用 /provider key 单独修改。", "Press Enter to keep the current value. Enter - to clear the environment variable or context window. Use /provider key to change the local key.")));
        try {
          const nameText = (await askQuestion(localize(language, `显示名称 [${current.name}]：`, `Display name [${current.name}]: `))).trim();
          const baseURLText = (await askQuestion(localize(language, `API Base URL [${current.baseURL ?? ""}]：`, `API base URL [${current.baseURL ?? ""}]: `))).trim();
          const modelText = (await askQuestion(localize(language, `默认模型 ID [${current.model}]：`, `Default model ID [${current.model}]: `))).trim();
          const envText = (await askQuestion(localize(language, `密钥环境变量名 [${current.apiKeyEnv ?? "未设置"}]：`, `API-key environment variable [${current.apiKeyEnv ?? "not set"}]: `))).trim();
          const contextText = (await askQuestion(localize(language, `上下文窗口 Token 数 [${current.contextWindow ?? "默认"}]：`, `Context-window tokens [${current.contextWindow ?? "default"}]: `))).trim();
          const visionDefault = current.features.vision ? "Y/n" : "y/N";
          const visionText = (await askQuestion(localize(language, `确认支持视觉？[${visionDefault}]：`, `Confirmed vision support? [${visionDefault}]: `))).trim();
          const updated: ProviderProfile = {
            ...current,
            name: nameText || current.name,
            baseURL: baseURLText || current.baseURL,
            model: modelText || current.model,
            apiKeyEnv: envText === "-" ? undefined : envText || current.apiKeyEnv,
            contextWindow: contextText === "-" ? undefined : contextText ? Number(contextText) : current.contextWindow,
            features: {
              ...current.features,
              vision: visionText ? /^(y|yes)$/i.test(visionText) : current.features.vision,
            },
          };
          await providerRegistry.upsert(updated);
          const saved = providerRegistry.get(selected)!;
          console.log(chalk.green(localize(language, `已更新 Provider ${selected}，本地 Key 保持不变。正在测试连接……`, `Updated provider ${selected}; the local key was preserved. Testing the connection...`)));
          if (selected === config.providerId) await switchProviderProfile(saved, true, saved.model);
          else {
            status.start(localize(language, `正在测试 ${saved.name} 连接`, `Testing ${saved.name}`));
            const probe = await probeProvider(profileConfig(saved));
            status.stop();
            console.log(chalk.green(localize(language, `连接成功：${saved.name}。`, `Connected successfully: ${saved.name}.`)));
            if (probe.discoveryError) console.log(chalk.dim(localize(language, "模型列表接口不可用；已通过最小聊天请求验证连接。\n", "The model-list endpoint is unavailable; connection verified with a minimal chat request.\n")));
            else console.log();
          }
        } catch (error) {
          status.stop();
          console.error(chalk.red(`${localize(language, "编辑 Provider 失败", "Could not edit provider")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/provider remove") {
        const removable = providerRegistry.list().filter((profile) => !profile.builtin);
        if (!removable.length) {
          console.log(chalk.dim(localize(language, "没有可删除的自定义 Provider。\n", "There are no custom providers to remove.\n")));
          continue;
        }
        const selected = await selectTerminalOption(localize(language, "删除哪个 Provider？", "Remove which provider?"), removable.map((profile) => ({
          label: profile.name, description: `${profile.id} · ${profile.baseURL ?? ""}`, value: profile.id,
        })), language);
        if (!selected) {
          console.log(chalk.dim(localize(language, "已取消删除。\n", "Removal cancelled.\n")));
          continue;
        }
        if (selected === config.providerId) {
          console.log(chalk.yellow(localize(language, "不能删除当前 Provider；请先切换到其他 Provider。\n", "The active provider cannot be removed; switch providers first.\n")));
          continue;
        }
        await providerRegistry.remove(selected);
        console.log(chalk.green(localize(language, `已删除 Provider ${selected}。\n`, `Removed provider ${selected}.\n`)));
        continue;
      }
      if (task === "/clear") {
        agent.clearConversation();
        awaitingReply = undefined;
        console.log(chalk.dim(localize(language, "对话上下文已清空。\n", "Conversation context cleared.\n")));
        continue;
      }
      if (task === "/history" || task === "/history current") {
        const currentSessionId = agent.status().sessionId;
        if (!currentSessionId) console.log(chalk.dim(localize(language, "没有对话历史。\n", "No conversation history.\n")));
        else renderReplay(await loadSession(config.cwd, currentSessionId));
        continue;
      }
      if (task === "/history sessions") {
        const sessions = await listSessions(config.cwd);
        console.log(sessions.length
          ? `${sessions.map((session) => `${session.id}  ${session.updatedAt}  ${session.firstTask.slice(0, 72)}`).join("\n")}\n`
          : localize(language, "没有已保存会话。\n", "No saved sessions.\n"));
        continue;
      }
      if (task === "/compact" || task.startsWith("/compact ")) {
        const focus = task.slice("/compact".length).trim();
        try { console.log(chalk.green(`${await agent.compact(focus || undefined)}\n`)); }
        catch (error) { status.stop(); console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`)); }
        finally { status.stop(); }
        continue;
      }
      if (task === "/plan" || task === "/tasks") {
        console.log(`${agent.plan()}\n`);
        continue;
      }
      if (task === "/plan on" || task === "/plan off") {
        const enabled = task.endsWith("on");
        await agent.setPlanMode(enabled);
        console.log(chalk.green(localize(language, `规划模式已${enabled ? "启用（只读）" : "关闭"}。\n`, `Plan mode ${enabled ? "enabled (read-only)" : "disabled"}.\n`)));
        continue;
      }
      if (task === "/diff") {
        console.log(`${await checkpointManager.diff()}\n`);
        continue;
      }
      if (task === "/paste") {
        try {
          const pasted = await clipboard.paste();
          restoredDraft = pasted.insertText;
          await draftStore.save(restoredDraft);
          await draftStore.flush();
          console.log(chalk.green(`${pasted.notice ?? localize(language, "剪贴板内容已加入输入草稿。", "Clipboard content added to the input draft.")}\n`));
        } catch (error) {
          console.error(chalk.red(`${localize(language, "剪贴板粘贴失败", "Clipboard paste failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/checkpoints") {
        const checkpoints = await checkpointManager.list();
        console.log(checkpoints.length
          ? `${checkpoints.map((checkpoint) => `${checkpoint.id}  ${checkpoint.tool}  ${checkpoint.files.map((file) => file.path).join(", ")}`).join("\n")}\n`
          : localize(language, "当前会话没有恢复点。\n", "No checkpoints in the current session.\n"));
        continue;
      }
      if (task === "/rewind") {
        const checkpoints = await checkpointManager.list();
        if (!checkpoints.length) {
          console.log(chalk.dim(localize(language, "当前会话没有恢复点。\n", "No checkpoints in the current session.\n")));
          continue;
        }
        const selected = await selectTerminalOption(localize(language, "恢复哪个检查点？", "Restore which checkpoint?"), checkpoints.map((checkpoint) => ({
          label: checkpoint.description,
          description: `${new Date(checkpoint.createdAt).toLocaleString()}  ${checkpoint.files.map((file) => file.path).join(", ")}`,
          value: checkpoint.id,
        })), language);
        if (!selected) {
          console.log(chalk.dim(localize(language, "已取消恢复。\n", "Restore cancelled.\n")));
          continue;
        }
        const answer = await askQuestion(chalk.bgRed.white.bold(" RESTORE ") + ` Restore files from checkpoint ${selected}? [y/N] `);
        if (!/^(y|yes)$/i.test(answer.trim())) {
          console.log(chalk.dim(localize(language, "已取消恢复。\n", "Restore cancelled.\n")));
          continue;
        }
        const restoredCheckpoint = await checkpointManager.restore(selected);
        projectIndex.invalidate();
        console.log(chalk.green(localize(language, `已从 ${restoredCheckpoint.id} 恢复：${restoredCheckpoint.files.map((file) => file.path).join(", ")}。\n`, `Restored ${restoredCheckpoint.files.map((file) => file.path).join(", ")} from ${restoredCheckpoint.id}.\n`)));
        continue;
      }
      if (task === "/models") {
        status.start(localize(language, "正在发现可用模型", "Discovering available models"));
        const available = await agent.listModels();
        status.stop();
        if (available.discoveryError) console.log(chalk.yellow(localize(language, `无法在线发现模型：${available.discoveryError}\n改为显示内置模型。\n`, `Live model discovery unavailable: ${available.discoveryError}\nShowing built-in models instead.\n`)));
        const current = agent.status().model;
        const currentProfile = providerRegistry.get(config.providerId) ?? startupProfile;
        const selected = await selectTerminalOption(localize(language, "选择模型", "Choose a model"), available.models.map((model) => ({
          label: `${model.id}${model.id === current ? localize(language, "（当前）", " (current)") : ""}`,
          description: [
            model.name && model.name !== model.id ? model.name : "",
            featureNames(currentProfile, model.id),
            capabilityProbeSummary(currentProfile, model.id),
            model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K ctx` : "",
            model.providerId,
            model.description ?? "",
            model.source,
          ].filter(Boolean).join("  ·  "),
          value: model.id,
        })), language);
        if (!selected || selected === current) console.log(chalk.dim(selected ? localize(language, `模型保持为 ${current}。\n`, `Model remains ${current}.\n`) : localize(language, "已取消模型选择。\n", "Model selection cancelled.\n")));
        else {
          await switchProviderProfile(currentProfile, true, selected);
        }
        continue;
      }
      if (task === "/language" || task.startsWith("/language ")) {
        const selected = await chooseRuntimeLanguage(task);
        if (!selected) {
          console.log(chalk.dim(localize(language, "已取消语言选择。\n", "Language selection cancelled.\n")));
          continue;
        }
        await applyRuntimeLanguage(selected, true);
        continue;
      }
      if (task === "/skills") {
        const skills = await skillRegistry.refresh(true);
        agent.reloadInstructions();
        if (!skills.length) {
          console.log(chalk.dim(localize(language, "没有已安装技能。使用 /skills install <本地路径或 HTTPS Git URL> 安装。\n", "No skills installed. Use /skills install <path-or-https-git-url>.\n")));
          continue;
        }
        const selected = await selectTerminalOption(localize(language, "已安装技能", "Installed skills"), skills.map((skill) => ({
          label: skill.name,
          description: `${skill.scope}  ${skill.permissions.join(", ")}  ${skill.description.slice(0, 80)}`,
          value: skill.name,
        })), language);
        if (selected) {
          const skill = skills.find((item) => item.name === selected)!;
          console.log(`${chalk.cyan(skill.name)} ${chalk.dim(`[${skill.scope}]`)}\n${skill.description}`);
          console.log(chalk.dim(localize(language, `权限：${skill.permissions.join("、")}${skill.permissionsDeclared ? "（已声明）" : "（兼容默认）"}`, `Permissions: ${skill.permissions.join(", ")} ${skill.permissionsDeclared ? "(declared)" : "(compatibility default)"}`)));
          if (skill.permissionWarnings.length) console.log(chalk.yellow(localize(language, `未知权限：${skill.permissionWarnings.join("、")}`, `Unknown permissions: ${skill.permissionWarnings.join(", ")}`)));
          console.log(`${chalk.dim(skill.file)}\n`);
        }
        continue;
      }
      if (task.startsWith("/skills install ")) {
        const source = task.slice("/skills install ".length).trim();
        if (!source) {
          console.log(chalk.yellow(localize(language, "用法：/skills install <本地路径或 HTTPS Git URL>\n", "Usage: /skills install <local-path-or-https-git-url>\n")));
          continue;
        }
        status.start(localize(language, "正在安装技能包", "Installing skill package"));
        try {
          const confirmSkillPermissions = async ({ manifest, added, replacing }: { manifest: { name: string; permissions: string[] }; added: string[]; replacing: boolean }) => {
            status.stop();
            const preview = localize(language,
              `${replacing ? "技能更新" : "新技能"} ${manifest.name} 请求以下新增权限：\n${added.map((permission) => `  + ${permission}`).join("\n")}\n权限声明不会绕过 Xiu 的工作区信任、审批或 Plan 模式。`,
              `${replacing ? "Skill update" : "New skill"} ${manifest.name} requests these additional permissions:\n${added.map((permission) => `  + ${permission}`).join("\n")}\nThe declaration cannot bypass Xiu workspace trust, approvals, or Plan mode.`);
            console.log(chalk.yellow(preview));
            const answer = await askQuestion(chalk.yellow(localize(language, "确认并继续安装？[y/N] ", "Acknowledge and continue installation? [y/N] ")));
            const accepted = /^(y|yes)$/i.test(answer.trim());
            if (accepted) status.start(localize(language, "正在安装技能包", "Installing skill package"));
            return accepted;
          };
          let installed;
          try { installed = await skillRegistry.install(source, false, confirmSkillPermissions); }
          catch (error) {
            status.stop();
            if (!/Skill already exists:/i.test(error instanceof Error ? error.message : String(error))) throw error;
            const answer = await askQuestion(chalk.yellow(localize(language, "技能已存在，是否备份后替换？[y/N] ", "Skill already exists. Back it up and replace it? [y/N] ")));
            if (!/^(y|yes)$/i.test(answer.trim())) {
              console.log(chalk.dim(localize(language, "已取消技能安装。\n", "Skill installation cancelled.\n")));
              continue;
            }
            status.start(localize(language, "正在替换技能包", "Replacing skill package"));
            installed = await skillRegistry.install(source, true, confirmSkillPermissions);
          }
          status.stop();
          agent.reloadInstructions();
          for (const skill of installed) {
            console.log(chalk.green(localize(language, `已安装技能 ${skill.name}`, `Installed skill ${skill.name}`)), chalk.dim(`-> ${skill.destination}`));
            console.log(chalk.dim(localize(language, `权限：${skill.permissions.join("、")}`, `Permissions: ${skill.permissions.join(", ")}`)));
            if (skill.backup) console.log(chalk.dim(localize(language, `旧版本已备份到 ${skill.backup}`, `Previous version backed up at ${skill.backup}`)));
          }
          console.log();
        } catch (error) {
          status.stop();
          console.error(chalk.red(`${localize(language, "技能安装失败", "Skill installation failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/mcp") {
        console.log(`${mcpManager.summary(language)}\n`);
        continue;
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
            if (!selected) { console.log(chalk.dim(localize(language, "没有待确认的 MCP 权限，或操作已取消。\n", "No MCP permissions await approval, or the operation was cancelled.\n"))); continue; }
            const manifest = manifests.find((item) => item.name === selected);
            if (!manifest) throw new Error(localize(language, `未找到 MCP ${selected}`, `MCP ${selected} was not found`));
            if (manifest.approved) {
              console.log(chalk.dim(localize(language, `MCP ${selected} 当前权限清单已经确认，无需重复操作。\n`, `MCP ${selected} already has approval for its current permission manifest.\n`)));
              continue;
            }
            console.log(chalk.yellow(localize(language,
              `MCP ${selected} 权限：\n${manifest.permissions.map((permission) => `  • ${permission}`).join("\n")}\n来源：${manifest.origin}\n确认只记录清单，不会绕过工具审批。`,
              `MCP ${selected} permissions:\n${manifest.permissions.map((permission) => `  • ${permission}`).join("\n")}\nSource: ${manifest.origin}\nApproval records the manifest only and cannot bypass tool approvals.`)));
            const answer = await askQuestion(chalk.yellow(localize(language, "确认此权限清单？[y/N] ", "Approve this permission manifest? [y/N] ")));
            if (!/^(y|yes)$/i.test(answer.trim())) { console.log(chalk.dim(localize(language, "已取消权限确认。\n", "Permission approval cancelled.\n"))); continue; }
            await mcpManager.approvePermissions(selected, projectMcpTrusted);
            await mcpManager.start(projectMcpTrusted);
            agent.replaceTools([...baseTools, ...mcpManager.tools()]);
            console.log(chalk.green(localize(language, `已确认 MCP ${selected} 权限并重新加载。\n`, `Approved MCP ${selected} permissions and reloaded it.\n`)));
            continue;
          }
          if (!manifests.length) console.log(chalk.dim(localize(language, "未配置 MCP 权限清单。\n", "No MCP permission manifests are configured.\n")));
          else console.log(`${manifests.filter((item) => !requested || item.name === requested).map((item) => [
            `${item.approved ? chalk.green("✓") : chalk.yellow("!")} ${chalk.cyan(item.name)} · ${item.origin} · ${item.declared ? localize(language, "显式声明", "declared") : localize(language, "兼容推导", "compatibility-derived")}`,
            `  ${localize(language, "权限", "Permissions")}: ${item.permissions.join(", ")}`,
            ...(item.details?.length ? [`  ${localize(language, "依据", "Basis")}: ${item.details.join(", ")}`] : []),
            ...(!item.approved ? [`  ${chalk.yellow(localize(language, `待确认变化：${item.added.join(", ") || "配置或清单指纹变化"}`, `Pending changes: ${item.added.join(", ") || "configuration or manifest fingerprint changed"}`))}`] : []),
          ].join("\n")).join("\n") }\n`);
        } catch (error) {
          console.error(chalk.red(`${localize(language, "MCP 权限操作失败", "MCP permission operation failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/mcp resources" || task.startsWith("/mcp resources ")) {
        const requested = task.trim().split(/\s+/)[2];
        const names = mcpManager.connectedServerNames();
        const name = requested ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); continue; }
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
        } catch (error) { console.error(chalk.red(`${localize(language, "读取 MCP 资源列表失败", "Failed to list MCP resources")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/mcp read" || task.startsWith("/mcp read ")) {
        const parts = task.trim().split(/\s+/);
        const names = mcpManager.connectedServerNames();
        const name = parts[2] ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); continue; }
        try {
          let uri: string | undefined = parts[3];
          if (!uri) {
            const catalog = await mcpManager.listResources(name);
            uri = await selectTerminalOption(localize(language, "选择要读取的 MCP 资源", "Choose an MCP resource to read"), catalog.resources.map((resource) => ({ label: resource.name, description: resource.uri, value: resource.uri })), language);
          }
          if (!uri) { console.log(chalk.dim(localize(language, "该服务没有可直接读取的资源，或操作已取消。\n", "This server has no directly readable resource, or the operation was cancelled.\n"))); continue; }
          const result = await mcpManager.readResource(name, uri);
          console.log(chalk.yellow(localize(language, "以下是不可信的远端 MCP 内容，仅供查看，不会自动作为模型指令执行。", "The following is untrusted remote MCP content. It is displayed only and will not be executed as model instructions.")));
          console.log(`${chalk.cyan(`${result.server} · ${result.label}`)}\n${result.text}${result.truncated ? `\n${chalk.yellow(localize(language, "内容已按安全上限截断。", "Content was truncated at the safety limit."))}` : ""}\n`);
        } catch (error) { console.error(chalk.red(`${localize(language, "读取 MCP 资源失败", "Failed to read MCP resource")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/mcp prompts" || task.startsWith("/mcp prompts ")) {
        const requested = task.trim().split(/\s+/)[2];
        const names = mcpManager.connectedServerNames();
        const name = requested ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); continue; }
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
        } catch (error) { console.error(chalk.red(`${localize(language, "读取 MCP Prompt 列表失败", "Failed to list MCP prompts")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/mcp prompt" || task.startsWith("/mcp prompt ")) {
        const parts = task.trim().split(/\s+/);
        const names = mcpManager.connectedServerNames();
        const name = parts[2] ?? await selectTerminalOption(localize(language, "选择 MCP 服务", "Choose an MCP server"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) { console.log(chalk.dim(localize(language, "没有已连接的 MCP，或操作已取消。\n", "No MCP server is connected, or the operation was cancelled.\n"))); continue; }
        try {
          const catalog = await mcpManager.listPrompts(name);
          const promptName = parts[3] ?? await selectTerminalOption(localize(language, "选择 MCP Prompt", "Choose an MCP prompt"), catalog.prompts.map((prompt) => ({ label: prompt.name, description: prompt.description, value: prompt.name })), language);
          if (!promptName) { console.log(chalk.dim(localize(language, "该服务没有可用 Prompt，或操作已取消。\n", "This server has no prompt, or the operation was cancelled.\n"))); continue; }
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
        } catch (error) { console.error(chalk.red(`${localize(language, "获取 MCP Prompt 失败", "Failed to get MCP prompt")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
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
              continue;
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
            continue;
          }
          if (!["migrate", "cleanup", "rollback"].includes(action)) {
            console.log(chalk.yellow(localize(language,
              "用法：/mcp credentials [status|migrate|cleanup|rollback] [name]\n",
              "Usage: /mcp credentials [status|migrate|cleanup|rollback] [name]\n")));
            continue;
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
            continue;
          }
          if (action === "migrate") {
            const confirmed = await selectTerminalOption(localize(language,
              `将 ${name} 的 OAuth Token 与 Client Secret 复制到 Windows Credential Manager，校验后切换引用；Scope 等非秘密元数据仍保留在配置文件。继续？`,
              `Copy OAuth tokens and the client secret for ${name} to Windows Credential Manager, verify them, and switch the reference? Non-secret metadata such as scopes remains in the config file.`), [
              { label: localize(language, "继续迁移（保留旧明文）", "Migrate and retain legacy plaintext"), value: "yes" },
              { label: localize(language, "取消", "Cancel"), value: "no" },
            ], language);
            if (confirmed !== "yes") { await auditCredential("mcp-migrate", name, "cancelled"); console.log(chalk.dim(localize(language, "已取消迁移。\n", "Migration cancelled.\n"))); continue; }
            mcpSystemCredentialStore ??= await createWindowsSystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record">("mcp-oauth-record");
            mcpManager.attachOAuthCredentialStore(mcpSystemCredentialStore);
            const count = await mcpManager.migrateOAuthCredentials(name, mcpSystemCredentialStore, projectMcpTrusted);
            await auditCredential("mcp-migrate", name, "succeeded");
            console.log(chalk.green(localize(language,
              `已迁移并校验 ${count} 条 OAuth 凭证。旧明文暂时保留；重启验证成功后运行 /mcp credentials cleanup ${name}。\n`,
              `Migrated and verified ${count} OAuth credential record(s). Legacy plaintext remains; after verifying a restart, run /mcp credentials cleanup ${name}.\n`)));
            continue;
          }
          if (action === "cleanup") {
            const typed = await askQuestion(chalk.yellow(localize(language,
              `将再次校验系统副本并永久删除 ${name} 的旧明文 Token。请输入 MCP 名称“${name}”确认：`,
              `The system copy will be verified again and legacy plaintext tokens for ${name} will be permanently deleted. Type the MCP name "${name}" to confirm: `)));
            if (typed.trim() !== name) { await auditCredential("mcp-cleanup", name, "cancelled"); console.log(chalk.dim(localize(language, "MCP 名称不匹配，已取消清理。\n", "MCP name did not match; cleanup cancelled.\n"))); continue; }
            const count = await mcpManager.cleanupOAuthCredentials(name, projectMcpTrusted);
            await auditCredential("mcp-cleanup", name, "succeeded");
            console.log(chalk.green(localize(language, `已安全删除 ${count} 条旧明文 OAuth 凭证。\n`, `Safely deleted ${count} legacy plaintext OAuth credential record(s).\n`)));
            continue;
          }
          const confirmed = await selectTerminalOption(localize(language,
            `将 ${name} 切回本机兼容文件，并删除系统凭证引用；若旧明文已清理，会先从系统凭证恢复。继续？`,
            `Switch ${name} back to the compatibility file and remove its system reference? If plaintext was cleaned, it will first be restored from the system credential.`), [
            { label: localize(language, "确认回退", "Roll back"), value: "yes" },
            { label: localize(language, "取消", "Cancel"), value: "no" },
          ], language);
          if (confirmed !== "yes") { await auditCredential("mcp-rollback", name, "cancelled"); console.log(chalk.dim(localize(language, "已取消回退。\n", "Rollback cancelled.\n"))); continue; }
          const count = await mcpManager.rollbackOAuthCredentials(name, projectMcpTrusted);
          await auditCredential("mcp-rollback", name, "succeeded");
          console.log(chalk.green(localize(language, `已回退 ${count} 条 OAuth 凭证到兼容文件。\n`, `Rolled back ${count} OAuth credential record(s) to the compatibility file.\n`)));
        } catch (error) {
          if (action !== "status") await auditCredential(`mcp-${action}`, auditSubject, "failed");
          console.error(chalk.red(`${localize(language, "MCP OAuth 凭证操作失败", "MCP OAuth credential operation failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/mcp auth" || task.startsWith("/mcp auth ")) {
        const requested = task.trim().split(/\s+/)[2];
        const entries = await mcpManager.authStatus(requested, projectMcpTrusted);
        if (!entries.length) console.log(chalk.dim(localize(language, "没有匹配的 OAuth MCP。\n", "No matching OAuth MCP server.\n")));
        else console.log(`${entries.map((entry) => {
          const expiry = entry.expiresAt ? new Date(entry.expiresAt).toLocaleString() : localize(language, "未知", "unknown");
          return [
            chalk.cyan(entry.name),
            localize(language, `状态：${entry.authenticated ? entry.expired ? "已过期" : "已登录" : "未登录"}`, `Status: ${entry.authenticated ? entry.expired ? "expired" : "authenticated" : "not authenticated"}`),
            localize(language, `Issuer：${entry.issuer ?? "未知"}`, `Issuer: ${entry.issuer ?? "unknown"}`),
            localize(language, `Scope：${entry.scopes.join(" ") || "（默认）"}`, `Scopes: ${entry.scopes.join(" ") || "(default)"}`),
            localize(language, `到期：${expiry}`, `Expires: ${expiry}`),
          ].join("\n");
        }).join("\n\n")}\n`);
        continue;
      }
      if (task === "/mcp login" || task.startsWith("/mcp login ")) {
        const requested = task.trim().split(/\s+/)[2];
        const names = await mcpManager.oauthServerNames(projectMcpTrusted);
        const name = requested ?? await selectTerminalOption(localize(language, "选择要登录的 MCP 服务", "Choose an MCP server to log in to"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) {
          console.log(chalk.dim(localize(language, "没有可登录的 OAuth MCP，或操作已取消。\n", "No OAuth MCP server is available, or login was cancelled.\n")));
          continue;
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
          agent.replaceTools([...baseTools, ...mcpManager.tools()]);
          const server = mcpManager.status().find((item) => item.name === name);
          if (server?.state !== "connected") throw new Error(server?.error ?? localize(language, "授权后连接失败", "connection failed after authorization"));
          console.log(chalk.green(localize(language, `MCP ${name} 登录成功，已连接 ${server.tools} 个工具。\n`, `MCP ${name} login succeeded with ${server.tools} tools.\n`)));
        } catch (error) {
          console.error(chalk.red(`${localize(language, "MCP 登录失败", "MCP login failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        } finally { process.removeListener("SIGINT", cancelLogin); }
        continue;
      }
      if (task === "/mcp logout" || task.startsWith("/mcp logout ")) {
        const requested = task.trim().split(/\s+/)[2];
        const names = await mcpManager.oauthServerNames(projectMcpTrusted);
        const name = requested ?? await selectTerminalOption(localize(language, "选择要退出登录的 MCP 服务", "Choose an MCP server to log out"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) { console.log(chalk.dim(localize(language, "没有可退出的 OAuth MCP，或操作已取消。\n", "No OAuth MCP server is available, or logout was cancelled.\n"))); continue; }
        const confirmed = await selectTerminalOption(localize(language, `撤销并清除 MCP ${name} 的本地 Token？`, `Revoke and clear local tokens for MCP ${name}?`), [
          { label: localize(language, "撤销并退出（保留 Client 注册）", "Revoke and log out (keep client registration)"), value: "tokens" as const },
          { label: localize(language, "同时忘记 Client 注册", "Also forget client registration"), value: "all" as const },
          { label: localize(language, "取消", "Cancel"), value: "cancel" as const },
        ], language);
        if (!confirmed || confirmed === "cancel") { await auditCredential("mcp-logout", name, "cancelled"); console.log(chalk.dim(localize(language, "已取消退出登录。\n", "Logout cancelled.\n"))); continue; }
        try {
          const result = await mcpManager.logout(name, confirmed === "all", projectMcpTrusted);
          await auditCredential("mcp-logout", name, "succeeded");
          agent.replaceTools([...baseTools, ...mcpManager.tools()]);
          console.log(chalk.green(localize(language, `MCP ${name} 已退出登录，本地授权已清除。`, `MCP ${name} logged out; local authorization was cleared.`)));
          if (result.warning) console.log(chalk.yellow(localize(language, `远端撤销未确认：${result.warning}`, `Remote revocation was not confirmed: ${result.warning}`)));
          else if (!result.revoked) console.log(chalk.dim(localize(language, "授权服务器未提供撤销端点；本地 Token 已清除。", "The authorization server did not expose a revocation endpoint; local tokens were cleared.")));
          console.log();
        } catch (error) {
          await auditCredential("mcp-logout", name, "failed");
          console.error(chalk.red(`${localize(language, "MCP 退出登录失败", "MCP logout failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
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
        if (!authentication) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); continue; }
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
          if (!registration) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); continue; }
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
        if (!risk) { console.log(chalk.dim(localize(language, "已取消添加 MCP。\n", "MCP add cancelled.\n"))); continue; }
        status.start(localize(language, `正在添加并连接 MCP ${name}`, `Adding and connecting MCP ${name}`));
        try {
          if (oauth) await mcpManager.addUserOAuthServer(name, url, oauth, risk);
          else await mcpManager.addUserHttpServer(name, url, bearerEnv, risk);
          await mcpManager.start(projectMcpTrusted);
          agent.replaceTools([...baseTools, ...mcpManager.tools()]);
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
          console.error(chalk.red(`${localize(language, "MCP 添加失败", "MCP add failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/mcp remove" || task.startsWith("/mcp remove ")) {
        const requested = task.trim().split(/\s+/)[2];
        const names = await mcpManager.userServerNames();
        const name = requested ?? await selectTerminalOption(localize(language, "删除哪个用户级 MCP？", "Remove which user-level MCP server?"), names.map((item) => ({ label: item, value: item })), language);
        if (!name) { console.log(chalk.dim(localize(language, "没有可删除的用户级 MCP，或操作已取消。\n", "No user-level MCP server can be removed, or the operation was cancelled.\n"))); continue; }
        const confirmed = (await askQuestion(chalk.yellow(localize(language, `确认删除用户级 MCP ${name}？[y/N] `, `Remove user-level MCP ${name}? [y/N] `)))).trim();
        if (!/^(y|yes)$/i.test(confirmed)) { console.log(chalk.dim(localize(language, "已取消删除 MCP。\n", "MCP removal cancelled.\n"))); continue; }
        try {
          if (!await mcpManager.removeUserServer(name)) throw new Error(localize(language, `用户配置中不存在 ${name}`, `${name} does not exist in user configuration`));
          await mcpManager.start(projectMcpTrusted);
          agent.replaceTools([...baseTools, ...mcpManager.tools()]);
          console.log(chalk.green(localize(language, `已删除 MCP ${name}。\n`, `Removed MCP ${name}.\n`)));
        } catch (error) {
          console.error(chalk.red(`${localize(language, "MCP 删除失败", "MCP removal failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/mcp test" || task.startsWith("/mcp test ")) {
        const requested = task.trim().split(/\s+/)[2];
        status.start(localize(language, "正在测试 MCP 连接", "Testing MCP connections"));
        await mcpManager.start(projectMcpTrusted);
        agent.replaceTools([...baseTools, ...mcpManager.tools()]);
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
        continue;
      }
      if (task === "/mcp reload") {
        status.start(localize(language, "正在重新加载 MCP 服务", "Reloading MCP servers"));
        try {
          await mcpManager.start(projectMcpTrusted);
          agent.replaceTools([...baseTools, ...mcpManager.tools()]);
          status.stop();
          console.log(`${chalk.green(localize(language, "MCP 配置已重新加载。", "MCP configuration reloaded."))}\n${mcpManager.summary(language)}\n`);
        } catch (error) {
          status.stop();
          console.error(chalk.red(`${localize(language, "MCP 重新加载失败", "MCP reload failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/agents" || task.startsWith("/agents ")) {
        const parts = task.split(/\s+/);
        try {
          if (parts.length === 1) {
            const runs = coordinator.list();
            console.log(runs.length ? `${runs.map((run) => formatAgentRun(run, language)).join("\n\n")}\n` : chalk.dim(localize(language, "没有多 Agent 运行记录。\n", "No multi-agent runs.\n")));
          } else if (parts[1] === "cancel" && parts[2] && parts[3]) {
            const cancelled = await coordinator.cancel(parts[2], parts[3]);
            console.log(chalk.yellow(localize(language, `Agent ${cancelled.id} 状态：${cancelled.status}。\n`, `Agent ${cancelled.id} is ${cancelled.status}.\n`)));
          } else if (parts[1] === "retry" && parts[2] && parts[3]) {
            console.log(`${formatAgentRun(await coordinator.retry(parts[2], parts[3]), language)}\n`);
          } else if (parts[1] === "integrate" && parts[2] && parts[3]) {
            const preview = await coordinator.diff(parts[2], parts[3]);
            console.log(`${chalk.dim(localize(language, "拟议的 Agent 补丁：", "Proposed Agent patch:"))}\n${preview}\n`);
            const answer = await askQuestion(chalk.yellow("[write]") + ` Integrate this Agent patch into ${config.cwd}? [y/N] `);
            if (!/^(y|yes)$/i.test(answer.trim())) console.log(chalk.dim(localize(language, "已取消 Agent 集成。\n", "Agent integration cancelled.\n")));
            else {
              console.log(chalk.green(`${await coordinator.integrate(parts[2], parts[3])}\n`));
              projectIndex.invalidate();
            }
          } else if (parts.length === 2) {
            console.log(`${formatAgentRun(coordinator.get(parts[1]), language)}\n`);
          } else {
            console.log(chalk.yellow(localize(language, "用法：/agents [运行ID] | /agents cancel|retry|integrate <运行ID> <任务ID>\n", "Usage: /agents [run-id] | /agents cancel|retry|integrate <run-id> <task-id>\n")));
          }
        } catch (error) {
          console.error(chalk.red(`${localize(language, "Agent 命令失败", "Agent command failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/model" || task.startsWith("/model ")) {
        console.log(chalk.dim(localize(language, `使用 /models 选择模型。当前 Provider/模型：${config.providerId}/${agent.status().model}\n`, `Use /models to choose a model. Current provider/model: ${config.providerId}/${agent.status().model}\n`)));
        continue;
      }
      if (task === "/details") {
        const records = activities.list();
        if (!records.length) {
          console.log(chalk.dim(localize(language, "尚未记录工具或 Agent 活动。\n", "No tool or Agent activity has been recorded yet.\n")));
          continue;
        }
        const selected = await selectTerminalOption(localize(language, "活动详情", "Activity details"), records.map((record) => ({
          label: `${record.state} ${record.title}`,
          description: `${new Date(record.startedAt).toLocaleTimeString()}  ${record.description}`,
          value: record.id,
        })), language);
        if (selected) {
          const record = activities.get(selected)!;
          const kind = localize(language, ({ tool: "工具", agent: "Agent", system: "系统" } as Record<string, string>)[record.kind] ?? record.kind, record.kind);
          const state = localize(language, ({ running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[record.state] ?? record.state, record.state);
          console.log(`${chalk.cyan(`${kind} ${record.title}`)} ${chalk.dim(`[${state}]`)}\n${record.description}\n\n${record.detail ?? record.summary ?? localize(language, "暂无详情。", "No detail yet.")}\n`);
        }
        continue;
      }
      if (task === "/background" || task.startsWith("/background ")) {
        const parts = task.split(/\s+/);
        try {
          if (parts.length === 1 || parts[1] === "list") {
            const jobs = listBackgroundProcesses();
            if (!jobs.length) console.log(chalk.dim(localize(language, "当前工作区没有后台任务。\n", "No background jobs exist for this workspace.\n")));
            else {
              for (const job of jobs) console.log(`${job.running ? chalk.cyan("●") : chalk.dim("○")} ${job.id} · ${job.state} · PID ${job.pid ?? "-"} · ${job.outputBytes.toLocaleString()} B · ${job.command}`);
              console.log(chalk.dim(localize(language, "使用 /background read <ID> [游标] 读取增量输出；/background cancel <ID> 显式取消。\n", "Use /background read <id> [cursor] for incremental output; /background cancel <id> to stop it explicitly.\n")));
            }
          } else if (parts[1] === "start") {
            const command = task.slice("/background start".length).trim();
            if (!command) throw new Error(localize(language, "必须提供命令", "a command is required"));
            const risk = classifyCommand(command);
            const prompt = risk === "dangerous"
              ? localize(language, `这是危险命令，后台启动后不会再有交互审批。输入 BACKGROUND 确认：`, `This is a dangerous command and cannot prompt again after detaching. Type BACKGROUND to confirm: `)
              : localize(language, `后台启动并允许它在退出 Xiu 后继续？[y/N] `, `Start in background and let it continue after Xiu exits? [y/N] `);
            const answer = await askQuestion(chalk.yellow(prompt));
            const confirmed = risk === "dangerous" ? answer.trim() === "BACKGROUND" : /^(y|yes)$/i.test(answer.trim());
            if (!confirmed) console.log(chalk.dim(localize(language, "已取消后台启动。\n", "Background start cancelled.\n")));
            else {
              const started = startBackgroundProcess(command, config.cwd);
              console.log(chalk.green(localize(language, `后台任务 ${started.id} 已启动（PID ${started.pid ?? "未知"}），退出 Xiu 后仍会继续。\n`, `Background job ${started.id} started (PID ${started.pid ?? "unknown"}) and will survive Xiu exit.\n`)));
            }
          } else if (parts[1] === "read" && parts[2]) {
            const cursor = parts[3] === undefined ? 0 : Number(parts[3]);
            if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(localize(language, "游标必须是非负整数", "cursor must be a non-negative integer"));
            const page = readBackgroundProcessOutput(parts[2], cursor);
            console.log(`${page.text}\n${chalk.dim(localize(language, `状态 ${page.state} · 下一游标 ${page.nextCursor} · 共 ${page.outputBytes.toLocaleString()} B\n`, `State ${page.state} · next cursor ${page.nextCursor} · ${page.outputBytes.toLocaleString()} B total\n`))}`);
          } else if (parts[1] === "cancel" && parts[2]) {
            const selected = listBackgroundProcesses().find((job) => job.id === parts[2]);
            if (!selected) throw new Error(localize(language, `未知后台任务：${parts[2]}`, `Unknown background job: ${parts[2]}`));
            if (!selected.running) console.log(chalk.dim(localize(language, `后台任务 ${selected.id} 已是 ${selected.state}。\n`, `Background job ${selected.id} is already ${selected.state}.\n`)));
            else {
              const answer = await askQuestion(chalk.yellow(localize(language, `取消后台任务 ${selected.id}（${selected.command}）？[y/N] `, `Cancel background job ${selected.id} (${selected.command})? [y/N] `)));
              if (/^(y|yes)$/i.test(answer.trim())) { await stopBackgroundProcess(selected.id); console.log(chalk.green(localize(language, `已取消后台任务 ${selected.id}。\n`, `Background job ${selected.id} cancelled.\n`))); }
              else console.log(chalk.dim(localize(language, "已保留后台任务。\n", "Background job kept running.\n")));
            }
          } else console.log(chalk.yellow(localize(language, "用法：/background [list] | start <命令> | read <ID> [游标] | cancel <ID>\n", "Usage: /background [list] | start <command> | read <id> [cursor] | cancel <id>\n")));
        } catch (error) { console.error(chalk.red(`${localize(language, "后台任务操作失败", "Background job operation failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/diagnostics") {
        console.log(`${formatTaskDiagnostics(agent.status().diagnostics, language)}\n`);
        continue;
      }
      if (task === "/report" || task.startsWith("/report ")) {
        try {
          const run = await taskRunJournal.latest();
          if (!run) throw new Error(localize(language, "本工作区还没有可报告的任务运行记录。", "This workspace has no task run to report yet."));
          const restored = await loadSession(config.cwd, run.sessionId).catch(() => undefined);
          const replay = restored?.replay.filter((item) => item.inputKind !== "system") ?? [];
          const sessionUpdatedAt = restored?.updatedAt ?? run.updatedAt;
          const turn = replay
            .sort((left, right) => {
              const leftDistance = Math.abs(Date.parse(left.diagnostics?.startedAt ?? sessionUpdatedAt) - Date.parse(run.startedAt));
              const rightDistance = Math.abs(Date.parse(right.diagnostics?.startedAt ?? sessionUpdatedAt) - Date.parse(run.startedAt));
              return leftDistance - rightDistance;
            })[0];
          const selectedIndex = turn ? restored?.replay.indexOf(turn) ?? -1 : -1;
          const rootGoal = originalTaskGoal(turn?.task ?? run.taskPreview);
          let rootIndex = selectedIndex;
          if (restored && selectedIndex >= 0) {
            for (let index = selectedIndex; index >= 0; index--) {
              const candidate = restored.replay[index];
              if (candidate?.inputKind !== "system" && originalTaskGoal(candidate?.task ?? "") === rootGoal) rootIndex = index;
              if (candidate?.task === rootGoal) { rootIndex = index; break; }
            }
          }
          const turns = restored && rootIndex >= 0 && selectedIndex >= rootIndex
            ? restored.replay.slice(rootIndex, selectedIndex + 1).filter((item) => item.inputKind !== "system")
            : (turn ? [turn] : []);
          const chainStartedAt = turns[0]?.diagnostics?.startedAt;
          const recentRuns = await taskRunJournal.recent(200);
          const runs = recentRuns
            .filter((item) => item.sessionId === run.sessionId
              && (!chainStartedAt || Date.parse(item.startedAt) >= Date.parse(chainStartedAt) - 5_000)
              && Date.parse(item.startedAt) <= Date.parse(run.finishedAt ?? run.updatedAt))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
          const audit = await securityAudit.read({ limit: 500, workspaceOnly: true });
          if (task === "/report") {
            const report = buildExecutionReport({ cwd: config.cwd, run, runs, turn, turns, auditRecords: audit.records, scope: "summary" });
            console.log(`${renderTerminalMarkdown(formatExecutionReport(report, language))}\n`);
            continue;
          }
          const match = task.match(/^\/report\s+export\s+(markdown|json)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(summary|details)$/i);
          if (!match) {
            console.log(chalk.yellow(localize(language,
              "用法：/report 或 /report export <markdown|json> <工作区内路径> <summary|details>\n",
              "Usage: /report or /report export <markdown|json> <workspace path> <summary|details>\n")));
            continue;
          }
          const format = match[1]!.toLowerCase() as ExecutionReportFormat;
          const requestedPath = match[2] ?? match[3] ?? match[4]!;
          const scope = match[5]!.toLowerCase() as ExecutionReportScope;
          const target = path.resolve(config.cwd, requestedPath);
          const exists = await fs.lstat(target).catch(() => undefined);
          if (exists) {
            const answer = await askQuestion(chalk.yellow(localize(language, `报告文件已存在，覆盖 ${requestedPath}？[y/N] `, `Report exists. Overwrite ${requestedPath}? [y/N] `)));
            if (!/^(y|yes)$/i.test(answer.trim())) {
              console.log(chalk.dim(localize(language, "已取消报告导出。\n", "Report export cancelled.\n")));
              continue;
            }
          }
          const report = buildExecutionReport({ cwd: config.cwd, run, runs, turn, turns, auditRecords: audit.records, scope });
          const written = await writeExecutionReport(config.cwd, requestedPath, serializeExecutionReport(report, format, language));
          console.log(chalk.green(localize(language, `执行报告已导出：${path.relative(config.cwd, written)}\n`, `Execution report exported: ${path.relative(config.cwd, written)}\n`)));
        } catch (error) {
          console.error(chalk.red(`${localize(language, "生成执行报告失败", "Could not generate execution report")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/audit" || task.startsWith("/audit ")) {
        const argument = task.slice("/audit".length).trim().toLowerCase();
        const category: SecurityAuditCategory | undefined = argument === "approvals" || argument === "approval"
          ? "approval"
          : argument === "credentials" || argument === "credential"
            ? "credential"
            : undefined;
        if (argument && !category) {
          console.log(chalk.yellow(localize(language, "用法：/audit [approvals|credentials]\n", "Usage: /audit [approvals|credentials]\n")));
          continue;
        }
        try {
          const result = await securityAudit.read({ category, limit: 50 });
          const auditStatus = securityAudit.status();
          console.log(chalk.cyan(localize(language, "本机安全审计（不包含命令正文、Prompt、文件内容或凭证）", "Local security audit (excludes command text, prompts, file contents, and credentials)")));
          if (!result.records.length) console.log(chalk.dim(localize(language, "暂无匹配记录。", "No matching records.")));
          else for (const record of result.records) {
            const details = [record.category, record.action, record.outcome, record.risk, record.source, record.scope, record.subject].filter(Boolean).join(" · ");
            console.log(`${chalk.dim(record.timestamp)} · ${details}`);
          }
          if (result.truncated) console.log(chalk.dim(localize(language, "仅显示最近 50 条匹配记录。", "Showing only the 50 most recent matching records.")));
          if (result.invalidLines) console.log(chalk.yellow(localize(language, `忽略了 ${result.invalidLines} 条损坏记录。`, `Ignored ${result.invalidLines} invalid record(s).`)));
          if (!auditStatus.healthy) console.log(chalk.yellow(localize(language, `本进程最近一次审计写入失败：${auditStatus.lastError}`, `The most recent audit write in this process failed: ${auditStatus.lastError}`)));
          console.log();
        } catch (error) {
          console.error(chalk.red(`${localize(language, "读取安全审计失败", "Could not read security audit")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/credentials" || task === "/credentials status") {
        try { await printCredentialStatus(); }
        catch (error) { console.error(chalk.red(`${localize(language, "读取凭证状态失败", "Could not read credential status")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/credentials probe") {
        const confirmed = await askQuestion(chalk.yellow(localize(language,
          "将在 Windows Credential Manager 写入一个随机临时 Canary，回读验证后立即删除。继续？[y/N] ",
          "A random temporary canary will be written to Windows Credential Manager, verified, and immediately deleted. Continue? [y/N] ")));
        if (!/^(y|yes)$/i.test(confirmed.trim())) {
          await auditCredential("system-probe", "windows", "cancelled");
          console.log(chalk.dim(localize(language, "已取消系统凭证库探测。\n", "System credential probe cancelled.\n")));
          continue;
        }
        const probe = await probeWindowsSystemCredentialStore(true);
        await auditCredential("system-probe", "windows", probe.status.available ? "succeeded" : "failed");
        console.log(`${probe.status.available ? chalk.green(formatCredentialProbe(probe)) : chalk.red(formatCredentialProbe(probe))}\n`);
        continue;
      }
      if (task === "/credentials migrate" || task.startsWith("/credentials migrate ")) {
        const requestedCredential = task.slice("/credentials migrate".length).trim() || undefined;
        try {
          const argument = task.slice("/credentials migrate".length).trim();
          const candidates = providerRegistry.migrationCandidates();
          if (!candidates.length) {
            console.log(chalk.dim(localize(language, "没有可迁移的 Provider 明文 Key。\n", "No legacy Provider API keys are available to migrate.\n")));
            continue;
          }
          let ids: string[];
          if (argument === "--all") ids = candidates.map((item) => item.providerId);
          else if (argument) ids = [argument];
          else {
            const selected = await selectTerminalOption(localize(language, "选择要迁移的 Provider Key", "Choose a Provider key to migrate"), candidates.map((item) => ({ label: item.providerName, description: item.providerId, value: item.providerId })), language);
            if (!selected) { await auditCredential("provider-migrate", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "已取消迁移。\n", "Migration cancelled.\n"))); continue; }
            ids = [selected];
          }
          const names = ids.join(", ");
          const confirmed = await selectTerminalOption(localize(language,
            `将 ${names} 的 Key 复制到 Windows Credential Manager，回读校验后切换引用；暂不删除旧明文。继续？`,
            `Copy keys for ${names} to Windows Credential Manager, verify them, and switch references without deleting plaintext yet?`), [
            { label: localize(language, "继续迁移", "Migrate"), value: "yes" },
            { label: localize(language, "取消", "Cancel"), value: "no" },
          ], language);
          if (confirmed !== "yes") { await auditCredential("provider-migrate", names, "cancelled"); console.log(chalk.dim(localize(language, "已取消迁移。\n", "Migration cancelled.\n"))); continue; }
          systemCredentialStore ??= await createWindowsSystemCredentialStore("provider-api-key");
          providerRegistry.attachSystemCredentialStore(systemCredentialStore);
          await providerRegistry.migrateApiKeysToSystem(ids, systemCredentialStore);
          await auditCredential("provider-migrate", names, "succeeded");
          if (ids.includes(config.providerId)) await switchProviderProfile(providerRegistry.get(config.providerId)!, true, config.model);
          console.log(chalk.green(localize(language,
            `已迁移并校验 ${ids.length} 个 Provider Key；运行时已切换到系统凭证库，旧明文仍保留，可用 /credentials cleanup 单独清理。\n`,
            `Migrated and verified ${ids.length} Provider key(s). Runtime now uses the system store; plaintext remains until /credentials cleanup.\n`)));
          console.log(chalk.dim(localize(language,
            "为避免误删，迁移流程不会连带删除旧明文。确认重启后系统凭证可用，再单独运行 /credentials cleanup。\n",
            "To prevent accidental deletion, migration never removes plaintext. After verifying the system credential across a restart, run /credentials cleanup separately.\n")));
        } catch (error) {
          await auditCredential("provider-migrate", requestedCredential, "failed");
          console.error(chalk.red(`${localize(language, "凭证迁移失败；原引用与旧明文保持不变", "Credential migration failed; the original reference and plaintext remain unchanged")}: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/credentials cleanup" || task.startsWith("/credentials cleanup ")) {
        const requestedCredential = task.slice("/credentials cleanup".length).trim() || undefined;
        try {
          const argument = task.slice("/credentials cleanup".length).trim();
          const candidates = providerRegistry.credentialInfo().filter((item) => item.migration && (item.legacyCopyPresent || item.systemCopyPresent));
          const selected = argument || await selectTerminalOption(localize(language, "选择要清理旧明文的 Provider", "Choose a Provider whose plaintext copy should be removed"), candidates.map((item) => ({ label: item.providerName, description: item.providerId, value: item.providerId })), language);
          if (!selected) { await auditCredential("provider-cleanup", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "没有选择凭证，未做更改。\n", "No credential selected; nothing changed.\n"))); continue; }
          const confirmed = await selectTerminalOption(localize(language, `确认删除 ${selected} 的旧明文 Key？系统副本会先被再次校验。`, `Delete the legacy plaintext key for ${selected}? The system copy will be verified again first.`), [
            { label: localize(language, "删除旧明文", "Delete plaintext"), value: "yes" }, { label: localize(language, "取消", "Cancel"), value: "no" },
          ], language);
          if (confirmed !== "yes") { await auditCredential("provider-cleanup", selected, "cancelled"); console.log(chalk.dim(localize(language, "已取消清理。\n", "Cleanup cancelled.\n"))); continue; }
          const typed = await askQuestion(chalk.yellow(localize(language,
            `这是不可逆操作。请输入 Provider ID “${selected}” 再次确认：`,
            `This cannot be undone. Type the Provider ID "${selected}" to confirm: `)));
          if (typed.trim() !== selected) { await auditCredential("provider-cleanup", selected, "cancelled"); console.log(chalk.dim(localize(language, "Provider ID 不匹配，已取消清理。\n", "Provider ID did not match; cleanup cancelled.\n"))); continue; }
          await providerRegistry.cleanupLegacyApiKey(selected);
          await auditCredential("provider-cleanup", selected, "succeeded");
          console.log(chalk.green(localize(language, "旧明文副本已安全删除。\n", "Legacy plaintext copy safely deleted.\n")));
        } catch (error) { await auditCredential("provider-cleanup", requestedCredential, "failed"); console.error(chalk.red(`${localize(language, "凭证清理失败", "Credential cleanup failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/credentials rollback" || task.startsWith("/credentials rollback ")) {
        const requestedCredential = task.slice("/credentials rollback".length).trim() || undefined;
        try {
          const argument = task.slice("/credentials rollback".length).trim();
          const candidates = providerRegistry.credentialInfo().filter((item) => item.migration && item.legacyCopyPresent);
          const selected = argument || await selectTerminalOption(localize(language, "选择要回退的 Provider", "Choose a Provider to roll back"), candidates.map((item) => ({ label: item.providerName, description: item.providerId, value: item.providerId })), language);
          if (!selected) { await auditCredential("provider-rollback", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "没有选择凭证，未做更改。\n", "No credential selected; nothing changed.\n"))); continue; }
          const confirmed = await selectTerminalOption(localize(language, `将 ${selected} 切回保留的旧明文 Key，并尝试删除系统副本。继续？`, `Switch ${selected} back to its retained plaintext key and try to delete the system copy?`), [
            { label: localize(language, "确认回退", "Roll back"), value: "yes" }, { label: localize(language, "取消", "Cancel"), value: "no" },
          ], language);
          if (confirmed !== "yes") { await auditCredential("provider-rollback", selected, "cancelled"); console.log(chalk.dim(localize(language, "已取消回退。\n", "Rollback cancelled.\n"))); continue; }
          const systemDeleted = await providerRegistry.rollbackSystemApiKey(selected);
          await auditCredential("provider-rollback", selected, "succeeded");
          if (selected === config.providerId) await switchProviderProfile(providerRegistry.get(selected)!, true, config.model);
          console.log((systemDeleted ? chalk.green : chalk.yellow)(localize(language,
            systemDeleted ? "已切回旧明文 Key，系统副本已删除。\n" : "已切回旧明文 Key，但系统副本未能删除；可稍后使用 /credentials forget 明确清理。\n",
            systemDeleted ? "Rolled back to the legacy key and deleted the system copy.\n" : "Rolled back to the legacy key, but the system copy could not be deleted; use /credentials forget to clean it explicitly.\n")));
        } catch (error) { await auditCredential("provider-rollback", requestedCredential, "failed"); console.error(chalk.red(`${localize(language, "凭证回退失败", "Credential rollback failed")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/credentials forget" || task.startsWith("/credentials forget ")) {
        const requestedCredential = task.slice("/credentials forget".length).trim() || undefined;
        try {
          const argument = task.slice("/credentials forget".length).trim();
          const candidates = providerRegistry.credentialInfo().filter((item) => item.legacyCopyPresent || item.systemCopyPresent || item.migration || item.interruptedMigration);
          const selected = argument || await selectTerminalOption(localize(language, "选择要遗忘本地 Key 的 Provider", "Choose a Provider whose local keys should be forgotten"), candidates.map((item) => ({ label: item.providerName, description: `${item.providerId} · ${item.source}`, value: item.providerId })), language);
          if (!selected) { await auditCredential("provider-forget", requestedCredential, "cancelled"); console.log(chalk.dim(localize(language, "没有选择凭证，未做更改。\n", "No credential selected; nothing changed.\n"))); continue; }
          const confirmed = await selectTerminalOption(chalk.yellow(localize(language,
            `将删除 ${selected} 在系统凭证库和兼容文件中的所有本地 Key；环境变量不会改变。确认？`,
            `Delete every local key for ${selected} from the system store and compatibility file? Environment variables are unchanged.`)), [
            { label: localize(language, "永久遗忘本地 Key", "Forget local keys"), value: "yes" }, { label: localize(language, "取消", "Cancel"), value: "no" },
          ], language);
          if (confirmed !== "yes") { await auditCredential("provider-forget", selected, "cancelled"); console.log(chalk.dim(localize(language, "已取消。\n", "Cancelled.\n"))); continue; }
          const typed = await askQuestion(chalk.yellow(localize(language,
            `这将删除全部本地 Key 副本。请输入 Provider ID “${selected}” 再次确认：`,
            `This deletes every local key copy. Type the Provider ID "${selected}" to confirm: `)));
          if (typed.trim() !== selected) { await auditCredential("provider-forget", selected, "cancelled"); console.log(chalk.dim(localize(language, "Provider ID 不匹配，已取消遗忘。\n", "Provider ID did not match; forget cancelled.\n"))); continue; }
          await providerRegistry.forgetLocalApiKey(selected);
          await auditCredential("provider-forget", selected, "succeeded");
          if (selected === config.providerId) await switchProviderProfile(providerRegistry.get(selected)!, true, config.model);
          console.log(chalk.green(localize(language, "本地 Provider Key 已遗忘。\n", "Local Provider keys forgotten.\n")));
        } catch (error) { await auditCredential("provider-forget", requestedCredential, "failed"); console.error(chalk.red(`${localize(language, "遗忘凭证失败", "Could not forget credential")}: ${error instanceof Error ? error.message : String(error)}\n`)); }
        continue;
      }
      if (task === "/queue" || task === "/clear-queue" || task === "/cancel") {
        console.log(chalk.dim(localize(language, `${task} 仅在任务运行时可用。\n`, `${task} is available while a task is running.\n`)));
        continue;
      }
      if (task === "/status") {
        const current = agent.status();
        const zh = language === "zh-CN";
        const index = current.index;
        const indexModeZh = index?.mode === "full" ? "全量构建" : index?.mode === "incremental" ? "增量更新" : index?.mode === "cache" ? "缓存复用" : "未初始化";
        const indexModeEn = index?.mode === "full" ? "full build" : index?.mode === "incremental" ? "incremental" : index?.mode === "cache" ? "cache reused" : "not initialized";
        const indexStatusZh = `索引：${index?.files ?? 0} 个文件${index?.truncated ? "（已截断）" : ""} · ${index?.analyzedModules ?? 0} 个已分析模块 · ${index?.symbols ?? 0} 个符号 · ${index?.dependencies ?? 0} 条依赖 · ${indexModeZh} · ${index?.durationMs ?? 0} 毫秒${index?.dirty ? " · 等待刷新" : ""}`;
        const indexStatusEn = `Index: ${index?.files ?? 0} files${index?.truncated ? " (truncated)" : ""} · ${index?.analyzedModules ?? 0} analyzed modules · ${index?.symbols ?? 0} symbols · ${index?.dependencies ?? 0} dependencies · ${indexModeEn} · ${index?.durationMs ?? 0}ms${index?.dirty ? " · refresh pending" : ""}`;
        console.log(zh ? [
          `会话：${current.sessionId ?? "尚未开始"}`, `Provider：${config.providerId}（${config.provider}）`, `模型：${current.model}`, `能力：${featureNames(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `能力探测：${capabilityProbeSummary(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `语言：简体中文`,
          `规划模式：${current.planMode ? "开启（只读）" : "关闭"}`, `上次结果：${current.outcome}`,
          `轮次：${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : "（无限制）"}`, `待处理补充：${current.pendingSteering}`, `消息：${current.messages}`,
          `上下文估算：约 ${current.stats.estimatedTokens.toLocaleString()} tokens`, `自动压缩：${current.contextLimit.toLocaleString()} tokens（${current.contextLimitMode}）`,
          `模型窗口：${current.contextWindow.toLocaleString()} tokens（${current.contextWindowSource}）`, `API Token：输入 ${current.stats.inputTokens.toLocaleString()} / 输出 ${current.stats.outputTokens.toLocaleString()}`,
          `调用：模型 ${current.stats.modelCalls} / 工具 ${current.stats.toolCalls}`, `压缩次数：${current.stats.compactions}`, `活跃时间：${(current.stats.activeMs / 1000).toFixed(1)} 秒`,
          `最近任务诊断：${current.diagnostics ? formatTaskDiagnosticSummary(current.diagnostics, language) : "暂无"}`,
          indexStatusZh, `MCP：${mcpManager.status().filter((server) => server.state === "connected").length} 个服务 / ${mcpManager.tools().length} 个工具`,
          `Agents：${coordinator.list().filter((run) => run.status === "running").length} 个运行中 / ${coordinator.list().length} 个已保存`, `后台：${listBackgroundProcesses().filter((item) => item.running).length} 个运行中`,
          `活动：${activities.list().length} 条记录（/details）`,
        ].join("\n") + "\n" : [
          `Session: ${current.sessionId ?? "not started"}`, `Provider: ${config.providerId} (${config.provider})`, `Model: ${current.model}`, `Capabilities: ${featureNames(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `Capability probe: ${capabilityProbeSummary(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `Language: English`, `Plan mode: ${current.planMode ? "ON (read-only)" : "OFF"}`, `Last outcome: ${current.outcome}`,
          `Turn: ${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : " (unlimited)"}`, `Pending steering: ${current.pendingSteering}`, `Messages: ${current.messages}`,
          `Context estimate: ~${current.stats.estimatedTokens.toLocaleString()} tokens`, `Auto compact: ${current.contextLimit.toLocaleString()} tokens (${current.contextLimitMode})`,
          `Model window: ${current.contextWindow.toLocaleString()} tokens (${current.contextWindowSource})`, `API tokens: ${current.stats.inputTokens.toLocaleString()} in / ${current.stats.outputTokens.toLocaleString()} out`,
          `Calls: ${current.stats.modelCalls} model / ${current.stats.toolCalls} tool`, `Compactions: ${current.stats.compactions}`, `Active time: ${(current.stats.activeMs / 1000).toFixed(1)}s`,
          `Latest task diagnostics: ${current.diagnostics ? formatTaskDiagnosticSummary(current.diagnostics, language) : "none"}`,
          indexStatusEn, `MCP: ${mcpManager.status().filter((server) => server.state === "connected").length} servers / ${mcpManager.tools().length} tools`,
          `Agents: ${coordinator.list().filter((run) => run.status === "running").length} running / ${coordinator.list().length} saved runs`, `Background: ${listBackgroundProcesses().filter((item) => item.running).length} running`,
          `Activities: ${activities.list().length} recorded (/details)`,
        ].join("\n") + "\n");
        continue;
      }
      if (task === "/help") {
        console.log(`${slashCommands(language).map((command) => `${command.name.padEnd(20)} ${command.description}`).join("\n")}\n`);
        continue;
      }
      try {
        const pendingQuestion = awaitingReply;
        awaitingReply = undefined;
        const continuedTask = pendingQuestion ? continueTaskAfterAnswer(pendingQuestion.originalTask, pendingQuestion.question, task, language) : task;
        if (await runTaskSequence(continuedTask, pendingQuestion ? { task, inputKind: "answer" } : { task, inputKind: "task" })) break;
        restoredDraft = await draftStore.load();
      } catch (error) {
        status.stop();
        console.error(chalk.red(`${localize(language, "错误", "Error")}: ${error instanceof Error ? error.message : String(error)}\n`));
      }
    }
    process.off("SIGINT", onSigint);
  } finally {
    status.stop();
    if (typeof mcpStartup !== "undefined") await mcpStartup.catch(() => undefined);
    await mcpManager.close();
    // Detached background jobs intentionally survive normal Xiu shutdown.
  }
}

main().catch((error) => {
  console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
