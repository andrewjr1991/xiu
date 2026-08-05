#!/usr/bin/env node
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { Agent } from "./agent.js";
import { stopAllBackgroundProcesses } from "./background.js";
import { CheckpointManager } from "./checkpoint.js";
import { resolveConfig } from "./config.js";
import { createProvider } from "./providers.js";
import { createMediaTools } from "./media-tools.js";
import { McpManager } from "./mcp.js";
import { readInteractiveInput, selectTerminalOption, type SlashCommand } from "./interactive-ui.js";
import { createProjectIndexTools, ProjectIndex } from "./project-index.js";
import { createPlanTools, TaskPlanManager } from "./plan.js";
import { listSessions, loadSession } from "./session.js";
import { createSkillTools, SkillRegistry } from "./skills.js";
import { StatusLine } from "./status.js";
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
  { name: "/checkpoints", description: "List safe file restore points" },
  { name: "/rewind", description: "Choose a checkpoint to restore" },
  { name: "/models", description: "Discover and choose an available model" },
  { name: "/skills", description: "Browse or install Xiu skills" },
  { name: "/skills install", description: "Install a local or HTTPS Git skill package" },
  { name: "/mcp", description: "Show connected MCP servers and tools" },
  { name: "/mcp reload", description: "Reload user and project MCP configuration" },
  { name: "/status", description: "Show tokens, calls, time, and index stats" },
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
  .option("--context-limit <tokens>", "estimated context tokens before automatic compaction", "60000")
  .option("--max-turns <number>", "agent loop safety limit", "30")
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
    status.stop();
    if (restored) console.log(chalk.green(`Resumed session ${restored.id}`), chalk.dim(`(${restored.messages.length} messages)\n`));

    const planManager = new TaskPlanManager(restored?.plan, restored?.planMode);
    const checkpointManager = new CheckpointManager(config.cwd, restored?.id);
    const baseTools = [...builtinTools, ...createProjectIndexTools(projectIndex), ...createPlanTools(planManager), ...createSkillTools(skillRegistry), ...createMediaTools(config)];
    const tools = [...baseTools, ...mcpManager.tools()];
    const provider = createProvider(config);

    const agent = new Agent(
      config,
      provider,
      tools,
      async (request) => {
        if (config.autoApprove && request.risk !== "dangerous") return true;
        status.stop();
        if (!process.stdin.isTTY) return false;
        const riskLabel = request.risk === "dangerous"
          ? chalk.bgRed.white.bold(" DANGEROUS ")
          : request.risk === "write"
            ? chalk.yellow("[write]")
            : chalk.magenta("[execute]");
        if (request.preview) console.log(`${chalk.dim("Proposed change:")}\n${request.preview}\n`);
        const answer = await askQuestion(`${riskLabel} Allow Xiu to ${request.description}? [y/N] `);
        const approved = /^(y|yes)$/i.test(answer.trim());
        if (approved) status.start(`Running ${request.description}`);
        return approved;
      },
      {
        onModelStart: (turn) => status.start(`Thinking - turn ${turn}`),
        onModelEnd: () => status.stop(),
        onText: (text) => console.log(`${text}\n`),
        onTextDelta: (text) => {
          status.stop();
          process.stdout.write(text);
        },
        onTextStreamEnd: () => process.stdout.write("\n\n"),
        onToolStart: (name, description) => {
          console.log(chalk.cyan(`> ${name}`), chalk.dim(description));
          status.start(`Running ${name}`);
        },
        onToolProgress: (name, message) => status.start(`${name}: ${message}`),
        onToolEnd: (_name, result) => {
          status.stop();
          console.log(chalk.dim(result.length > 500 ? `${result.slice(0, 500)}...` : result), "\n");
        },
        onCompletionGate: () => console.log(chalk.yellow("Verification required before completion.\n")),
        onCompaction: (message) => status.start(message),
        onRetry: (message) => status.start(message),
        onFailure: (message) => {
          status.stop();
          console.error(chalk.red(`${message}\n`));
        },
        onPlanUpdate: (plan) => console.log(`${chalk.cyan("Task plan updated")}\n${chalk.dim(plan)}\n`),
        onCheckpoint: (message) => console.log(chalk.dim(`${message}\n`)),
        onTaskComplete: (summary) => {
          const verification = summary.changed ? (summary.verified ? "verified" : "verification noted") : "no changes";
          console.log(chalk.green(`Done - ${summary.turns} turn(s), ${summary.toolCalls} tool call(s), ${verification}, ${(summary.durationMs / 1000).toFixed(1)}s\n`));
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
      return;
    }

    console.log(chalk.dim("Interactive mode - /help for commands - Ctrl+C or /exit to quit\n"));
    const inputHistory: string[] = [];
    while (true) {
      const dashboard = agent.status();
      const footer = formatPromptDashboard({
        model: dashboard.model,
        contextTokens: dashboard.stats.estimatedTokens,
        contextLimit: dashboard.contextLimit,
        skills: skillRegistry.list().length,
        cwd: config.cwd,
        planMode: dashboard.planMode,
        mcpTools: mcpManager.tools().length,
      });
      const task = (await readInteractiveInput("xiu> ", slashCommands, inputHistory, footer)).trim();
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
      if (task === "/compact") {
        try { console.log(chalk.green(`${await agent.compact()}\n`)); }
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
      if (task === "/model" || task.startsWith("/model ")) {
        console.log(chalk.dim(`Use /models to choose a model. Current: ${agent.status().model}\n`));
        continue;
      }
      if (task === "/status") {
        const current = agent.status();
        console.log([
          `Session: ${current.sessionId ?? "not started"}`,
          `Model: ${current.model}`,
          `Plan mode: ${current.planMode ? "ON (read-only)" : "OFF"}`,
          `Messages: ${current.messages}`,
          `Context: ~${current.stats.estimatedTokens.toLocaleString()} / ${current.contextLimit.toLocaleString()} tokens`,
          `API tokens: ${current.stats.inputTokens.toLocaleString()} in / ${current.stats.outputTokens.toLocaleString()} out`,
          `Calls: ${current.stats.modelCalls} model / ${current.stats.toolCalls} tool`,
          `Compactions: ${current.stats.compactions}`,
          `Active time: ${(current.stats.activeMs / 1000).toFixed(1)}s`,
          `Index: ${current.index?.files ?? 0} files${current.index?.truncated ? " (truncated)" : ""}`,
          `MCP: ${mcpManager.status().filter((server) => server.state === "connected").length} servers / ${mcpManager.tools().length} tools`,
        ].join("\n") + "\n");
        continue;
      }
      if (task === "/help") {
        console.log("/resume            Choose and restore a project session\n/history           Show recent conversation\n/history sessions  List sessions in this workspace\n/compact           Compress conversation context now\n/plan               Show the task plan and plan-mode state\n/plan on|off        Toggle read-only plan mode\n/tasks              Show live task statuses\n/diff               Show this session's changed files and Git diff\n/checkpoints        List file restore points\n/rewind             Restore files from a selected checkpoint\n/models             Discover and choose an available model\n/skills             Browse installed skills\n/skills install ... Install a local or HTTPS Git skill package\n/mcp                Show MCP server and tool status\n/mcp reload         Reload MCP configuration\n/status             Show session, token, call, time, and index stats\n/clear              Start a new conversation session\n/exit               Exit Xiu\n/help               Show interactive commands\n");
        continue;
      }
      try {
        await agent.run(task);
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
