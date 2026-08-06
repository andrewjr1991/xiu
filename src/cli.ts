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
import { CheckpointManager } from "./checkpoint.js";
import { ClipboardAttachmentManager } from "./clipboard.js";
import { resolveConfig } from "./config.js";
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
import { failureRecoveryOptions, formatRunningInputFooter, RunningTaskView, TaskInputQueue } from "./task-queue.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import { builtinTools } from "./tools.js";
import { isWorkspaceTrusted, trustWorkspace } from "./trust.js";
import { formatPromptDashboard, renderWelcome } from "./welcome.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

const slashCommands: SlashCommand[] = [
  { name: "/resume", description: "Choose and restore a project session" },
  { name: "/history", description: "Show recent conversation" },
  { name: "/history sessions", description: "List sessions in this project" },
  { name: "/compact", description: "Compress conversation context" },
  { name: "/plan", description: "Show plan or toggle read-only plan mode" },
  { name: "/tasks", description: "Show the live task plan" },
  { name: "/diff", description: "Show files and Git diff changed this session" },
  { name: "/paste", description: "Paste clipboard text, image, or copied files" },
  { name: "/checkpoints", description: "List safe file restore points" },
  { name: "/rewind", description: "Choose a checkpoint to restore" },
  { name: "/models", description: "Discover and choose an available model" },
  { name: "/skills", description: "Browse or install Xiu skills" },
  { name: "/skills install", description: "Install a local or HTTPS Git skill package" },
  { name: "/mcp", description: "Show connected MCP servers and tools" },
  { name: "/mcp reload", description: "Reload user and project MCP configuration" },
  { name: "/agents", description: "Show multi-agent runs and task status" },
  { name: "/agents cancel", description: "Cancel one agent task" },
  { name: "/agents retry", description: "Retry one interrupted or failed agent" },
  { name: "/agents integrate", description: "Review and integrate a Worktree agent" },
  { name: "/details", description: "Browse complete tool and Agent activity details" },
  { name: "/status", description: "Show tokens, calls, time, and index stats" },
  { name: "/queue", description: "Show scheduled tasks; use /queue <task> to run one next" },
  { name: "/clear-queue", description: "Clear queued follow-ups while a task is running" },
  { name: "/cancel", description: "Cancel the task that is currently running" },
  { name: "/clear", description: "Start a new conversation session" },
  { name: "/help", description: "Show all commands" },
  { name: "/exit", description: "Exit Xiu" },
];

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
  .option("-y, --yes", "approve writes and execution automatically (dangerous actions still prompt)", false)
  .showHelpAfterError()
  .parse();

async function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); }
  finally { rl.close(); }
}

async function confirmWorkspaceTrust(workspace: string): Promise<boolean> {
  if (await isWorkspaceTrusted(workspace)) return true;
  console.log(chalk.bold("Do you trust the files in this workspace?"));
  console.log(chalk.dim("Xiu may read files, load project instructions and MCP servers, modify code, and run commands here."));
  console.log(`\n  ${chalk.green("1.")} Trust this workspace`);
  console.log(`  ${chalk.red("2.")} Exit\n`);
  const choice = (await askQuestion(chalk.cyan("Select [1]: "))).trim();
  if (choice !== "" && choice !== "1") {
    console.log(chalk.dim("Workspace was not trusted. Xiu did not inspect or modify it."));
    return false;
  }
  await trustWorkspace(workspace);
  console.log(chalk.green("Workspace trusted.\n"));
  return true;
}

async function chooseSession(workspace: string) {
  const sessions = await listSessions(workspace);
  if (!sessions.length) return undefined;
  const selected = await selectTerminalOption("Resume which session?", sessions.map((session) => ({
    label: session.firstTask.replace(/\s+/g, " ").slice(0, 72) || "Untitled session",
    description: `${new Date(session.updatedAt).toLocaleString()}  ${session.model ?? "unknown model"}  ${session.id}`,
    value: session.id,
  })));
  return selected ? await loadSession(workspace, selected) : undefined;
}

