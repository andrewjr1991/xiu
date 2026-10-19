#!/usr/bin/env node
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { Agent, BackgroundApprovalRequiredError } from "./agent.js";
import { createProviderPolicy } from "./runtime/provider-policy.js";
import { BackgroundManager } from "./background.js";
import { ActivityLog } from "./activity.js";
import { continueTaskAfterAnswer, parseAssistantInteraction } from "./assistant-interaction.js";
import { CheckpointManager } from "./checkpoint.js";
import { discoverProjectChecks, projectCheckPreview, PROJECT_CHECK_NAMES, runProjectChecks, type ProjectCheckSelection, type ProjectCheckRun, type ProjectCheckStatus } from "./commands/check.js";
import { runUpdateCheckOnce, runUpdateDoctorOnce, UpdateCommandController, type UpdateMessage } from "./commands/update.js";
import { runProviderRecoveryCommand, type ProviderRecoveryCommand } from "./commands/provider-recovery.js";
import { captureTaskBaseline, formatTaskChanges, getWorkspaceDiff, inspectTaskChanges, type TaskChangeSnapshot } from "./task-changes.js";
import { saveTaskChangeHistory } from "./task-change-history.js";
import { applyCapabilityProbe, probeIsFresh, probeModelCapabilities, type CapabilityProbeState } from "./capability-probe.js";
import { ClipboardAttachmentManager } from "./clipboard.js";
import { resolveConfig, type AgentConfig } from "./config.js";
import { EnvironmentCredentialStore, type CredentialBackendStatus } from "./credential-store.js";
import { ConfigFileError } from "./config-file-error.js";
import { createWindowsSystemCredentialStore, probeWindowsSystemCredentialStore, type WindowsCredentialProbeResult, type WindowsSystemCredentialStore } from "./system-credential-store.js";
import { languageName, localize, normalizeLanguage, type UiLanguage } from "./i18n.js";
import { describeFailure, explainError, formatUserFacingError } from "./user-facing-errors.js";
import { runFirstRunWizard } from "./first-run-wizard.js";
import { collectDoctorReport, formatDoctorReport } from "./doctor.js";
import { runDoctorCommand } from "./commands/doctor-command.js";
import { nodeDeprecationNotice } from "./node-runtime.js";
import { DraftStore } from "./draft.js";
import { createProvider, probeProvider } from "./providers.js";
import { ProviderRegistry, resolveStartupModel, resolveStartupProviderId, startupProviderProfile, UNCONFIGURED_PROVIDER_PROFILE, type ProviderProfile } from "./provider-registry.js";
import { createMediaTools } from "./media-tools.js";
import { MediaOperationStore, type MediaOperationRecord } from "./media-operations.js";
import { type McpAuthSecretRecord } from "./mcp-auth-store.js";
import { McpManager } from "./mcp.js";
import { createMcpManager } from "./runtime/mcp-service.js";
import { createMultiAgentTools, formatAgentRun, formatIntegrationPlan, MultiAgentCoordinator, requireCompletedSubagent, selectSubagentTools, type SubagentTask } from "./multi-agent.js";
import { persistentLiveOutput, readInteractiveInput, selectTerminalOption } from "./interactive-ui.js";
import { createProjectIndexTools, ProjectIndex } from "./project-index.js";
import { createPlanTools, TaskPlanManager } from "./plan.js";
import { PluginRegistry } from "./plugins.js";
import { listSessionsWithIssues, loadSession, type RestoredSession, type SessionReplayTurn, unreadableSessionsNote } from "./session.js";
import { createSkillTools, SkillRegistry } from "./skills.js";
import { explainOneShotSlashInput, explainUnhandledSlashInput, formatOneShotSlashProblem, formatSlashInputProblem, helpEntriesFor, slashCommands } from "./slash-commands.js";
import { StatusLine } from "./status.js";
import { createJsonEventStream, ONE_SHOT_EXIT_CODES, redirectHumanOutputToStderr, type JsonEventStream, oneShotExitCode } from "./json-event-stream.js";
import { SettingsStore } from "./settings.js";
import { renderTerminalMarkdown } from "./terminal-markdown.js";
import { localizeToolDescription, localizeToolProgress, summarizeToolResult } from "./tool-display.js";
import { failureRecoveryOptions, formatRunningInputFooter, RunningTaskView, TaskInputQueue } from "./task-queue.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import { builtinTools, createBackgroundTools } from "./tools.js";
import { isWorkspaceTrusted, trustWorkspace } from "./trust.js";
import { formatPromptDashboard, renderWelcome } from "./welcome.js";
import { formatTaskDiagnosticSummary } from "./diagnostics.js";
import type { AgentTool, ApprovalRequest, ModelProvider } from "./types.js";
import type { ProviderFailoverRequest, ProviderFailoverResolution } from "./provider-failover.js";
import { SecurityAuditLog, type SecurityAuditOutcome } from "./security-audit.js";
import { recoveryContinuation, TaskRunJournal, type InterruptedTaskRun } from "./task-run.js";
import { createWebFetch, createWebSearchTools } from "./web-search.js";
import { ManagedWebSearchAuth } from "./managed-web-search-auth.js";
import { redactSecrets } from "./secret-redaction.js";
import { AgentRuntimeAdapter } from "./runtime/agent-adapter.js";
import { XiuRuntime } from "./runtime/xiu-runtime.js";
import { askQuestion, askSecret } from "./terminal-prompts.js";
import { handleBackgroundCommand } from "./commands/background-commands.js";
import { handleCredentialCommand } from "./commands/credential-commands.js";
import { handleMcpCommand } from "./commands/mcp-commands.js";
import { handlePluginCommand } from "./commands/plugin-commands.js";
import { handleProviderCommand } from "./commands/provider-commands.js";
import { diffUsage, formatRunChangeList, parseDiffCommand, replayRunChanges } from "./commands/diff-commands.js";
import { handleReportCommand, runReportCommand } from "./commands/report-commands.js";
import { runAuditCommand } from "./commands/audit-command.js";
import { runRecoverCommand } from "./commands/recover-command.js";
import { handleSkillCommand } from "./commands/skill-commands.js";
import { handleRunningTaskCommand, incompleteTaskMessage, RUNNING_TASK_COMMAND_WORDS } from "./commands/running-task-commands.js";
import { handleWebCommand } from "./commands/web-commands.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

function compactTerminalDescription(value: string, maximum = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  return characters.length > maximum ? `${characters.slice(0, maximum - 3).join("")}...` : normalized;
}

