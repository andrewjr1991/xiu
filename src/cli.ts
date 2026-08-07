#!/usr/bin/env node
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { Agent } from "./agent.js";
import { listBackgroundProcesses, stopAllBackgroundProcesses } from "./background.js";
import { ActivityLog } from "./activity.js";
import { continueTaskAfterAnswer, parseAssistantInteraction } from "./assistant-interaction.js";
import { CheckpointManager } from "./checkpoint.js";
import { ClipboardAttachmentManager } from "./clipboard.js";
import { resolveConfig } from "./config.js";
import { languageName, localize, normalizeLanguage, type UiLanguage } from "./i18n.js";
import { DraftStore } from "./draft.js";
import { createProvider } from "./providers.js";
import { createMediaTools } from "./media-tools.js";
import { McpManager } from "./mcp.js";
import { createMultiAgentTools, formatAgentRun, MultiAgentCoordinator, selectSubagentTools, type SubagentTask } from "./multi-agent.js";
import { readInteractiveInput, selectTerminalOption, type SlashCommand } from "./interactive-ui.js";
import { createProjectIndexTools, ProjectIndex } from "./project-index.js";
import { createPlanTools, TaskPlanManager } from "./plan.js";
import { listSessions, loadSession } from "./session.js";
import { createSkillTools, SkillRegistry } from "./skills.js";
import { StatusLine } from "./status.js";
import { SettingsStore } from "./settings.js";
import { renderTerminalMarkdown } from "./terminal-markdown.js";
import { localizeToolDescription, localizeToolProgress } from "./tool-display.js";
import { failureRecoveryOptions, formatRunningInputFooter, RunningTaskView, TaskInputQueue } from "./task-queue.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import { builtinTools } from "./tools.js";
import { isWorkspaceTrusted, trustWorkspace } from "./trust.js";
import { formatPromptDashboard, renderWelcome } from "./welcome.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