async function main(): Promise<void> {
  const options = program.opts();
  const config = resolveConfig(options);
  const stat = await fs.stat(config.cwd).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Workspace does not exist: ${config.cwd}`);

  const status = new StatusLine();
  const activities = new ActivityLog();
  const mcpManager = new McpManager(config.cwd);
  try {
    if (options.listSessions) {
      const sessions = await listSessions(config.cwd);
      if (!sessions.length) console.log("No Xiu sessions in this workspace.");
      else for (const session of sessions) console.log(`${session.id}  ${session.updatedAt}  ${session.model ?? "unknown model"}  ${session.firstTask.slice(0, 80)}`);
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
      console.log(chalk.dim(`Workspace: ${config.cwd}\n`));
    } else {
      renderWelcome(config, packageJson.version, skillRegistry.list().length);
    }

    const windowsDirectory = process.env.WINDIR;
    if (windowsDirectory && config.cwd.toLowerCase() === path.join(windowsDirectory, "System32").toLowerCase()) {
      console.log(chalk.yellow("Warning: Xiu is running in Windows System32. Exit, enter your project directory, and start Xiu there before making changes.\n"));
    }

    if (!initialTask && !(await confirmWorkspaceTrust(config.cwd))) return;
    await skillRegistry.refresh(true);
    status.start("Connecting MCP servers");
    let mcpStatuses = [] as ReturnType<McpManager["status"]>;
    let mcpConfigError: unknown;
    const projectMcpTrusted = await isWorkspaceTrusted(config.cwd);
    try { mcpStatuses = await mcpManager.start(projectMcpTrusted); }
    catch (error) { mcpConfigError = error; }
    finally { status.stop(); }
    if (mcpConfigError) console.log(chalk.yellow(`MCP configuration was not loaded: ${mcpConfigError instanceof Error ? mcpConfigError.message : String(mcpConfigError)}\n`));
    if (!projectMcpTrusted && initialTask && await fs.stat(path.join(config.cwd, ".xiu", "mcp.json")).then(() => true).catch(() => false)) {
      console.log(chalk.yellow("Project MCP configuration was skipped because this workspace has not been trusted. Start interactive Xiu once to review and trust it.\n"));
    }
    if (mcpStatuses.length) {
      const connected = mcpStatuses.filter((server) => server.state === "connected");
      const failed = mcpStatuses.filter((server) => server.state === "failed");
      console.log(chalk.dim(`MCP: ${connected.length} connected, ${mcpManager.tools().length} tools${failed.length ? `, ${failed.length} failed` : ""}. Use /mcp for details.\n`));
    }
    if (resumeRequested && !restored) {
      restored = await chooseSession(config.cwd);
      if (!restored) {
        console.log(chalk.dim("No session selected. Starting a new session.\n"));
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

    status.start("Indexing project");
    const projectIndex = new ProjectIndex(config.cwd);
    await projectIndex.initialize();
    const draftStore = new DraftStore(config.cwd);
    const clipboard = new ClipboardAttachmentManager(config.cwd);
    let restoredDraft = await draftStore.load();
    status.stop();
    if (restored) console.log(chalk.green(`Resumed session ${restored.id}`), chalk.dim(`(${restored.messages.length} messages)\n`));

    const planManager = new TaskPlanManager(restored?.plan, restored?.planMode);
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
    const printWorkspaceChanges = (notices: WorkspaceChangeNotice[]): void => {
      if (!notices.length) return;
      console.log(chalk.cyan("File changes"));
      for (const notice of notices) {
        for (const file of notice.files) {
          const label = ({ created: "Created", modified: "Modified", deleted: "Deleted" } as const)[file.kind];
          const counts = file.additions !== undefined && file.deletions !== undefined
            ? ` ${chalk.green(`+${file.additions}`)} ${chalk.red(`-${file.deletions}`)}`
            : ` ${chalk.dim(`${formatByteSize(file.bytesBefore)} → ${formatByteSize(file.bytesAfter)}`)}`;
          console.log(`  ${chalk.green("√")} ${label} ${chalk.bold(file.path)}${counts}`);
          for (const line of file.preview) {
            const color = line.startsWith("+") ? chalk.green : line.startsWith("-") ? chalk.red : chalk.dim;
            console.log(`      ${color(line)}`);
          }
        }
      }
      console.log();
    };
    const startPhase = (value: string): void => {
      if (runningTaskView) {
        status.stop();
        runningTaskView.setPhase(value);
      } else status.start(value);
    };
    const stopPhase = (): void => {
      if (runningTaskView) runningTaskView.setPhase("Processing response");
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
        if (request.preview) console.log(`${chalk.dim("Proposed change:")}\n${request.preview}\n`);
        const selected = await selectTerminalOption(`${request.risk.toUpperCase()} approval: allow Xiu to ${request.description}?`, [
          { label: "No, deny", description: "Do not run this operation", value: false },
          { label: "Yes, allow once", description: request.description, value: true },
        ]);
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
        const childPlan = new TaskPlanManager(undefined, task.mode === "shared_readonly");
        const childCheckpoint = new CheckpointManager(context.cwd);
        const candidateTools = [...builtinTools, ...createProjectIndexTools(childIndex), ...createPlanTools(childPlan)];
        const childTools = selectSubagentTools(candidateTools, task.mode);
        const childAgent = new Agent(
          childConfig,
          createProvider(childConfig),
          childTools,
          approveRequest,
          {
            onModelStart: (turn) => context.reportProgress(`Thinking - turn ${turn}`),
            onToolStart: (name, description) => context.reportProgress(`${name}: ${description}`),
            onToolProgress: (name, message) => context.reportProgress(`${name}: ${message}`),
            onRetry: (message) => context.reportProgress(message),
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
          emitLine(`${color(`[agent ${task.id}] ${task.status}`)} ${chalk.dim(`${task.role} - ${task.title}`)}`);
        },
        onRunUpdate: (run) => emitLine(chalk.cyan(`Multi-agent run ${run.id} ${run.status}.`)),
      },
      config.agentConcurrency,
    );
    await coordinator.initialize();
    const coordinatorTools = createMultiAgentTools(coordinator);
    const baseTools = [...builtinTools, ...createProjectIndexTools(projectIndex), ...createPlanTools(planManager), ...createSkillTools(skillRegistry), ...createMediaTools(config), ...coordinatorTools];
    const tools = [...baseTools, ...mcpManager.tools()];
    const provider = createProvider(config);

    let activeToolActivity: string | undefined;
    const agent = new Agent(
      config,
      provider,
      tools,
      approveRequest,
      {
        onModelStart: (turn) => {
          runningTaskView?.setTurn(turn, config.maxTurns);
          runningTaskView?.activity(`Model turn ${turn}${config.maxTurns ? `/${config.maxTurns}` : ""} started`);
          startPhase("Thinking");
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
          activeToolActivity = activities.start("tool", name, description);
          runningTaskView?.beginTool(name, description, details.changesWorkspace, details.verification);
          emitLine(`${chalk.cyan(`> ${name}`)} ${chalk.dim(description)}`);
          startPhase(`Running ${name}`);
        },
        onToolProgress: (name, message) => {
          if (activeToolActivity) activities.progress(activeToolActivity, message);
          runningTaskView?.activity(`${name}: ${message}`);
          startPhase(`${name}: ${message}`);
        },
        onToolEnd: (_name, result) => {
          stopPhase();
          const failed = /^(Tool error:|Exit code: (?!0\b)|Command timed out|Verification timed out|Verification unavailable)/i.test(result);
          if (activeToolActivity) activities.finish(activeToolActivity, result, failed);
          activeToolActivity = undefined;
          const summary = result.replace(/\s+/g, " ").trim();
          runningTaskView?.activity(`${_name}: ${failed ? "failed" : "finished"} - ${summary.slice(0, 100)}`);
          emitLine(`${chalk.dim(summary.length > 240 ? `${summary.slice(0, 240)}... (/details for full output)` : summary)}\n`);
        },
        onCompletionGate: () => emitLine(chalk.yellow("Verification required before completion.\n")),
        onCompaction: (message) => startPhase(message),
        onRetry: (message) => startPhase(message),
        onFailure: (message) => {
          stopPhase();
          runningTaskView?.activity(`Failure: ${message}`);
          emitLine(chalk.red(`${message}\n`));
        },
        onPlanUpdate: (plan) => {
          runningTaskView?.setPlan(plan);
          emitLine(`${chalk.cyan("Task plan updated")}\n${chalk.dim(planManager.format())}\n`);
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
          const verification = summary.changed ? (summary.verified ? "verified" : "verification noted") : "no changes";
          const message = `${summary.outcome === "completed" ? "Done" : "Stopped unverified"} - ${summary.turns} turn(s), ${summary.toolCalls} tool call(s), ${verification}, ${(summary.durationMs / 1000).toFixed(1)}s\n`;
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
      if (agent.cancel()) console.log(chalk.yellow("\nCancelling current task..."));
      else console.log(chalk.dim("\nUse /exit to leave Xiu."));
    };
    process.on("SIGINT", onSigint);

    if (initialTask) {
      await agent.run(initialTask);
      if (agent.status().outcome === "unverified") process.exitCode = 2;
      return;
    }

    console.log(chalk.dim("Interactive mode - /help for commands - Ctrl+C or /exit to quit\n"));
    const inputHistory: string[] = [];
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
      });
    };

    const runTaskSequence = async (firstTask: string): Promise<boolean> => {
      const queue = new TaskInputQueue();
      queue.enqueue(firstTask);
      let exitRequested = false;

      while (queue.size && !exitRequested) {
        const current = queue.dequeue()!;
        const view = new RunningTaskView();
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
          const followUp = (await readInteractiveInput("xiu[working]> ", slashCommands, inputHistory, () => (
            formatRunningInputFooter(view, queue.size, agent.status().pendingSteering, promptFooter())
          ), {
            paths: projectIndex.paths("", 1_000),
            initialValue: queuedDraft,
            onChange: (value) => { void draftStore.save(value); },
            onCancel: () => {
              cancelledFromKeyboard = true;
              agent.cancel();
            },
            onToggleDetails: () => { view.toggleDetails(); },
            onPaste: () => clipboard.paste(),
            signal: inputController.signal,
            refreshMs: 250,
          })).trim();
          if (activeQueuedInputController === inputController) activeQueuedInputController = undefined;
          printWorkspaceChanges(view.drainWorkspaceChanges());
          await draftStore.flush();
          await activeApproval;
          if (cancelledFromKeyboard) {
            console.log(chalk.yellow("Cancelling current task. Queued follow-ups are preserved.\n"));
            break;
          }
          if (!followUp && settled) break;
          if (!followUp) continue;
          inputHistory.push(followUp);

          if (followUp === "/cancel") {
            agent.cancel();
            console.log(chalk.yellow("Cancelling current task. Queued follow-ups are preserved.\n"));
            break;
          }
          if (followUp === "/exit" || followUp === "/quit") {
            exitRequested = true;
            queue.clear();
            agent.cancel();
            console.log(chalk.yellow("Cancelling current task before exit.\n"));
            break;
          }
          if (followUp === "/queue") {
            const pending = queue.list();
            console.log(pending.length
              ? `${chalk.cyan("Queued follow-ups")}\n${pending.map((item, index) => `${index + 1}. ${item.text.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")}\n`
              : chalk.dim("The follow-up queue is empty.\n"));
            continue;
          }
          if (followUp.startsWith("/queue ")) {
            try {
              const queued = queue.enqueue(followUp.slice("/queue ".length));
              console.log(chalk.green(`Scheduled next ${queued.id}: ${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`));
            } catch (error) {
              console.error(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
            }
            continue;
          }
          if (followUp === "/clear-queue") {
            const cleared = queue.clear();
            console.log(chalk.dim(`Cleared ${cleared} queued follow-up(s).\n`));
            continue;
          }
          if (followUp === "/status") {
            const currentStatus = agent.status();
            const turnStatus = currentStatus.maxTurns ? `${currentStatus.turn}/${currentStatus.maxTurns}` : `${currentStatus.turn}`;
            console.log(chalk.dim(`Working: turn ${turnStatus} | ${view.phase()} | ${Math.floor(view.elapsedMs() / 1000)}s | ${currentStatus.pendingSteering} steering | ${queue.size} queued | ${currentStatus.stats.modelCalls} model call(s) | ${currentStatus.stats.toolCalls} tool call(s)\n`));
            continue;
          }
          if (followUp === "/paste") {
            try {
              const pasted = await clipboard.paste();
              await draftStore.save(pasted.insertText);
              await draftStore.flush();
              console.log(chalk.green(`${pasted.notice ?? "Clipboard content added to the input draft."}\n`));
            } catch (error) {
              console.error(chalk.red(`Clipboard paste failed: ${error instanceof Error ? error.message : String(error)}\n`));
            }
            continue;
          }
          if (followUp === "/details") {
            const visible = view.toggleDetails();
            console.log(chalk.dim(`Live view switched to ${visible ? "detailed tool activity" : "task step summary"}. Ctrl+O toggles it without submitting the prompt.\n`));
            continue;
          }

          if (!settled && agent.steer(followUp)) {
            view.activity(`User steering accepted: ${followUp.slice(0, 100)}`);
            console.log(chalk.green(`Steering current task: ${followUp.replace(/\s+/g, " ").slice(0, 100)}\n`));
          } else {
            try {
              const queued = queue.enqueue(followUp);
              console.log(chalk.green(`Current task already ended; scheduled ${queued.id}: ${queued.text.replace(/\s+/g, " ").slice(0, 100)}\n`));
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
        if (finalResponse.trim()) console.log(`${finalResponse.trim()}\n`);
        const completion = view.completionSummary();
        if (completion) console.log(completion.success ? chalk.green(completion.message) : chalk.yellow(completion.message));
        if (!failure && agent.status().outcome === "unverified") failure = new Error("The task changed files but no verification passed.");
        if (failure && !exitRequested) {
          console.error(chalk.red(`Task stopped: ${failure instanceof Error ? failure.message : String(failure)}\n`));
          const action = await selectTerminalOption("The current task did not complete. What next?", failureRecoveryOptions(queue.size));
          if (action === "retry") {
            queue.prepend(`Continue the unfinished task from the existing evidence. Do not restart the investigation or repeat successful reads. Original goal: ${current.text}`);
          } else if (action !== "continue") {
            const cleared = queue.clear();
            if (cleared) console.log(chalk.dim(`Cleared ${cleared} scheduled task(s).\n`));
          }
        } else if (queue.size && !exitRequested) {
          console.log(chalk.cyan(`Continuing with ${queue.size} explicitly scheduled task(s).\n`));
        }
      }
      return exitRequested;
    };

    while (true) {
      const task = (await readInteractiveInput("xiu> ", slashCommands, inputHistory, promptFooter, {
        paths: projectIndex.paths("", 1_000),
        initialValue: restoredDraft,
        onChange: (value) => { void draftStore.save(value); },
        onPaste: () => clipboard.paste(),
      })).trim();
      await draftStore.flush();
      restoredDraft = await draftStore.load();
      if (!task) continue;
      inputHistory.push(task);
      if (task === "/exit" || task === "/quit") break;
      if (task === "/resume") {
        const selected = await chooseSession(config.cwd);
        if (!selected) console.log(chalk.dim("No session selected.\n"));
        else {
          agent.restoreSession(selected);
          console.log(chalk.green(`Resumed session ${selected.id}`), chalk.dim(`(${selected.messages.length} messages, ${selected.model ?? agent.status().model})\n`));
        }
        continue;
      }
      if (task === "/clear") {
        agent.clearConversation();
        console.log(chalk.dim("Conversation context cleared.\n"));
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
          : "No saved sessions.\n");
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
        console.log(chalk.green(`Plan mode ${enabled ? "enabled (read-only)" : "disabled"}.\n`));
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
          console.log(chalk.green(`${pasted.notice ?? "Clipboard content added to the input draft."}\n`));
        } catch (error) {
          console.error(chalk.red(`Clipboard paste failed: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/checkpoints") {
        const checkpoints = await checkpointManager.list();
        console.log(checkpoints.length
          ? `${checkpoints.map((checkpoint) => `${checkpoint.id}  ${checkpoint.tool}  ${checkpoint.files.map((file) => file.path).join(", ")}`).join("\n")}\n`
          : "No checkpoints in the current session.\n");
        continue;
      }
      if (task === "/rewind") {
        const checkpoints = await checkpointManager.list();
        if (!checkpoints.length) {
          console.log(chalk.dim("No checkpoints in the current session.\n"));
          continue;
        }
        const selected = await selectTerminalOption("Restore which checkpoint?", checkpoints.map((checkpoint) => ({
          label: checkpoint.description,
          description: `${new Date(checkpoint.createdAt).toLocaleString()}  ${checkpoint.files.map((file) => file.path).join(", ")}`,
          value: checkpoint.id,
        })));
        if (!selected) {
          console.log(chalk.dim("Restore cancelled.\n"));
          continue;
        }
        const answer = await askQuestion(chalk.bgRed.white.bold(" RESTORE ") + ` Restore files from checkpoint ${selected}? [y/N] `);
        if (!/^(y|yes)$/i.test(answer.trim())) {
          console.log(chalk.dim("Restore cancelled.\n"));
          continue;
        }
        const restoredCheckpoint = await checkpointManager.restore(selected);
        projectIndex.invalidate();
        console.log(chalk.green(`Restored ${restoredCheckpoint.files.map((file) => file.path).join(", ")} from ${restoredCheckpoint.id}.\n`));
        continue;
      }
      if (task === "/models") {
        status.start("Discovering available models");
        const available = await agent.listModels();
        status.stop();
        if (available.discoveryError) console.log(chalk.yellow(`Live model discovery unavailable: ${available.discoveryError}\nShowing built-in models instead.\n`));
        const current = agent.status().model;
        const selected = await selectTerminalOption("Choose a model", available.models.map((model) => ({
          label: `${model.id}${model.id === current ? " (current)" : ""}`,
          description: [model.name && model.name !== model.id ? model.name : "", model.description ?? "", model.source].filter(Boolean).join("  "),
          value: model.id,
        })));
        if (!selected || selected === current) console.log(chalk.dim(selected ? `Model remains ${current}.\n` : "Model selection cancelled.\n"));
        else {
          await agent.setModel(selected);
          console.log(chalk.green(`Model changed: ${current} -> ${selected}.\n`));
        }
        continue;
      }
      if (task === "/skills") {
        const skills = skillRegistry.list();
        if (!skills.length) {
          console.log(chalk.dim("No skills installed. Use /skills install <path-or-https-git-url>.\n"));
          continue;
        }
        const selected = await selectTerminalOption("Installed skills", skills.map((skill) => ({
          label: skill.name,
          description: `${skill.scope}  ${skill.description.slice(0, 100)}`,
          value: skill.name,
        })));
        if (selected) {
          const skill = skills.find((item) => item.name === selected)!;
          console.log(`${chalk.cyan(skill.name)} ${chalk.dim(`[${skill.scope}]`)}\n${skill.description}\n${chalk.dim(skill.file)}\n`);
        }
        continue;
      }
      if (task.startsWith("/skills install ")) {
        const source = task.slice("/skills install ".length).trim();
        if (!source) {
          console.log(chalk.yellow("Usage: /skills install <local-path-or-https-git-url>\n"));
          continue;
        }
        status.start("Installing skill package");
        try {
          let installed;
          try { installed = await skillRegistry.install(source); }
          catch (error) {
            status.stop();
            if (!/Skill already exists:/i.test(error instanceof Error ? error.message : String(error))) throw error;
            const answer = await askQuestion(chalk.yellow("Skill already exists. Back it up and replace it? [y/N] "));
            if (!/^(y|yes)$/i.test(answer.trim())) {
              console.log(chalk.dim("Skill installation cancelled.\n"));
              continue;
            }
            status.start("Replacing skill package");
            installed = await skillRegistry.install(source, true);
          }
          status.stop();
          agent.reloadInstructions();
          for (const skill of installed) {
            console.log(chalk.green(`Installed skill ${skill.name}`), chalk.dim(`-> ${skill.destination}`));
            if (skill.backup) console.log(chalk.dim(`Previous version backed up at ${skill.backup}`));
          }
          console.log();
        } catch (error) {
          status.stop();
          console.error(chalk.red(`Skill installation failed: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/mcp") {
        console.log(`${mcpManager.summary()}\n`);
        continue;
      }
      if (task === "/mcp reload") {
        status.start("Reloading MCP servers");
        try {
          await mcpManager.start();
          agent.replaceTools([...baseTools, ...mcpManager.tools()]);
          status.stop();
          console.log(`${chalk.green("MCP configuration reloaded.")}\n${mcpManager.summary()}\n`);
        } catch (error) {
          status.stop();
          console.error(chalk.red(`MCP reload failed: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/agents" || task.startsWith("/agents ")) {
        const parts = task.split(/\s+/);
        try {
          if (parts.length === 1) {
            const runs = coordinator.list();
            console.log(runs.length ? `${runs.map(formatAgentRun).join("\n\n")}\n` : chalk.dim("No multi-agent runs.\n"));
          } else if (parts[1] === "cancel" && parts[2] && parts[3]) {
            const cancelled = await coordinator.cancel(parts[2], parts[3]);
            console.log(chalk.yellow(`Agent ${cancelled.id} is ${cancelled.status}.\n`));
          } else if (parts[1] === "retry" && parts[2] && parts[3]) {
            console.log(`${formatAgentRun(await coordinator.retry(parts[2], parts[3]))}\n`);
          } else if (parts[1] === "integrate" && parts[2] && parts[3]) {
            const preview = await coordinator.diff(parts[2], parts[3]);
            console.log(`${chalk.dim("Proposed Agent patch:")}\n${preview}\n`);
            const answer = await askQuestion(chalk.yellow("[write]") + ` Integrate this Agent patch into ${config.cwd}? [y/N] `);
            if (!/^(y|yes)$/i.test(answer.trim())) console.log(chalk.dim("Agent integration cancelled.\n"));
            else {
              console.log(chalk.green(`${await coordinator.integrate(parts[2], parts[3])}\n`));
              projectIndex.invalidate();
            }
          } else if (parts.length === 2) {
            console.log(`${formatAgentRun(coordinator.get(parts[1]))}\n`);
          } else {
            console.log(chalk.yellow("Usage: /agents [run-id] | /agents cancel|retry|integrate <run-id> <task-id>\n"));
          }
        } catch (error) {
          console.error(chalk.red(`Agent command failed: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        continue;
      }
      if (task === "/model" || task.startsWith("/model ")) {
        console.log(chalk.dim(`Use /models to choose a model. Current: ${agent.status().model}\n`));
        continue;
      }
      if (task === "/details") {
        const records = activities.list();
        if (!records.length) {
          console.log(chalk.dim("No tool or Agent activity has been recorded yet.\n"));
          continue;
        }
        const selected = await selectTerminalOption("Activity details", records.map((record) => ({
          label: `${record.state} ${record.title}`,
          description: `${new Date(record.startedAt).toLocaleTimeString()}  ${record.description}`,
          value: record.id,
        })));
        if (selected) {
          const record = activities.get(selected)!;
          console.log(`${chalk.cyan(`${record.kind} ${record.title}`)} ${chalk.dim(`[${record.state}]`)}\n${record.description}\n\n${record.detail ?? record.summary ?? "No detail yet."}\n`);
        }
        continue;
      }
      if (task === "/queue" || task === "/clear-queue" || task === "/cancel") {
        console.log(chalk.dim(`${task} is available while a task is running.\n`));
        continue;
      }
      if (task === "/status") {
        const current = agent.status();
        console.log([
          `Session: ${current.sessionId ?? "not started"}`,
          `Model: ${current.model}`,
          `Plan mode: ${current.planMode ? "ON (read-only)" : "OFF"}`,
          `Last outcome: ${current.outcome}`,
          `Turn: ${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : " (unlimited)"}`,
          `Pending steering: ${current.pendingSteering}`,
          `Messages: ${current.messages}`,
          `Context estimate: ~${current.stats.estimatedTokens.toLocaleString()} tokens`,
          `Auto compact: ${current.contextLimit.toLocaleString()} tokens (${current.contextLimitMode})`,
          `Model window: ${current.contextWindow.toLocaleString()} tokens (${current.contextWindowSource})`,
          `API tokens: ${current.stats.inputTokens.toLocaleString()} in / ${current.stats.outputTokens.toLocaleString()} out`,
          `Calls: ${current.stats.modelCalls} model / ${current.stats.toolCalls} tool`,
          `Compactions: ${current.stats.compactions}`,
          `Active time: ${(current.stats.activeMs / 1000).toFixed(1)}s`,
          `Index: ${current.index?.files ?? 0} files${current.index?.truncated ? " (truncated)" : ""}`,
          `MCP: ${mcpManager.status().filter((server) => server.state === "connected").length} servers / ${mcpManager.tools().length} tools`,
          `Agents: ${coordinator.list().filter((run) => run.status === "running").length} running / ${coordinator.list().length} saved runs`,
          `Background: ${listBackgroundProcesses().filter((item) => item.running).length} running`,
          `Activities: ${activities.list().length} recorded (/details)`,
        ].join("\n") + "\n");
        continue;
      }
      if (task === "/help") {
        console.log("/resume            Choose and restore a project session\n/history           Show recent conversation\n/history sessions  List sessions in this workspace\n/compact [focus]   Compress context, optionally naming what to preserve\n/plan               Show the task plan and plan-mode state\n/plan on|off        Toggle read-only plan mode\n/tasks              Show live task statuses\n/diff               Show this session's changed files and Git diff\n/paste              Paste clipboard text, image, or copied files\n/checkpoints        List safe file restore points\n/rewind             Restore files from a selected checkpoint\n/models             Discover and choose an available model\n/skills             Browse installed skills\n/skills install ... Install a local or HTTPS Git skill package\n/mcp                Show MCP server and tool status\n/mcp reload         Reload MCP configuration\n/agents             Show multi-agent runs\n/agents <run>       Show one multi-agent run\n/agents cancel ...  Cancel one Agent task\n/agents retry ...   Retry one interrupted or failed task\n/agents integrate . Review and integrate a Worktree task\n/details            Browse activity; toggle live progress while working\n/status             Show session, token, call, time, and index stats\n/queue              Show explicitly scheduled next tasks\n/queue <task>       Schedule an independent task to run next\n/clear-queue        Clear scheduled tasks\n/cancel             Cancel the current task\n/clear              Start a new conversation session\n/exit               Exit Xiu\n/help               Show interactive commands\n");
        continue;
      }
      try {
        if (await runTaskSequence(task)) break;
        restoredDraft = await draftStore.load();
      } catch (error) {
        status.stop();
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
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