function printUpdateMessage(message: UpdateMessage): void {
  const formatted = message.kind === "error" ? chalk.red(message.text)
    : message.kind === "success" ? chalk.green(message.text)
      : message.kind === "warning" ? chalk.yellow(message.text)
        : message.text;
  (message.kind === "error" ? console.error : console.log)(`${formatted}\n`);
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
  .option("--audio-model <model>", "model used to generate speech or audio")
  .option("--unified-model <model>", "use one model for every declared text and media capability")
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
  .option("--check-update", "check the official npm registry for a newer Xiu version, then exit", false)
  .option("--update-doctor", "run read-only update and installation diagnostics, then exit", false)
  .option("--doctor", "print the read-only diagnostics report (same as `xiu doctor [json]`), then exit", false)
  .option("--provider-config-diagnostics", "list safe Provider configuration diagnostics and recovery backups, then exit", false)
  .option("--provider-config-preview <backup-id>", "preview Provider backup recovery (or current for dead-lock cleanup), then exit")
  .option("--provider-config-recover <backup-id>", "preview and explicitly confirm Provider recovery in an interactive terminal, then exit")
  .option("-y, --yes", "approve writes and execution automatically (dangerous actions still prompt)", false)
  .option("--json", "one-shot tasks only: write runtime events and the final result to stdout as JSON Lines, human-readable text to stderr", false)
  .option("--trust-workspace", "treat the workspace as trusted for this process only, without the interactive prompt and without adding it to the trust list (for scripts and CI on a checkout you control)", false)
  .addHelpText("after", `
Commands that run without an interactive session (trusted workspaces only, except doctor):
  xiu doctor [json]                                       read-only diagnostics report; json prints it as one JSON document; exit 1 when it has a failure
  xiu report [markdown|json|html] [summary|details] [run:<number|id prefix>] [path]
                                                          export the latest task's execution report (stdout without a path; --yes to overwrite)
  xiu report runs                                         list recent runs and their ids
  xiu recover [status]                                    show the interrupted task of this workspace; exit 2 when one exists, 0 otherwise
  xiu recover abandon <run id or prefix of 4+ characters> abandon that task explicitly without replaying anything
  xiu audit [approvals|credentials] [json] [limit]        list this workspace's local security-audit records read-only

Exit codes of a one-shot task (xiu "<task>", with or without --json):
  ${ONE_SHOT_EXIT_CODES.completed} completed · ${ONE_SHOT_EXIT_CODES.unverified} changed but unverified · ${ONE_SHOT_EXIT_CODES.waiting_user} the model asked a question · ${ONE_SHOT_EXIT_CODES.failed} failed, cancelled, paused or not started

Slash commands (/help, /doctor, /report, ...) run only at the interactive prompt: start xiu without a task.
Guides: https://github.com/andrewjr1991/xiu/blob/main/USAGE.zh-CN.md (中文) · docs/guide/en/README.md (English)
`)
  .showHelpAfterError()
  .parse();

/**
 * `--trust-workspace` is the user's explicit, per-invocation trust decision for scripts and CI.
 * It lives only in this process: nothing is written to the trust list, and nothing but the
 * command line (never an environment variable, a setting, a project file or model text) sets it.
 */
let trustGrantedByFlag = false;

async function workspaceTrusted(workspace: string): Promise<boolean> {
  return trustGrantedByFlag || isWorkspaceTrusted(workspace);
}

async function confirmWorkspaceTrust(workspace: string, language: UiLanguage): Promise<boolean> {
  if (await workspaceTrusted(workspace)) return true;
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
  const { sessions, unreadable } = await listSessionsWithIssues(workspace);
  const note = unreadableSessionsNote(unreadable, language);
  if (note) console.log(chalk.yellow(note));
  if (!sessions.length) return undefined;
  const selected = await selectTerminalOption(localize(language, "恢复哪个会话？", "Resume which session?"), sessions.map((session) => ({
    label: session.firstTask.replace(/\s+/g, " ").slice(0, 72) || localize(language, "未命名会话", "Untitled session"),
    description: `${new Date(session.updatedAt).toLocaleString()}  ${session.model ?? localize(language, "未知模型", "unknown model")}  ${session.id}`,
    value: session.id,
  })), language);
  return selected ? await loadSession(workspace, selected) : undefined;
}

let jsonStream: JsonEventStream | undefined;
/** The language startup failures are explained in: the settings file's, `--language` or `XIU_LANGUAGE` once they are known. */
let startupLanguage: UiLanguage = "en-US";

async function main(): Promise<void> {
  const options = program.opts();
  trustGrantedByFlag = Boolean(options.trustWorkspace);
  if (options.json) {
    const exitEarly = options.doctor || options.updateDoctor || options.checkUpdate || options.listSessions || options.providerConfigDiagnostics || options.providerConfigPreview || options.providerConfigRecover || program.args[0] === "doctor" || program.args[0] === "report" || program.args[0] === "recover" || program.args[0] === "audit";
    if (!program.args.length || exitEarly) throw new Error("--json requires exactly one one-shot task and cannot be combined with doctor, report, audit, update, session-list or recovery commands.");
    // stdout now carries only JSON Lines; every human-readable message below lands on stderr.
    const redirected = redirectHumanOutputToStderr();
    jsonStream = createJsonEventStream(redirected.writeStdout, undefined, (value) => redactSecrets(value));
  }
  const recoveryOptions = [options.providerConfigDiagnostics, options.providerConfigPreview, options.providerConfigRecover].filter(Boolean);
  if (recoveryOptions.length) {
    if (recoveryOptions.length !== 1 || program.args.length) throw new Error("Choose one Provider configuration command without a task.");
    const command: ProviderRecoveryCommand = options.providerConfigRecover ? { action: "recover", backupId: options.providerConfigRecover }
      : options.providerConfigPreview ? { action: "preview", backupId: options.providerConfigPreview } : { action: "list" };
    const result = await runProviderRecoveryCommand(new ProviderRegistry(), command, {
      language: normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE) ?? "en-US",
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write: (text) => console.log(text), ask: askQuestion,
    });
    process.exitCode = result.exitCode;
    return;
  }
  const settingsStore = new SettingsStore();
  // The doctor runs even when the settings file is damaged, so it can name the problem; every other
  // command fails closed on it below, as `SettingsStore.load()` does.
  const inspectedSettings = await settingsStore.inspect();
  startupLanguage = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? inspectedSettings.settings.language) ?? "en-US";
  if (options.doctor || program.args[0] === "doctor") {
    const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? inspectedSettings.settings.language) ?? "en-US";
    process.exitCode = await runDoctorCommand(options.doctor ? (program.args as string[]) : (program.args as string[]).slice(1), {
      language,
      collect: async () => {
        let doctorCredentialStore: WindowsSystemCredentialStore<string, "provider-api-key"> | undefined;
        try { doctorCredentialStore = await createWindowsSystemCredentialStore("provider-api-key"); }
        catch { /* The report then describes environment and legacy credentials only. */ }
        return collectDoctorReport({
          version: packageJson.version, settings: inspectedSettings.settings, registry: new ProviderRegistry(undefined, doctorCredentialStore), cwd: path.resolve(options.cwd ?? process.cwd()),
          settingsFile: { state: inspectedSettings.state, ...(inspectedSettings.cause ? { cause: inspectedSettings.cause } : {}) },
        });
      },
    });
    return;
  }
  if (inspectedSettings.problem) throw new ConfigFileError("settings", inspectedSettings.file, inspectedSettings.problem);
  const settings = inspectedSettings.settings;
  if (program.args[0] === "report") {
    const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? settings.language) ?? "en-US";
    process.exitCode = await runReportCommand((program.args as string[]).slice(1), { cwd: path.resolve(options.cwd ?? process.cwd()), language, yes: Boolean(options.yes), isTrusted: workspaceTrusted });
    return;
  }
  if (program.args[0] === "recover") {
    const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? settings.language) ?? "en-US";
    process.exitCode = await runRecoverCommand((program.args as string[]).slice(1), { cwd: path.resolve(options.cwd ?? process.cwd()), language, isTrusted: workspaceTrusted });
    return;
  }
  if (program.args[0] === "audit") {
    const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? settings.language) ?? "en-US";
    process.exitCode = await runAuditCommand((program.args as string[]).slice(1), { cwd: path.resolve(options.cwd ?? process.cwd()), language, isTrusted: workspaceTrusted });
    return;
  }
  if (options.updateDoctor) {
    const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? settings.language) ?? "en-US";
    const result = await runUpdateDoctorOnce({ currentVersion: packageJson.version, language });
    printUpdateMessage(result.message);
    process.exitCode = result.exitCode;
    return;
  }
  if (options.checkUpdate) {
    const language = normalizeLanguage(options.language ?? process.env.XIU_LANGUAGE ?? settings.language) ?? "en-US";
    const result = await runUpdateCheckOnce({ currentVersion: packageJson.version, language });
    printUpdateMessage(result.message);
    process.exitCode = result.exitCode;
    return;
  }
  let systemCredentialStore: WindowsSystemCredentialStore<string, "provider-api-key"> | undefined;
  try { systemCredentialStore = await createWindowsSystemCredentialStore("provider-api-key"); }
  catch { /* The CLI remains usable with environment and legacy credentials. */ }
  let mcpSystemCredentialStore: WindowsSystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record"> | undefined;
  try { mcpSystemCredentialStore = await createWindowsSystemCredentialStore("mcp-oauth-record"); }
  catch { /* OAuth remains usable through the compatibility store until explicitly migrated. */ }
  const providerRegistry = new ProviderRegistry(undefined, systemCredentialStore);
  const ensureSystemCredentialStore = async () => systemCredentialStore ??= await createWindowsSystemCredentialStore("provider-api-key");
  await providerRegistry.load(); // a ProviderConfigurationError is explained once, by the startup failure handler below
  const pluginRegistry = new PluginRegistry(path.resolve(options.cwd ?? process.cwd()), undefined, packageJson.version);
  await pluginRegistry.refresh(false);
  const globalPluginContributions = await pluginRegistry.loadApprovedContributions();
  try { providerRegistry.setPluginProfiles(globalPluginContributions.providers); }
  catch { providerRegistry.setPluginProfiles([]); }
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
      visionModel: options.visionModel ?? effective.capabilityModels?.vision,
      imageModel: options.imageModel ?? effective.capabilityModels?.image,
      videoModel: options.videoModel ?? effective.capabilityModels?.video,
      audioModel: effective.capabilityModels?.audio,
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
  const requestedStartupProfile = startupProviderProfile(providerRegistry, requestedProviderId);
  const startupProfile = requestedStartupProfile ?? UNCONFIGURED_PROVIDER_PROFILE;
  const startupModel = resolveStartupModel(
    options.model,
    requestedStartupProfile && requestedProviderId === savedProviderId ? providerRegistry.activeModel(requestedProviderId) : undefined,
    process.env.XIU_MODEL,
    startupProfile.model,
  );
  const config = profileConfig(startupProfile, startupModel);
  let managedWebSearchAuth = settings.webSearch?.managedAuth === "xiu-device" && settings.webSearch.authBaseURL
    ? new ManagedWebSearchAuth(settings.webSearch.authBaseURL, undefined, createWebFetch(settings.webSearch.proxy))
    : undefined;
  const background = new BackgroundManager({ workspace: config.cwd });
  background.prepareWorkspace();
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
  const mcpManager = createMcpManager(config.cwd, mcpSystemCredentialStore);
  const ensureMcpSystemCredentialStore = async () => mcpSystemCredentialStore ??= await createWindowsSystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record">("mcp-oauth-record");
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
      const { sessions, unreadable } = await listSessionsWithIssues(config.cwd);
      if (!sessions.length) console.log(localize(language, "此工作区没有 Xiu 会话。", "No Xiu sessions in this workspace."));
      else for (const session of sessions) console.log(`${session.id}  ${session.updatedAt}  ${session.model ?? localize(language, "未知模型", "unknown model")}  ${session.firstTask.slice(0, 80)}`);
      const note = unreadableSessionsNote(unreadable, language);
      if (note) console.log(note);
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
        if (config.capabilities.vision === previous) config.capabilities.vision = restored.model;
      }
    }
    const initialTask = (program.args as string[]).join(" ").trim();
    const oneShotSlash = initialTask ? explainOneShotSlashInput(initialTask) : undefined;
    if (oneShotSlash) {
      // A slash command on the command line is a mistake about modes, not a task: say so and stop before trust, plugins or the model.
      const message = formatOneShotSlashProblem(oneShotSlash, language);
      if (jsonStream) { process.exitCode = jsonStream.result({ outcome: "not_started", error: message }); return; }
      console.error(chalk.yellow(`${message}\n`));
      process.exitCode = 1;
      return;
    }
    const skillRegistry = new SkillRegistry(config.cwd);
    const trustedBeforePrompt = await workspaceTrusted(config.cwd);
    await skillRegistry.refresh(trustedBeforePrompt);
    if (initialTask) {
      console.log(chalk.bold(`\nXiu - ${config.providerId}/${config.model}`));
      console.log(chalk.dim(`${localize(language, "工作区", "Workspace")}: ${config.cwd}\n`));
    } else {
      renderWelcome(config, packageJson.version, skillRegistry.list().length);
    }
    const deprecation = nodeDeprecationNotice(process.versions.node, language);
    if (deprecation) console.log(chalk.yellow(`${deprecation}\n`));

    const windowsDirectory = process.env.WINDIR;
    if (windowsDirectory && config.cwd.toLowerCase() === path.join(windowsDirectory, "System32").toLowerCase()) {
      console.log(chalk.yellow(localize(language, "警告：Xiu 正在 Windows System32 中运行。请退出并进入项目目录后重新启动，以免误改系统文件。\n", "Warning: Xiu is running in Windows System32. Exit, enter your project directory, and start Xiu there before making changes.\n")));
    }

    if (jsonStream && !(await workspaceTrusted(config.cwd))) {
      // A non-interactive run must not read a trust decision from a pipe; trust is granted interactively once, or explicitly per run with --trust-workspace.
      process.exitCode = jsonStream.result({ outcome: "not_started", error: localize(language,
        "工作区尚未信任。请先在该目录交互运行一次 xiu 并确认信任，或在你掌控的检出目录上显式加 --trust-workspace，再使用 --json。",
        "This workspace is not trusted yet. Run xiu interactively in it once and confirm trust, or pass --trust-workspace explicitly on a checkout you control, before using --json.") });
      return;
    }
    if (!(await confirmWorkspaceTrust(config.cwd, language))) return;
    config.projectConfigurationTrusted = true;
    await pluginRegistry.refresh(true);
    const pluginContributions = await pluginRegistry.loadApprovedContributions();
    try { providerRegistry.setPluginProfiles(pluginContributions.providers); }
    catch { providerRegistry.setPluginProfiles([]); }
    skillRegistry.setPluginFiles(pluginContributions.skillFiles);
    mcpManager.setPluginServers(pluginContributions.mcpServers);
    if (!options.provider && requestedProviderId !== config.providerId) {
      const restoredPluginProfile = providerRegistry.get(requestedProviderId);
      if (restoredPluginProfile) Object.assign(config, profileConfig(restoredPluginProfile, providerRegistry.activeModel(requestedProviderId)));
    }
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
    if (initialTask && mcpConfigError) console.log(chalk.yellow(`${formatUserFacingError(localize(language, "未加载 MCP 配置", "MCP configuration was not loaded"), mcpConfigError, language)}\n`));
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
        if (config.capabilities.vision === previous) config.capabilities.vision = restored.model;
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
    let latestTaskBaseline: TaskChangeSnapshot | undefined;
    let latestProjectCheck: ProjectCheckRun | undefined;
    let activeCheckController: AbortController | undefined;
    let activeTaskPreparationController: AbortController | undefined;
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
    const redactTerminalOutput = (value: string): string => redactSecrets(value, config.apiKey ? [config.apiKey] : []);
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
    const approveRequest = async (request: ApprovalRequest): Promise<boolean> => {
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
        request.decisionSource = "prompted";
        if (!process.stdin.isTTY) {
          // Nothing can answer a prompt here, so deny without tearing down the live task view: the
          // denial and the tool's start line stay visible in the piped output.
          if (config.backgroundMode) throw new BackgroundApprovalRequiredError(request.description);
          approvalDecision = false;
          return approvalDecision;
        }
        activeApproval = new Promise<void>((resolve) => { finishActiveApproval = resolve; });
        status.stop();
        activeQueuedInputController?.abort();
        runningTaskView?.discard();
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

    // Refusing to start is a failure of the run, not a clean exit: a one-shot or `--json` caller gets exit code 1
    // and the `result` line it waits for, so a script never mistakes "nothing happened" for success.
    const refuseToStart = (message: string): void => {
      console.log(chalk.red(message));
      process.exitCode = jsonStream ? jsonStream.result({ outcome: "not_started", error: redactTerminalOutput(message) }) : 1;
    };
    try {
      recoverySource = await taskRunJournal.interrupted();
    } catch (error) {
      refuseToStart(localize(language,
        `任务恢复日志无法读取：${error instanceof Error ? error.message : String(error)}。为避免错误重放，Xiu 不会开始新任务。`,
        `The task recovery journal could not be read: ${error instanceof Error ? error.message : String(error)}. Xiu will not start a new task because replay safety cannot be established.`));
      return;
    }
    if (recoverySource) {
      if (initialTask) {
        refuseToStart(localize(language,
          `检测到异常中断任务 ${recoverySource.runId.slice(0, 8)}。请先在可交互终端里不带任务参数启动 xiu 确认恢复或放弃，或运行 xiu recover abandon ${recoverySource.runId.slice(0, 8)} 明确放弃，然后再运行新任务。`,
          `Interrupted task ${recoverySource.runId.slice(0, 8)} was detected. Start xiu without a task in an interactive terminal to resume or abandon it, or run xiu recover abandon ${recoverySource.runId.slice(0, 8)} to abandon it explicitly, before running a new task.`));
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
        // "Exit" is the user's own choice (exit code 0); a menu cancelled because there is no terminal means a
        // scripted session ran none of its input, which is a failure.
        if (action === undefined) process.exitCode = 1;
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
        const candidateTools = [...builtinTools, ...createBackgroundTools(background), ...createProjectIndexTools(childIndex), ...createPlanTools(childPlan)];
        const childTools = selectSubagentTools(candidateTools, task.mode);
        const childAgent = new Agent({
          config: childConfig,
          provider: createProvider(childConfig),
          tools: childTools,
          approve: approveRequest,
          events: {
            onModelStart: (turn) => context.reportProgress(localize(language, `思考中 - 第 ${turn} 轮`, `Thinking - turn ${turn}`)),
            onToolStart: (name, description) => context.reportProgress(`${name}: ${localizeToolDescription(name, description, language)}`),
            onToolProgress: (name, message) => context.reportProgress(`${name}: ${localizeToolProgress(message, language)}`),
            onRetry: (message) => context.reportProgress(localizeToolProgress(message, language)),
            onBudgetWarning: (message) => context.reportProgress(message),
            onProviderFailover: (details) => context.reportProgress(localize(language,
              `Provider 故障转移：${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`,
              `Provider failover: ${details.fromProviderId}/${details.fromModel} → ${details.toProviderId}/${details.toModel}`)),
          },
          projectIndex: childIndex,
          planManager: childPlan,
          checkpointManager: childCheckpoint,
          skillRegistry,
        });
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
              ? "Review the inherited implementation Worktree critically. Find correctness, safety, regression, and test gaps. Do not modify files. End with exactly VERDICT: PASS only when no blocking issue remains; otherwise end with VERDICT: FAIL."
              : task.role === "tester"
                ? "Inspect the inherited implementation Worktree using only available read-only tools. Use verify_output with meaningful deterministic expectations for every changed text artifact. This is bounded artifact validation, not executed project tests; command execution is unavailable in shared_readonly mode. If these checks cannot verify the requested change, report that limitation and VERDICT: FAIL. End with exactly VERDICT: PASS only after concrete checks passed. Prose-only PASS cannot authorize integration."
                : "Implement the scoped change only inside your isolated Worktree. Run relevant verification and summarize every changed file.";
          const result = await childAgent.run(`You are the ${task.role} specialist for a parent Xiu agent.\nGoal: ${task.title}\n\n${task.instructions}\n\nRole requirements: ${roleGuidance}${dependencyContext}`);
          const childStatus = childAgent.status();
          requireCompletedSubagent(childStatus);
          return {
            result,
            verification: await childAgent.getVerificationEvidence(),
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
    const buildBaseTools = (toolConfig = config) => {
      const webAuth = managedWebSearchAuth;
      return [...builtinTools, ...createBackgroundTools(background), ...createProjectIndexTools(projectIndex), ...createPlanTools(planManager), ...createSkillTools(skillRegistry), ...createMediaTools(toolConfig), ...createWebSearchTools(settings.webSearch, settings.webSearch?.proxy, {
        ...(webAuth ? { getBearerToken: (signal) => webAuth.getBearerToken(signal) } : {}),
      }), ...coordinatorTools];
    };
    let baseTools = buildBaseTools();
    const tools = [...baseTools, ...mcpManager.tools()];
    let startupProviderError: Error | undefined;
    let provider: ModelProvider;
    try {
      if (!requestedStartupProfile) throw new Error(localize(language, "尚未添加渠道。请使用 /provider add 添加。", "No Provider selected. Use /provider add to add one."));
      provider = createProvider(config);
    } catch (error) {
      startupProviderError = error instanceof Error ? error : new Error(String(error));
      provider = {
        async complete(): Promise<never> {
          throw new Error(localize(language,
            `当前 Provider 尚未配置：${startupProviderError?.message ?? "缺少凭证"}。请使用 /provider key 或 /providers 完成配置。`,
            `The current provider is not configured: ${startupProviderError?.message ?? "missing credentials"}. Use /provider key or /providers to finish setup.`));
        },
      };
    }

    let activeToolActivity: string | undefined;
    let activeToolDetails: { name: string; description: string; verification: boolean; risk: "read" | "write" | "execute" | "dangerous" } | undefined;
    let verificationReadyForSummary = false;
    const xiuRuntime = new XiuRuntime({
      sanitize: redactTerminalOutput,
      approvalHandler: approveRequest,
      language,
    });
    if (jsonStream) {
      const stream = jsonStream;
      xiuRuntime.subscribe((event) => stream.event(event));
    }
    const agent = new Agent({
      config,
      provider,
      tools,
      approve: (request) => xiuRuntime.requestApproval(request),
      events: xiuRuntime.agentEvents({
        onModelStart: (turn) => {
          runningTaskView?.clearDraftPreview();
          runningTaskView?.setTurn(turn, config.maxTurns);
          const modelTurn = localize(language, `模型第 ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} 轮开始`, `Model turn ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} started`);
          runningTaskView?.activity(modelTurn);
          if (runningTaskView) emitLine(chalk.cyan(`● ${modelTurn}`));
          startPhase(verificationReadyForSummary
            ? localize(language, "验证已通过，正在整理最终结果", "Verification passed; preparing the final result")
            : localize(language, "思考中", "Thinking"));
        },
        onModelEnd: () => {
          runningTaskView?.clearDraftPreview();
          stopPhase();
        },
        onDraftPreview: (text, receivedChars) => {
          runningTaskView?.setDraftPreview(redactTerminalOutput(text), receivedChars);
          if (!runningTaskView) startPhase(localize(language, `正在接收回复 · ${receivedChars} 字符`, `Receiving response · ${receivedChars} characters`));
        },
        onText: (text) => {
          // Interactive final text is rendered once, after the complete turn
          // has passed normalization and evidence gates. Tool-bound narration
          // is persisted by onAssistantTurn below.
          if (!runningTaskView) emitLine(`${text}\n`);
        },
        onTextDelta: (text) => {
          stopPhase();
          // Interactive tasks wait until the complete assistant turn is known
          // before making text persistent. This prevents a streamed draft that
          // is later rejected by a verification/evidence gate from leaking into
          // terminal scrollback. One-shot mode continues to stream directly.
          if (!runningTaskView) emitWrite(text);
        },
        onTextStreamEnd: () => {
          if (!runningTaskView) emitWrite("\n\n");
        },
        onAssistantTurn: (text, hasToolCalls) => {
          if (!hasToolCalls || !runningTaskView) return;
          const narration = runningTaskView.narrate(text);
          if (narration) emitLine(`${chalk.cyan(localize(language, "思考摘要：", "Reasoning summary: "))}${redactTerminalOutput(narration)}\n`);
        },
        onToolStart: (name, description, details) => {
          if (!details.verification) verificationReadyForSummary = false;
          const displayDescription = localizeToolDescription(name, description, language);
          const terminalDescription = compactTerminalDescription(displayDescription);
          activeToolActivity = activities.start("tool", name, displayDescription);
          activeToolDetails = { name, description: terminalDescription, verification: details.verification, risk: details.risk };
          runningTaskView?.beginTool(name, terminalDescription, details.changesWorkspace, details.verification);
          emitLine(`${chalk.cyan(`> ${name}`)} ${chalk.dim(terminalDescription)}`);
          startPhase(localize(language, `正在运行 ${name}`, `Running ${name}`));
        },
        onToolProgress: (name, message) => {
          const displayMessage = localizeToolProgress(message, language);
          if (activeToolActivity) activities.progress(activeToolActivity, displayMessage);
          runningTaskView?.activity(`${name}: ${displayMessage}`);
          startPhase(`${name}: ${displayMessage}`);
        },
        onToolEnd: (_name, result, details) => {
          stopPhase();
          const failed = details ? details.result.status !== "success"
            : /^(?:Tool error:|Tool execution denied|Tool execution blocked by crash recovery:|Unknown tool:|Exit code: (?!0\b)|Process timed out|Command timed out|Verification (?:timed out|unavailable|failed)|(?:Process|Command|Verification) cancelled)/i.test(result);
          if (failed) verificationReadyForSummary = false;
          if (activeToolActivity) activities.finish(activeToolActivity, result, failed);
          activeToolActivity = undefined;
          const summary = redactTerminalOutput(summarizeToolResult(_name, result, language) ?? result.replace(/\s+/g, " ").trim());
          runningTaskView?.activity(`${_name}: ${failed ? localize(language, "失败", "failed") : localize(language, "已完成", "finished")} - ${summary.slice(0, 100)}`);
          // onPlanUpdate already writes the bounded user-facing receipt. Avoid
          // printing the tool result again (historically this was the full plan).
          if (_name !== "update_task_plan") {
            emitLine(`${chalk.dim(summary.length > 240 ? `${summary.slice(0, 240)}... ${localize(language, "（使用 /details 查看完整输出）", "(/details for full output)")}` : summary)}\n`);
          }
          if (!failed && activeToolDetails) {
            if (details?.verification) {
              verificationReadyForSummary = true;
              runningTaskView?.markVerificationPassed();
              runningTaskView?.recordImportantAction(localize(language, `验证通过：${activeToolDetails.description}`, `Verified: ${activeToolDetails.description}`));
            }
            else if (activeToolDetails.risk === "execute" || activeToolDetails.risk === "dangerous") runningTaskView?.recordImportantAction(localize(language, `已执行：${activeToolDetails.description}`, `Ran: ${activeToolDetails.description}`));
          }
          activeToolDetails = undefined;
        },
        onCompletionGate: () => {
          verificationReadyForSummary = false;
          emitLine(chalk.yellow(localize(language, "完成前需要验证。\n", "Verification required before completion.\n")));
        },
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
          const completed = plan.steps.filter((step) => step.status === "completed").length;
          const current = plan.steps.find((step) => step.status === "in_progress")?.title
            ?? plan.steps.find((step) => step.status === "pending")?.title
            ?? localize(language, "等待最终总结", "awaiting final summary");
          emitLine(`${chalk.cyan(localize(language, `任务计划已更新：${completed}/${plan.steps.length}；当前：${compactTerminalDescription(current, 100)}`, `Task plan updated: ${completed}/${plan.steps.length}; now: ${compactTerminalDescription(current, 100)}`))}\n${chalk.dim(localize(language, "完整计划可使用 /tasks 查看。", "Use /tasks to view the full plan."))}\n`);
        },
        onWorkspaceChange: (change) => {
          if (runningTaskView) {
            runningTaskView.recordWorkspaceChange(change);
            emitLine(chalk.yellow(localize(language, `△ 文件变化：${redactTerminalOutput(change.description)}`, `△ File change: ${redactTerminalOutput(change.description)}`)));
            for (const file of change.files) {
              const label = ({ created: localize(language, "已创建", "Created"), modified: localize(language, "已修改", "Modified"), deleted: localize(language, "已删除", "Deleted") } as const)[file.kind];
              const counts = file.additions !== undefined && file.deletions !== undefined ? ` +${file.additions} -${file.deletions}` : "";
              emitLine(`  ${chalk.green("√")} ${label} ${file.path}${counts}`);
              if (file.hunk) emitLine(chalk.dim(`    ${redactTerminalOutput(file.hunk)}`));
              for (const preview of file.preview.slice(0, 8)) {
                const color = preview.startsWith("+") ? chalk.green : preview.startsWith("-") ? chalk.red : chalk.dim;
                emitLine(`    ${color(redactTerminalOutput(preview))}`);
              }
            }
            emitLine();
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
      }),
      restored,
      projectIndex,
      planManager,
      checkpointManager,
      skillRegistry,
      taskRunJournal,
    });
    xiuRuntime.attachDriver(new AgentRuntimeAdapter(agent));
    const attachMcpTools = (): void => agent.replaceTools([...baseTools, ...mcpManager.tools()]);
    const rebuildBaseTools = (): void => { baseTools = buildBaseTools(); };
    const refreshWebSearchRuntime = (): void => {
      managedWebSearchAuth = settings.webSearch?.managedAuth === "xiu-device" && settings.webSearch.authBaseURL
        ? new ManagedWebSearchAuth(settings.webSearch.authBaseURL, undefined, createWebFetch(settings.webSearch.proxy))
        : undefined;
      baseTools = buildBaseTools();
      attachMcpTools();
      agent.reloadInstructions();
    };
    const applyApprovedPlugins = async (restartMcp: boolean): Promise<string[]> => {
      const loaded = await pluginRegistry.loadApprovedContributions();
      try { providerRegistry.setPluginProfiles(loaded.providers); }
      catch (error) {
        providerRegistry.setPluginProfiles([]);
        loaded.errors.push({ pluginId: "provider-registry", message: error instanceof Error ? error.message : String(error) });
      }
      skillRegistry.setPluginFiles(loaded.skillFiles);
      await skillRegistry.refresh(true);
      mcpManager.setPluginServers(loaded.mcpServers);
      baseTools = buildBaseTools();
      if (restartMcp) await mcpManager.start(true);
      attachMcpTools();
      agent.reloadInstructions();
      return loaded.errors.map((entry) => `${entry.pluginId}: ${entry.message}`);
    };
    const ensureMcpReady = async (): Promise<void> => {
      if (mcpStartup) await mcpStartup;
      attachMcpTools();
    };
    if (mcpStartup) {
      // Do not print from this continuation: asynchronous output would corrupt
      // the active line editor. /mcp exposes connection failures on demand.
      void mcpStartup.then(attachMcpTools);
    }
    if (recoverySource) {
      xiuRuntime.recordRecovery({
        runId: recoverySource.runId,
        status: recoverySource.status === "paused" ? "paused" : "recoverable",
        interruptedOperations: recoverySource.interruptedOperations.length,
        unknownSideEffects: recoverySource.pendingSideEffects.length,
        recommendation: recoverySource.recommendation,
      });
      agent.setRecoverySource(recoverySource);
    }
    const featureNames = (profile: ProviderProfile, model = profile.model): string => {
      profile = runtimeProfile(profile, model);
      const names = [localize(language, "文本", "text")];
      if (profile.features.tools) names.push(localize(language, "工具", "tools"));
      if (profile.features.vision) names.push(localize(language, "视觉", "vision"));
      if (profile.features.image) names.push(localize(language, "生图", "image"));
      if (profile.features.video) names.push(localize(language, "视频", "video"));
      if (profile.features.audio) names.push(localize(language, "音频", "audio"));
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
    const policy = createProviderPolicy(providerRegistry, profileConfig, (candidate) => [...buildBaseTools(candidate), ...mcpManager.tools()], language);
    agent.setFailoverController(policy.failover);
    agent.setRoutingController(policy.routing);
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
        console.error(chalk.red(`${formatUserFacingError(localize(language, "Provider 连接失败", "Provider connection failed"), error, language, { sensitive: profile.apiKey ? [profile.apiKey] : [], diagnostic: "/provider test" })}\n`));
        return false;
      }
    };

    const configureStartupProvider = async (): Promise<void> => {
      if (!startupProviderError) return;
      if (!providerRegistry.list().length) {
        // Piped sessions keep the one-line hint so scripts stay predictable; a terminal gets the three-step wizard.
        // The wizard saves nothing until its connection test passes, so leaving it never creates a half-finished channel.
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const outcome = await runFirstRunWizard({
            language,
            registry: providerRegistry,
            env: process.env,
            probe: async (profile) => {
              const probed = await probeProvider(profileConfig(profile));
              return { models: probed.models, discoveryError: probed.discoveryError };
            },
            activate: (profile, model) => switchProviderProfile(profile, true, model),
            io: {
              select: (title, options) => selectTerminalOption(title, options, language),
              ask: askQuestion,
              askSecret,
              log: (line) => console.log(`${line}\n`),
            },
          });
          if (outcome.status === "configured") { startupProviderError = undefined; return; }
        }
        console.log(chalk.yellow(localize(language, "尚未添加任何渠道。请输入 /provider add，选择 Agnes、OpenAI、本地模型或兼容服务；无需先设置环境变量。\n", "No Providers added. Enter /provider add to choose Agnes, OpenAI, a local model, or a compatible service. Environment variables are optional.\n")));
        return;
      }
      console.log(chalk.yellow(localize(language,
        `当前 Provider ${config.providerLabel ?? config.providerId} 尚未配置（${startupProviderError.message}）。Xiu 已进入配置模式，不会退出。`,
        `The current provider ${config.providerLabel ?? config.providerId} is not configured (${startupProviderError.message}). Xiu is staying open in setup mode.`)));
      console.log(chalk.dim(localize(language,
        "你可以现在完成引导，也可以稍后使用 /provider key 保存 Key，或使用 /providers 切换服务。\n",
        "You can finish the guided setup now, or later use /provider key to save a key or /providers to switch services.\n")));

      // Piped/non-interactive sessions must remain scriptable. They receive the
      // same setup guidance, but no prompt is forced in front of their input.
      if (!process.stdin.isTTY || !process.stdout.isTTY) return;

      const action = await selectTerminalOption(localize(language, "首次使用配置", "First-run setup"), [
        {
          label: localize(language, `配置 ${config.providerLabel ?? config.providerId} 的 API Key`, `Configure the API key for ${config.providerLabel ?? config.providerId}`),
          description: localize(language, "Key 仅保存在本机凭证配置中，输入内容不会显示", "The key stays in local credential storage and input is hidden"),
          value: "key" as const,
        },
        {
          label: localize(language, "选择其他 Provider", "Choose another provider"),
          description: localize(language, "可选择 Agnes、本地模型或已经配置的服务", "Choose Agnes, a local model, or another configured service"),
          value: "provider" as const,
        },
        {
          label: localize(language, "稍后配置", "Configure later"),
          description: localize(language, "先进入 xiu>，不会关闭程序", "Continue to xiu> without closing the program"),
          value: "later" as const,
        },
      ], language);

      if (action === "key") {
        try {
          const apiKey = await askSecret(localize(language, "输入 API Key（输入内容不会显示，直接回车取消）：", "API key (input is hidden; press Enter to cancel): "));
          if (!apiKey) return;
          await providerRegistry.setApiKey(config.providerId, apiKey);
          const saved = providerRegistry.get(config.providerId);
          if (!saved) throw new Error(localize(language, "Provider 配置不存在。", "Provider profile not found."));
          if (await switchProviderProfile(saved, true, config.model)) startupProviderError = undefined;
        } catch (error) {
          console.error(chalk.red(`${formatUserFacingError(localize(language, "配置 Provider 失败", "Could not configure provider"), error, language)}\n`));
        }
        return;
      }

      if (action === "provider") {
        const profiles = providerRegistry.list();
        const selected = await selectTerminalOption(localize(language, "选择 Provider", "Choose a provider"), profiles.map((profile) => ({
          label: profile.name,
          description: `${profile.id} · ${profile.kind} · ${profile.model} · ${featureNames(profile)}`,
          value: profile.id,
        })), language);
        if (selected && await switchProviderProfile(providerRegistry.get(selected)!)) startupProviderError = undefined;
      }
    };

    /**
     * Saves the bounded, redacted change report of the run that just finished to
     * `.xiu/task-change-history/<runId>.json`, the same record the desktop writes, so that
     * `/diff run:<selector>` can replay it later. Never throws; a failure is only reported.
     */
    const persistTaskChangeHistory = async (baseline: TaskChangeSnapshot | undefined): Promise<void> => {
      if (!baseline) return;
      try {
        const sessionId = agent.status().sessionId;
        const run = (await taskRunJournal.recent(20)).find((candidate) => candidate.status !== "running"
          && (!sessionId || candidate.sessionId === sessionId) && candidate.startedAt >= baseline.capturedAt);
        if (!run) return;
        const report = await inspectTaskChanges(config.cwd, baseline, { sensitiveValues: config.apiKey ? [config.apiKey] : [] });
        await saveTaskChangeHistory(config.cwd, run.runId, report);
      } catch (error) {
        emitLine(chalk.dim(redactTerminalOutput(localize(language,
          `未能保存本次运行的改动记录：${error instanceof Error ? error.message : String(error)}。/diff task 仍可查看本次改动。`,
          `Could not save this run's change record: ${error instanceof Error ? error.message : String(error)}. /diff task still shows this task's changes.`))));
      }
    };

    const runWithTaskBaseline = async (task: string, onStarted?: () => void): Promise<string> => {
      if (!providerRegistry.get(config.providerId)) throw new Error(localize(language, "尚未配置渠道，请先使用 /provider add 或 /providers。", "No Provider configured. Use /provider add or /providers first."));
      const preparation = new AbortController();
      activeTaskPreparationController = preparation;
      latestTaskBaseline = undefined;
      emitLine(chalk.cyan(localize(language, "已接收任务，正在记录开始时的文件状态。", "Task received; recording the starting file state.")));
      startPhase(localize(language, "正在准备任务", "Preparing task"));
      try {
        latestTaskBaseline = await captureTaskBaseline(config.cwd, { sensitiveValues: config.apiKey ? [config.apiKey] : [] });
      } catch (error) {
        emitLine(chalk.yellow(redactTerminalOutput(localize(language,
          `无法记录任务改动起点：${error instanceof Error ? error.message : String(error)}。可使用 /diff workspace 查看工作区。`,
          `Could not record the task baseline: ${error instanceof Error ? error.message : String(error)}. Use /diff workspace to inspect the workspace.`))));
      } finally {
        if (activeTaskPreparationController === preparation) activeTaskPreparationController = undefined;
      }
      if (preparation.signal.aborted) {
        stopPhase();
        throw new Error(localize(language, "任务已在准备阶段取消。", "Task cancelled during preparation."));
      }
      onStarted?.();
      const baseline = latestTaskBaseline;
      try {
        return await xiuRuntime.createTask(task);
      } finally {
        await persistTaskChangeHistory(baseline);
      }
    };

    const printDiff = async (command: string): Promise<void> => {
      const parsed = parseDiffCommand(command);
      if (parsed.kind === "usage") {
        console.log(chalk.yellow(`${diffUsage(language)}\n`));
        return;
      }
      if (parsed.kind === "runs" || parsed.kind === "run") {
        try {
          const sources = { cwd: config.cwd, taskRunJournal };
          const output = parsed.kind === "runs" ? await formatRunChangeList(sources, language) : await replayRunChanges(sources, parsed.selector, parsed.file, language);
          console.log(`${redactTerminalOutput(output)}\n`);
        } catch (error) {
          console.error(chalk.red(redactTerminalOutput(`${describeFailure(localize(language, "读取改动记录失败", "Could not read the change record"), error, language)}\n`)));
        }
        return;
      }
      const requested = parsed.view;
      if (requested === "task" && !latestTaskBaseline) {
        console.log(chalk.dim(localize(language,
          "本次会话还没有任务起点快照。恢复的历史会话不会重建旧快照；使用 /diff runs 回放以前运行保存的改动，或用 /diff workspace、/diff staged 查看当前状态。\n",
          "No task baseline is available in this session. Historical baselines are not reconstructed on resume; use /diff runs to replay the changes saved for earlier runs, or /diff workspace and /diff staged for the current state.\n")));
        return;
      }
      try {
        const diffOptions = { sensitiveValues: config.apiKey ? [config.apiKey] : [] };
        const report = requested === "task"
          ? await inspectTaskChanges(config.cwd, latestTaskBaseline!, diffOptions)
          : await getWorkspaceDiff(config.cwd, requested, diffOptions);
        console.log(`${redactTerminalOutput(formatTaskChanges(report, language))}\n`);
      } catch (error) {
        console.error(chalk.red(redactTerminalOutput(`${describeFailure(localize(language, "读取改动失败", "Could not inspect changes"), error, language)}\n`)));
      }
    };

    const checkStatusLabel = (value: ProjectCheckStatus): string => ({
      passed: localize(language, "脚本通过（退出码 0）", "script passed (exit 0)"),
      failed: localize(language, "失败", "failed"),
      cancelled: localize(language, "已取消", "cancelled"),
      denied: localize(language, "已拒绝", "denied"),
      skipped: localize(language, "已跳过", "skipped"),
    })[value];
    const printCheckSummary = (result: ProjectCheckRun): void => {
      console.log(localize(language,
        `检查结果：${result.counts.passed} 通过 / ${result.counts.failed} 失败 / ${result.counts.cancelled} 取消 / ${result.counts.denied} 拒绝 / ${result.counts.skipped} 跳过 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`,
        `Checks: ${result.counts.passed} passed / ${result.counts.failed} failed / ${result.counts.cancelled} cancelled / ${result.counts.denied} denied / ${result.counts.skipped} skipped · ${(result.elapsedMs / 1000).toFixed(1)}s`));
      console.log(chalk.dim(localize(language, "通过仅表示脚本退出码为 0，不保证功能正确；后续改动需要重新检查。\n", "Passed means the script exited with code 0, not a guarantee of functional correctness; rerun after changes.\n")));
    };
    const handleCheckCommand = async (command: string): Promise<void> => {
      const selection = command.slice("/check".length).trim();
      if (selection && selection !== "all" && !(PROJECT_CHECK_NAMES as readonly string[]).includes(selection)) {
        console.log(chalk.yellow(localize(language, "用法：/check [typecheck|lint|test|build|all]\n", "Usage: /check [typecheck|lint|test|build|all]\n")));
        return;
      }
      const controller = new AbortController();
      activeCheckController = controller;
      const checkContext = { cwd: config.cwd, signal: controller.signal, approve: approveRequest };
      const sensitiveValues = config.apiKey ? [config.apiKey] : [];
      try {
        if (!selection) {
          const discovery = await discoverProjectChecks(checkContext, { sensitiveValues });
          if (discovery.error) console.log(chalk.yellow(redactTerminalOutput(discovery.error)));
          for (const check of discovery.checks) {
            console.log(check.available
              ? `${chalk.cyan(check.name)}\n${redactTerminalOutput(projectCheckPreview(check))}\n`
              : chalk.dim(`${check.name}: ${redactTerminalOutput(check.reason ?? localize(language, "不可用", "unavailable"))}`));
          }
          if (latestProjectCheck) {
            console.log(chalk.dim(localize(language, "上次检查记录（未重新运行）：", "Previous check record (not rerun):")));
            for (const check of latestProjectCheck.checks) console.log(`${check.name}: ${checkStatusLabel(check.status)}`);
            printCheckSummary(latestProjectCheck);
          }
          console.log(chalk.dim(localize(language, "使用 /check <检查名> 或 /check all 执行。\n", "Run /check <name> or /check all to execute.\n")));
          return;
        }
        const checkActivities = new Map<string, string>();
        latestProjectCheck = await runProjectChecks(selection as ProjectCheckSelection, checkContext, {
          planMode: agent.status().planMode,
          sensitiveValues,
          onCheckStart: (check) => {
            console.log(`${chalk.cyan(localize(language, "准备运行项目检查", "Preparing project check"))}\n${redactTerminalOutput(projectCheckPreview(check))}`);
            checkActivities.set(check.name, activities.start("tool", "validate_project", check.command));
            status.start(localize(language, `正在检查 ${check.name} · Ctrl+C 取消`, `Checking ${check.name} · Ctrl+C to cancel`));
          },
          onCheckResult: (check) => {
            status.stop();
            const activity = checkActivities.get(check.name);
            if (activity) activities.finish(activity, check.output, check.status !== "passed");
            const label = `${check.name}: ${checkStatusLabel(check.status)} · ${(check.elapsedMs / 1000).toFixed(1)}s`;
            console.log(check.status === "passed" ? chalk.green(label) : check.status === "failed" ? chalk.red(label) : chalk.yellow(label));
            if (check.status !== "passed" && check.output) {
              const output = redactTerminalOutput(check.output);
              console.log(chalk.dim(output.length > 2_000 ? `${output.slice(0, 2_000)}\n${localize(language, "（使用 /details 查看完整输出）", "(/details for full output)")}` : output));
            }
          },
        });
        printCheckSummary(latestProjectCheck);
        projectIndex.invalidate();
      } catch (error) {
        console.error(chalk.red(redactTerminalOutput(`${describeFailure(localize(language, "项目检查失败", "Project check failed"), error, language)}\n`)));
      } finally {
        status.stop();
        if (activeCheckController === controller) activeCheckController = undefined;
      }
    };

    const onSigint = () => {
      status.stop();
      if (activeCheckController) {
        activeCheckController.abort();
        console.log(chalk.yellow(localize(language, "\n正在取消项目检查……", "\nCancelling project checks...")));
      } else if (activeTaskPreparationController) {
        activeTaskPreparationController.abort();
        console.log(chalk.yellow(localize(language, "\n正在取消任务准备……", "\nCancelling task preparation...")));
      } else if (xiuRuntime.stopTask()) {
        runningTaskView?.setPhase(localize(language, "正在取消", "Cancelling"));
        console.log(chalk.yellow(localize(language, "\n正在取消当前任务……", "\nCancelling current task...")));
      }
      else console.log(chalk.dim(localize(language, "\n使用 /exit 退出 Xiu。", "\nUse /exit to leave Xiu.")));
    };
    process.on("SIGINT", onSigint);

    if (startupProviderError && initialTask) {
      const message = localize(language,
        `当前 Provider 尚未配置：${startupProviderError.message}。请先运行 xiu，并按引导配置 Provider 后再执行一次性任务。`,
        `The current provider is not configured: ${startupProviderError.message}. Run xiu first and complete provider setup before starting a one-shot task.`);
      console.error(chalk.red(message));
      process.exitCode = jsonStream ? jsonStream.result({ outcome: "not_started", error: redactTerminalOutput(message) }) : 1;
      return;
    }

    await configureStartupProvider();

    if (initialTask) {
      let taskStarted = false;
      const taskStartedAt = Date.now();
      jsonStream?.started({ version: packageJson.version, provider: config.providerId, model: config.model, workspace: config.cwd, language });
      try {
        await runWithTaskBaseline(initialTask, () => { taskStarted = true; });
      } catch (error) {
        if (!jsonStream) throw error;
        process.exitCode = jsonStream.result({ outcome: taskStarted ? agent.status().outcome : "not_started", error: redactTerminalOutput(error instanceof Error ? error.message : String(error)), durationMs: Date.now() - taskStartedAt });
        return;
      } finally {
        if (taskStarted) await agent.recordReplayTurn({
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
        }).catch((error: unknown) => {
          // Session history is a convenience, never a gate on the task result, but a
          // one-shot run must still say when this turn will be missing from /resume.
          emitLine(chalk.dim(redactTerminalOutput(localize(language,
            `未能保存本轮会话记录：${error instanceof Error ? error.message : String(error)}。任务结果不受影响，但 /resume 不会看到这一轮。`,
            `Could not save this turn to the session history: ${error instanceof Error ? error.message : String(error)}. The task result is unaffected, but /resume will not show this turn.`))));
        });
      }
      if (jsonStream) {
        const finished = agent.status();
        const snapshot = xiuRuntime.snapshot();
        const { modelCalls, toolCalls, inputTokens, outputTokens, estimatedTokens } = finished.stats;
        process.exitCode = jsonStream.result({
          outcome: finished.outcome,
          failureReason: finished.failureReason,
          completionIssues: finished.completionIssues?.length ? finished.completionIssues : undefined,
          pendingQuestion: snapshot.task?.pendingQuestion?.question,
          stats: { modelCalls, toolCalls, inputTokens, outputTokens, estimatedTokens },
          durationMs: Date.now() - taskStartedAt,
        });
        return;
      }
      // Same contract as --json: 0 completed, 2 unverified, 3 waiting for an answer, 1 failed, cancelled or paused.
      process.exitCode = oneShotExitCode(agent.status().outcome);
      return;
    }

    console.log(chalk.dim(localize(language, "交互模式 · 输入 / 查看命令 · Ctrl+C 或 /exit 退出\n", "Interactive mode · type / for commands · Ctrl+C or /exit to quit\n")));
    const inputHistory: string[] = [];
    let awaitingReply: { question: string; originalTask: string } | undefined;
    const updateCommands = new UpdateCommandController({
      currentVersion: packageJson.version,
      language,
      settings,
      saveSettings: () => settingsStore.save(settings),
    });
    for (const message of await updateCommands.initialize()) printUpdateMessage(message);
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
        backgroundTasks: background.list().filter((item) => item.running).length,
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
        xiuRuntime.steerTask(localize(selected,
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
        let taskStarted = false;
        const runPromise = runWithTaskBaseline(current.text, () => { taskStarted = true; })
          .then((response) => { finalResponse = response; })
          .catch((error) => { failure = error; })
          .finally(() => {
            view.clearDraftPreview();
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
              activeTaskPreparationController?.abort();
              xiuRuntime.stopTask();
            },
            onToggleDetails: () => { view.toggleDetails(); },
            onPaste: () => clipboard.paste(),
            enableRightClickPaste: rightClickPasteEnabled,
            liveOutput: () => view.drain(),
            signal: inputController.signal,
            refreshMs: 250,
            language,
            persistPrompt: false,
            ignoreEmptySubmit: true,
          })).trim();
          if (activeQueuedInputController === inputController) activeQueuedInputController = undefined;
          const liveChanges = view.drainWorkspaceChanges();
          replayChanges.push(...liveChanges);
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
            activeTaskPreparationController?.abort();
            xiuRuntime.stopTask();
            console.log(chalk.yellow(localize(language, "正在取消当前任务，排队任务会保留。\n", "Cancelling current task. Queued follow-ups are preserved.\n")));
            break;
          }
          if (followUp === "/exit" || followUp === "/quit") {
            exitRequested = true;
            queue.clear();
            activeTaskPreparationController?.abort();
            xiuRuntime.stopTask();
            console.log(chalk.yellow(localize(language, "退出前正在取消当前任务。\n", "Cancelling current task before exit.\n")));
            break;
          }
          if (await handleRunningTaskCommand(followUp, { agent, applyRuntimeLanguage, chooseRuntimeLanguage, clipboard, draftStore, language, managedWebSearchAuth: () => managedWebSearchAuth, printCredentialStatus, printDiff, queue, settings, view })) continue;
          const unhandledFollowUp = explainUnhandledSlashInput(followUp, { runningCommandWords: RUNNING_TASK_COMMAND_WORDS });
          if (unhandledFollowUp) {
            console.log(chalk.yellow(`${formatSlashInputProblem(unhandledFollowUp, language)}\n`));
            continue;
          }

          if (!settled && xiuRuntime.steerTask(followUp)) {
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
        const remainingLiveOutput = view.drain();
        if (remainingLiveOutput) process.stdout.write(persistentLiveOutput(remainingLiveOutput));
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
        if (taskStarted) await agent.recordReplayTurn({
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
        if (!failure && agent.status().outcome === "failed") failure = new Error(incompleteTaskMessage(agent.status().failureReason, language));
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
      for (const message of updateCommands.flushPendingReminder()) printUpdateMessage(message);
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
        if (mcpConfigError) console.log(chalk.yellow(`${formatUserFacingError(localize(language, "未加载 MCP 配置", "MCP configuration was not loaded"), mcpConfigError, language)}\n`));
      }
      if (task === "/exit" || task === "/quit") break;
      if (task === "/recover") {
        let interrupted: InterruptedTaskRun | undefined;
        try { interrupted = await taskRunJournal.interrupted(); }
        catch (error) {
          console.error(chalk.red(`${describeFailure(localize(language, "任务恢复日志无法读取", "Could not read the task recovery journal"), error, language)}\n`));
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
          console.error(chalk.red(`${describeFailure(localize(language, "无法加载关联会话", "Could not load the linked session"), error, language)}\n`));
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
        latestTaskBaseline = undefined;
        latestProjectCheck = undefined;
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
          latestTaskBaseline = undefined;
          latestProjectCheck = undefined;
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
            record.kind === "image" ? localize(language, "图片", "image") : record.kind === "video" ? localize(language, "视频", "video") : localize(language, "音频", "audio"),
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
      if (await handleProviderCommand(task, { agent, attachMcpTools, compactCapabilityProbeSummary, config, featureNames, language, profileConfig, providerRegistry, rebuildBaseTools, startupProfile, status, switchProviderProfile })) continue;
      if (task === "/clear") {
        agent.clearConversation();
        latestTaskBaseline = undefined;
        latestProjectCheck = undefined;
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
        const { sessions, unreadable } = await listSessionsWithIssues(config.cwd);
        const note = unreadableSessionsNote(unreadable, language);
        console.log([
          sessions.length ? sessions.map((session) => `${session.id}  ${session.updatedAt}  ${session.firstTask.slice(0, 72)}`).join("\n") : localize(language, "没有已保存会话。", "No saved sessions."),
          ...(note ? [chalk.yellow(note)] : []),
        ].join("\n") + "\n");
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
      if (task === "/diff" || task.startsWith("/diff ")) {
        await printDiff(task);
        continue;
      }
      if (task === "/check" || task.startsWith("/check ")) {
        await handleCheckCommand(task);
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
          console.error(chalk.red(`${describeFailure(localize(language, "剪贴板粘贴失败", "Clipboard paste failed"), error, language)}\n`));
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
      if (await handleWebCommand(task, { auditCredential, language, managedWebSearchAuth: () => managedWebSearchAuth, refreshWebSearchRuntime, settings, settingsStore })) continue;
      if (await handlePluginCommand(task, { applyApprovedPlugins, config, language, pluginRegistry, status })) continue;
      if (await handleSkillCommand(task, { agent, language, skillRegistry, status })) continue;
      if (await handleMcpCommand(task, { attachMcpTools, auditCredential, ensureMcpSystemCredentialStore, language, mcpManager, projectMcpTrusted, status })) continue;
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
            const plan = await coordinator.analyzeIntegration(parts[2], parts[3]);
            console.log(`${formatIntegrationPlan(plan, language)}\n`);
            if (!plan.canIntegrate) {
              console.log(chalk.red(localize(language, "合并已被冲突或证据门禁阻止；主工作区和 Agent Worktree 均未修改。\n", "Integration is blocked by conflicts or evidence gates; the main workspace and Agent Worktree were not modified.\n")));
              continue;
            }
            const answer = await askQuestion(chalk.yellow("[write]") + localize(language, ` 将此 Agent 补丁合并到 ${config.cwd}？[y/N] `, ` Integrate this Agent patch into ${config.cwd}? [y/N] `));
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
          console.error(chalk.red(`${describeFailure(localize(language, "Agent 命令失败", "Agent command failed"), error, language)}\n`));
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
      if (await handleBackgroundCommand(task, { config, language, background })) continue;
      if (await handleReportCommand(task, { agent, config, language, securityAudit, taskRunJournal })) continue;
      if (await handleCredentialCommand(task, { auditCredential, config, ensureSystemCredentialStore, formatCredentialProbe, language, printCredentialStatus, providerRegistry, switchProviderProfile })) continue;
      if (task === "/queue" || task.startsWith("/queue ") || task === "/clear-queue" || task === "/cancel") {
        const word = task.split(/\s+/)[0]!;
        console.log(chalk.dim(localize(language, `${word} 仅在任务运行时可用。\n`, `${word} is available while a task is running.\n`)));
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
          `Agents：${coordinator.list().filter((run) => run.status === "running").length} 个运行中 / ${coordinator.list().length} 个已保存`, `后台：${background.list().filter((item) => item.running).length} 个运行中`,
          `活动：${activities.list().length} 条记录（/details）`,
        ].join("\n") + "\n" : [
          `Session: ${current.sessionId ?? "not started"}`, `Provider: ${config.providerId} (${config.provider})`, `Model: ${current.model}`, `Capabilities: ${featureNames(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `Capability probe: ${capabilityProbeSummary(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `Language: English`, `Plan mode: ${current.planMode ? "ON (read-only)" : "OFF"}`, `Last outcome: ${current.outcome}`,
          `Turn: ${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : " (unlimited)"}`, `Pending steering: ${current.pendingSteering}`, `Messages: ${current.messages}`,
          `Context estimate: ~${current.stats.estimatedTokens.toLocaleString()} tokens`, `Auto compact: ${current.contextLimit.toLocaleString()} tokens (${current.contextLimitMode})`,
          `Model window: ${current.contextWindow.toLocaleString()} tokens (${current.contextWindowSource})`, `API tokens: ${current.stats.inputTokens.toLocaleString()} in / ${current.stats.outputTokens.toLocaleString()} out`,
          `Calls: ${current.stats.modelCalls} model / ${current.stats.toolCalls} tool`, `Compactions: ${current.stats.compactions}`, `Active time: ${(current.stats.activeMs / 1000).toFixed(1)}s`,
          `Latest task diagnostics: ${current.diagnostics ? formatTaskDiagnosticSummary(current.diagnostics, language) : "none"}`,
          indexStatusEn, `MCP: ${mcpManager.status().filter((server) => server.state === "connected").length} servers / ${mcpManager.tools().length} tools`,
          `Agents: ${coordinator.list().filter((run) => run.status === "running").length} running / ${coordinator.list().length} saved runs`, `Background: ${background.list().filter((item) => item.running).length} running`,
          `Activities: ${activities.list().length} recorded (/details)`,
        ].join("\n") + "\n");
        continue;
      }
      const updateCommand = await updateCommands.execute(task);
      if (updateCommand.handled) {
        for (const message of updateCommand.messages) printUpdateMessage(message);
        continue;
      }
      if (task === "/doctor") {
        status.start(localize(language, "正在生成诊断报告", "Collecting diagnostics"));
        try {
          const report = await collectDoctorReport({ version: packageJson.version, settings, registry: providerRegistry, cwd: config.cwd, sensitive: config.apiKey ? [config.apiKey] : [] });
          status.stop();
          console.log(`${formatDoctorReport(report, language)}\n`);
        } catch (error) {
          status.stop();
          console.error(chalk.red(`${formatUserFacingError(localize(language, "诊断报告生成失败", "Could not build the diagnostics report"), error, language)}\n`));
        }
        continue;
      }
      if (task === "/help" || task.startsWith("/help ")) {
        const topic = task.slice("/help".length).trim();
        const entries = helpEntriesFor(topic, language);
        if (entries.length) console.log(`${entries.map((command) => `${command.name.padEnd(20)} ${command.description}`).join("\n")}\n`);
        else console.log(chalk.yellow(`${formatSlashInputProblem(explainUnhandledSlashInput(topic.startsWith("/") ? topic : `/${topic}`, { pathExists: () => false }) ?? { kind: "unknown-command", word: topic, suggestions: [] }, language)}\n`));
        continue;
      }
      const unhandledInput = explainUnhandledSlashInput(task);
      if (unhandledInput) {
        console.log(chalk.yellow(`${formatSlashInputProblem(unhandledInput, language)}\n`));
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
        console.error(chalk.red(`${describeFailure(localize(language, "错误", "Error"), error, language)}\n`));
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
  const message = error instanceof Error ? error.message : String(error);
  // A failure the catalog explains (a damaged configuration file, a provider configuration problem, a network or
  // HTTP error) is shown as its cause, the next step and the diagnostic command; anything else keeps its raw message.
  const code = explainError(error, startupLanguage).code;
  const heading = code === "unknown" ? "Error"
    : code.startsWith("provider-config/") ? localize(startupLanguage, "无法加载渠道配置", "Provider configuration could not be loaded")
      : localize(startupLanguage, "Xiu 无法启动", "Xiu could not start");
  console.error(chalk.red(describeFailure(heading, error, startupLanguage, { diagnostic: "xiu doctor" })));
  // The `result` line keeps the raw message: scripts match on it, and the explanation above went to stderr.
  process.exitCode = jsonStream ? jsonStream.result({ outcome: "not_started", error: message }) : 1;
});