function slashCommands(language: UiLanguage): SlashCommand[] {
  const item = (name: string, zh: string, en: string): SlashCommand => ({ name, description: localize(language, zh, en) });
  return [
    item("/resume", "选择并恢复项目会话", "Choose and restore a project session"),
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
    item("/language", "设置界面与会话语言", "Set interface and conversation language"),
    item("/skills", "浏览或安装 Xiu 技能", "Browse or install Xiu skills"),
    item("/skills install", "安装本地或 HTTPS Git 技能包", "Install a local or HTTPS Git skill package"),
    item("/mcp", "查看 MCP 服务和工具", "Show connected MCP servers and tools"),
    item("/mcp reload", "重新加载 MCP 配置", "Reload user and project MCP configuration"),
    item("/agents", "查看多 Agent 运行和任务状态", "Show multi-agent runs and task status"),
    item("/agents cancel", "取消一个 Agent 任务", "Cancel one agent task"),
    item("/agents retry", "重试中断或失败的 Agent", "Retry one interrupted or failed agent"),
    item("/agents integrate", "审查并集成 Worktree Agent", "Review and integrate a Worktree agent"),
    item("/details", "浏览完整工具与 Agent 活动", "Browse complete tool and Agent activity details"),
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
  .option("-p, --provider <provider>", "openai, anthropic, or agnes")
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
  const config = resolveConfig({ ...options, language: options.language ?? process.env.XIU_LANGUAGE ?? settings.language });
  let language = config.language ?? "en-US";
  const stat = await fs.stat(config.cwd).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Workspace does not exist: ${config.cwd}`);

  const status = new StatusLine();
  const activities = new ActivityLog();
  const mcpManager = new McpManager(config.cwd);
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
    const mayReadProjectSkills = Boolean(initialTask) || await isWorkspaceTrusted(config.cwd);
    await skillRegistry.refresh(mayReadProjectSkills);
    if (initialTask) {
      console.log(chalk.bold(`\nXiu - ${config.provider}/${config.model}`));
      console.log(chalk.dim(`${localize(language, "工作区", "Workspace")}: ${config.cwd}\n`));
    } else {
      renderWelcome(config, packageJson.version, skillRegistry.list().length);
    }

    const windowsDirectory = process.env.WINDIR;
    if (windowsDirectory && config.cwd.toLowerCase() === path.join(windowsDirectory, "System32").toLowerCase()) {
      console.log(chalk.yellow(localize(language, "警告：Xiu 正在 Windows System32 中运行。请退出并进入项目目录后重新启动，以免误改系统文件。\n", "Warning: Xiu is running in Windows System32. Exit, enter your project directory, and start Xiu there before making changes.\n")));
    }

    if (!initialTask && !(await confirmWorkspaceTrust(config.cwd, language))) return;
    await skillRegistry.refresh(true);
    status.start(localize(language, "正在连接 MCP 服务", "Connecting MCP servers"));
    let mcpStatuses = [] as ReturnType<McpManager["status"]>;
    let mcpConfigError: unknown;
    const projectMcpTrusted = await isWorkspaceTrusted(config.cwd);
    try { mcpStatuses = await mcpManager.start(projectMcpTrusted); }
    catch (error) { mcpConfigError = error; }
    finally { status.stop(); }
    if (mcpConfigError) console.log(chalk.yellow(localize(language, `未加载 MCP 配置：${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`, `MCP configuration was not loaded: ${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`)));
    if (!projectMcpTrusted && initialTask && await fs.stat(path.join(config.cwd, ".xiu", "mcp.json")).then(() => true).catch(() => false)) {
      console.log(chalk.yellow(localize(language, "工作区尚未信任，因此已跳过项目 MCP 配置。请先以交互方式启动 Xiu 并确认信任。\n", "Project MCP configuration was skipped because this workspace has not been trusted. Start interactive Xiu once to review and trust it.\n")));
    }
    if (mcpStatuses.length) {
      const connected = mcpStatuses.filter((server) => server.state === "connected");
      const failed = mcpStatuses.filter((server) => server.state === "failed");
      console.log(chalk.dim(localize(language, `MCP：${connected.length} 个已连接，${mcpManager.tools().length} 个工具${failed.length ? `，${failed.length} 个失败` : ""}。使用 /mcp 查看详情。\n`, `MCP: ${connected.length} connected, ${mcpManager.tools().length} tools${failed.length ? `, ${failed.length} failed` : ""}. Use /mcp for details.\n`)));
    }
    if (resumeRequested && !restored) {
      restored = await chooseSession(config.cwd, language);
      if (!restored) {
        console.log(chalk.dim(localize(language, "未选择会话，将开始新会话。\n", "No session selected. Starting a new session.\n")));
      }
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
    if (restored) console.log(chalk.green(localize(language, `已恢复会话 ${restored.id}`, `Resumed session ${restored.id}`)), chalk.dim(localize(language, `（${restored.messages.length} 条消息）\n`, `(${restored.messages.length} messages)\n`)));

    const planManager = new TaskPlanManager(restored?.plan, restored?.planMode, language);
    const checkpointManager = new CheckpointManager(config.cwd, restored?.id);
    let runningTaskView: RunningTaskView | undefined;
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
    const approveRequest = async (request: Parameters<ConstructorParameters<typeof Agent>[3]>[0]): Promise<boolean> => {
      let release!: () => void;
      const previous = approvalQueue;
      approvalQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      let finishActiveApproval!: () => void;
      try {
        if (config.autoApprove && request.risk !== "dangerous") return true;
        activeApproval = new Promise<void>((resolve) => { finishActiveApproval = resolve; });
        status.stop();
        activeQueuedInputController?.abort();
        runningTaskView?.discard();
        if (!process.stdin.isTTY) return false;
        if (request.preview) console.log(`${chalk.dim(localize(language, "拟议修改：", "Proposed change:"))}\n${request.preview}\n`);
        const selected = await selectTerminalOption(localize(language, `${request.risk.toUpperCase()} 审批：允许 Xiu ${request.description}？`, `${request.risk.toUpperCase()} approval: allow Xiu to ${request.description}?`), [
          { label: localize(language, "否，拒绝", "No, deny"), description: localize(language, "不执行此操作", "Do not run this operation"), value: false },
          { label: localize(language, "是，仅允许一次", "Yes, allow once"), description: request.description, value: true },
        ], language);
        return selected === true;
      } finally {
        finishActiveApproval?.();
        release();
      }
    };

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
          },
          undefined,
          childIndex,
          childPlan,
          childCheckpoint,
          skillRegistry,
        );
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
    const baseTools = [...builtinTools, ...createProjectIndexTools(projectIndex), ...createPlanTools(planManager), ...createSkillTools(skillRegistry), ...createMediaTools(config), ...coordinatorTools];
    const tools = [...baseTools, ...mcpManager.tools()];
    const provider = createProvider(config);

    let activeToolActivity: string | undefined;
    let activeToolDetails: { name: string; description: string; verification: boolean; risk: "read" | "write" | "execute" | "dangerous" } | undefined;
    const agent = new Agent(
      config,
      provider,
      tools,
      approveRequest,
      {
        onModelStart: (turn) => {
          runningTaskView?.setTurn(turn, config.maxTurns);
          runningTaskView?.activity(localize(language, `模型第 ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} 轮开始`, `Model turn ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} started`));
          startPhase(localize(language, "思考中", "Thinking"));
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
          const failed = /^(Tool error:|Exit code: (?!0\b)|Command timed out|Verification timed out|Verification unavailable)/i.test(result);
          if (activeToolActivity) activities.finish(activeToolActivity, result, failed);
          activeToolActivity = undefined;
          const summary = result.replace(/\s+/g, " ").trim();
          runningTaskView?.activity(`${_name}: ${failed ? localize(language, "失败", "failed") : localize(language, "已完成", "finished")} - ${summary.slice(0, 100)}`);
          emitLine(`${chalk.dim(summary.length > 240 ? `${summary.slice(0, 240)}... ${localize(language, "（使用 /details 查看完整输出）", "(/details for full output)")}` : summary)}\n`);
          if (!failed && activeToolDetails) {
            if (activeToolDetails.verification) runningTaskView?.recordImportantAction(localize(language, `验证通过：${activeToolDetails.description}`, `Verified: ${activeToolDetails.description}`));
            else if (activeToolDetails.risk === "execute" || activeToolDetails.risk === "dangerous") runningTaskView?.recordImportantAction(localize(language, `已执行：${activeToolDetails.description}`, `Ran: ${activeToolDetails.description}`));
          }
          activeToolDetails = undefined;
        },
        onCompletionGate: () => emitLine(chalk.yellow(localize(language, "完成前需要验证。\n", "Verification required before completion.\n"))),
        onCompaction: (message) => startPhase(message),
        onRetry: (message) => startPhase(localizeToolProgress(message, language)),
        onFailure: (message) => {
          stopPhase();
          runningTaskView?.activity(`${localize(language, "失败", "Failure")}: ${message}`);
          emitLine(chalk.red(`${message}\n`));
        },
        onPlanUpdate: (plan) => {
          runningTaskView?.setPlan(plan);
          emitLine(`${chalk.cyan(localize(language, "任务计划已更新", "Task plan updated"))}\n${chalk.dim(planManager.format())}\n`);
        },
        onWorkspaceChange: (change) => {
          if (runningTaskView) {
            runningTaskView.recordWorkspaceChange(change);
            activeQueuedInputController?.abort();
          } else printWorkspaceChanges([change]);
        },
        onCheckpoint: (message) => emitLine(chalk.dim(`${message}\n`)),
        onTaskComplete: (summary) => {
          runningTaskView?.markFinishing();
          const verification = summary.changed ? (summary.verified ? localize(language, "已验证", "verified") : localize(language, "已尝试验证", "verification noted")) : localize(language, "无文件变化", "no changes");
          const message = localize(language,
            `${summary.outcome === "completed" ? "✓ 已完成" : "! 未验证完成"} · ${(summary.durationMs / 1000).toFixed(1)} 秒 · ${summary.turns} 轮模型调用 · ${summary.toolCalls} 次工具调用 · ${verification}`,
            `${summary.outcome === "completed" ? "✓ Done" : "! Stopped unverified"} · ${(summary.durationMs / 1000).toFixed(1)}s · ${summary.turns} model turn(s) · ${summary.toolCalls} tool call(s) · ${verification}`);
          if (runningTaskView) runningTaskView.setCompletion(message, summary.outcome === "completed");
          else emitLine(summary.outcome === "completed" ? chalk.green(message) : chalk.yellow(message));
        },
      },
      restored,
      projectIndex,
      planManager,
      checkpointManager,
      skillRegistry,
    );

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
      await agent.run(initialTask);
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
        model: dashboard.model,
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

    const runTaskSequence = async (firstTask: string): Promise<boolean> => {
      const queue = new TaskInputQueue();
      queue.enqueue(firstTask);
      let exitRequested = false;

      while (queue.size && !exitRequested) {
        const current = queue.dequeue()!;
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
          const followUp = (await readInteractiveInput(localize(language, "补充> ", "steer> "), slashCommands(language), inputHistory, () => (
            formatRunningInputFooter(view, queue.size, agent.status().pendingSteering, promptFooter())
          ), {
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
          printWorkspaceChanges(view.drainWorkspaceChanges());
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
            console.log(chalk.dim(localize(language, `运行中：第 ${turnStatus} 轮 | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)} 秒 | ${currentStatus.pendingSteering} 条补充 | ${queue.size} 个排队 | ${currentStatus.stats.modelCalls} 次模型调用 | ${currentStatus.stats.toolCalls} 次工具调用\n`, `Working: turn ${turnStatus} | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)}s | ${currentStatus.pendingSteering} steering | ${queue.size} queued | ${currentStatus.stats.modelCalls} model call(s) | ${currentStatus.stats.toolCalls} tool call(s)\n`)));
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
        printWorkspaceChanges(view.drainWorkspaceChanges());
        view.discard();
        const receipts = view.receiptLines();
        if (receipts.length) console.log(`${chalk.cyan(localize(language, "关键操作", "Key actions"))}\n${receipts.map((line) => chalk.green(line)).join("\n")}\n`);
        const interaction = parseAssistantInteraction(finalResponse, language);
        finalResponse = interaction.text;
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
        if (!failure && agent.status().outcome === "unverified") failure = new Error(localize(language, "任务修改了文件，但没有通过验证。", "The task changed files but no verification passed."));
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
      if (task === "/exit" || task === "/quit") break;
      if (task === "/resume") {
        const selected = await chooseSession(config.cwd, language);
        if (!selected) console.log(chalk.dim(localize(language, "未选择会话。\n", "No session selected.\n")));
        else {
          agent.restoreSession(selected);
          awaitingReply = undefined;
          console.log(chalk.green(localize(language, `已恢复会话 ${selected.id}`, `Resumed session ${selected.id}`)), chalk.dim(localize(language, `（${selected.messages.length} 条消息，${selected.model ?? agent.status().model}）\n`, `(${selected.messages.length} messages, ${selected.model ?? agent.status().model})\n`)));
        }
        continue;
      }
      if (task === "/clear") {
        agent.clearConversation();
        awaitingReply = undefined;
        console.log(chalk.dim(localize(language, "对话上下文已清空。\n", "Conversation context cleared.\n")));
        continue;
      }
      if (task === "/history" || task === "/history current") {
        console.log(`${agent.history()}\n`);
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
        const selected = await selectTerminalOption(localize(language, "选择模型", "Choose a model"), available.models.map((model) => ({
          label: `${model.id}${model.id === current ? localize(language, "（当前）", " (current)") : ""}`,
          description: [model.name && model.name !== model.id ? model.name : "", model.description ?? "", model.source].filter(Boolean).join("  "),
          value: model.id,
        })), language);
        if (!selected || selected === current) console.log(chalk.dim(selected ? localize(language, `模型保持为 ${current}。\n`, `Model remains ${current}.\n`) : localize(language, "已取消模型选择。\n", "Model selection cancelled.\n")));
        else {
          await agent.setModel(selected);
          console.log(chalk.green(localize(language, `模型已切换：${current} → ${selected}。\n`, `Model changed: ${current} -> ${selected}.\n`)));
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
        const skills = skillRegistry.list();
        if (!skills.length) {
          console.log(chalk.dim(localize(language, "没有已安装技能。使用 /skills install <本地路径或 HTTPS Git URL> 安装。\n", "No skills installed. Use /skills install <path-or-https-git-url>.\n")));
          continue;
        }
        const selected = await selectTerminalOption(localize(language, "已安装技能", "Installed skills"), skills.map((skill) => ({
          label: skill.name,
          description: `${skill.scope}  ${skill.description.slice(0, 100)}`,
          value: skill.name,
        })), language);
        if (selected) {
          const skill = skills.find((item) => item.name === selected)!;
          console.log(`${chalk.cyan(skill.name)} ${chalk.dim(`[${skill.scope}]`)}\n${skill.description}\n${chalk.dim(skill.file)}\n`);
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
          let installed;
          try { installed = await skillRegistry.install(source); }
          catch (error) {
            status.stop();
            if (!/Skill already exists:/i.test(error instanceof Error ? error.message : String(error))) throw error;
            const answer = await askQuestion(chalk.yellow(localize(language, "技能已存在，是否备份后替换？[y/N] ", "Skill already exists. Back it up and replace it? [y/N] ")));
            if (!/^(y|yes)$/i.test(answer.trim())) {
              console.log(chalk.dim(localize(language, "已取消技能安装。\n", "Skill installation cancelled.\n")));
              continue;
            }
            status.start(localize(language, "正在替换技能包", "Replacing skill package"));
            installed = await skillRegistry.install(source, true);
          }
          status.stop();
          agent.reloadInstructions();
          for (const skill of installed) {
            console.log(chalk.green(localize(language, `已安装技能 ${skill.name}`, `Installed skill ${skill.name}`)), chalk.dim(`-> ${skill.destination}`));
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
      if (task === "/mcp reload") {
        status.start(localize(language, "正在重新加载 MCP 服务", "Reloading MCP servers"));
        try {
          await mcpManager.start();
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
        console.log(chalk.dim(localize(language, `使用 /models 选择模型。当前模型：${agent.status().model}\n`, `Use /models to choose a model. Current: ${agent.status().model}\n`)));
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
      if (task === "/queue" || task === "/clear-queue" || task === "/cancel") {
        console.log(chalk.dim(localize(language, `${task} 仅在任务运行时可用。\n`, `${task} is available while a task is running.\n`)));
        continue;
      }
      if (task === "/status") {
        const current = agent.status();
        const zh = language === "zh-CN";
        console.log(zh ? [
          `会话：${current.sessionId ?? "尚未开始"}`, `模型：${current.model}`, `语言：简体中文`,
          `规划模式：${current.planMode ? "开启（只读）" : "关闭"}`, `上次结果：${current.outcome}`,
          `轮次：${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : "（无限制）"}`, `待处理补充：${current.pendingSteering}`, `消息：${current.messages}`,
          `上下文估算：约 ${current.stats.estimatedTokens.toLocaleString()} tokens`, `自动压缩：${current.contextLimit.toLocaleString()} tokens（${current.contextLimitMode}）`,
          `模型窗口：${current.contextWindow.toLocaleString()} tokens（${current.contextWindowSource}）`, `API Token：输入 ${current.stats.inputTokens.toLocaleString()} / 输出 ${current.stats.outputTokens.toLocaleString()}`,
          `调用：模型 ${current.stats.modelCalls} / 工具 ${current.stats.toolCalls}`, `压缩次数：${current.stats.compactions}`, `活跃时间：${(current.stats.activeMs / 1000).toFixed(1)} 秒`,
          `索引：${current.index?.files ?? 0} 个文件${current.index?.truncated ? "（已截断）" : ""}`, `MCP：${mcpManager.status().filter((server) => server.state === "connected").length} 个服务 / ${mcpManager.tools().length} 个工具`,
          `Agents：${coordinator.list().filter((run) => run.status === "running").length} 个运行中 / ${coordinator.list().length} 个已保存`, `后台：${listBackgroundProcesses().filter((item) => item.running).length} 个运行中`,
          `活动：${activities.list().length} 条记录（/details）`,
        ].join("\n") + "\n" : [
          `Session: ${current.sessionId ?? "not started"}`, `Model: ${current.model}`, `Language: English`, `Plan mode: ${current.planMode ? "ON (read-only)" : "OFF"}`, `Last outcome: ${current.outcome}`,
          `Turn: ${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : " (unlimited)"}`, `Pending steering: ${current.pendingSteering}`, `Messages: ${current.messages}`,
          `Context estimate: ~${current.stats.estimatedTokens.toLocaleString()} tokens`, `Auto compact: ${current.contextLimit.toLocaleString()} tokens (${current.contextLimitMode})`,
          `Model window: ${current.contextWindow.toLocaleString()} tokens (${current.contextWindowSource})`, `API tokens: ${current.stats.inputTokens.toLocaleString()} in / ${current.stats.outputTokens.toLocaleString()} out`,
          `Calls: ${current.stats.modelCalls} model / ${current.stats.toolCalls} tool`, `Compactions: ${current.stats.compactions}`, `Active time: ${(current.stats.activeMs / 1000).toFixed(1)}s`,
          `Index: ${current.index?.files ?? 0} files${current.index?.truncated ? " (truncated)" : ""}`, `MCP: ${mcpManager.status().filter((server) => server.state === "connected").length} servers / ${mcpManager.tools().length} tools`,
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
        if (await runTaskSequence(continuedTask)) break;
        restoredDraft = await draftStore.load();
      } catch (error) {
        status.stop();
        console.error(chalk.red(`${localize(language, "错误", "Error")}: ${error instanceof Error ? error.message : String(error)}\n`));
      }
    }
    process.off("SIGINT", onSigint);
  } finally {
    status.stop();
    await mcpManager.close();
    await stopAllBackgroundProcesses();
  }
}

main().catch((error) => {
  console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
