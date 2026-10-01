import { Agent } from "../agent.js";
import { CheckpointManager } from "../checkpoint.js";
import { resolveConfig } from "../config.js";
import { defaultLanguage } from "../i18n.js";
import { createMediaTools } from "../media-tools.js";
import { TaskPlanManager, createPlanTools } from "../plan.js";
import { ProjectIndex, createProjectIndexTools } from "../project-index.js";
import { ProviderRegistry, resolveStartupModel, resolveStartupProviderId, startupProviderProfile, UNCONFIGURED_PROVIDER_PROFILE, type ProviderProfile } from "../provider-registry.js";
import { createProvider } from "../providers.js";
import { redactSecrets } from "../secret-redaction.js";
import { SettingsStore } from "../settings.js";
import { SkillRegistry, createSkillTools } from "../skills.js";
import { createWindowsSystemCredentialStore } from "../system-credential-store.js";
import { TaskRunJournal } from "../task-run.js";
import { builtinTools } from "../tools.js";
import type { ApprovalRequest, ModelProvider } from "../types.js";
import { AgentRuntimeAdapter } from "./agent-adapter.js";
import { XiuRuntime } from "./xiu-runtime.js";
import { createMcpManager, WorkspaceMcpService } from "./mcp-service.js";
import { MultiAgentCoordinator, createMultiAgentTools, selectSubagentTools } from "../multi-agent.js";
import { configureBackgroundRuntime, configureBackgroundWorkspace, listBackgroundProcesses } from "../background.js";
import { resolveNodeRuntime } from "../node-runtime.js";

export interface WorkspaceAgentHost {
  providerConfigured?: boolean;
  runtime: XiuRuntime;
  provider: { id: string; label: string; model: string };
  journal: TaskRunJournal;
  agent?: Agent;
  checkpointManager?: CheckpointManager;
  projectIndex?: ProjectIndex;
  setApprovalMode?: (mode: WorkspaceApprovalMode) => void;
  mcp?: WorkspaceMcpService;
  coordinator?: MultiAgentCoordinator;
  background?: () => ReturnType<typeof listBackgroundProcesses>;
  close?: () => Promise<void>;
}

export type WorkspaceApprovalMode = "ask" | "workspace" | "full";

export function canAutomaticallyApprove(mode: WorkspaceApprovalMode, request: Pick<ApprovalRequest, "risk" | "sessionScope">): boolean {
  if (mode === "full") return true;
  if (request.risk === "dangerous") return false;
  if (mode !== "workspace") return false;
  return true; // Risk-classified non-dangerous requests; not an AI reviewer or OS sandbox.
}

export function createWorkspaceProviderConfig(profile: ProviderProfile, model: string, workspace: string, credentialRevision: number, language: "zh-CN" | "en-US") {
  return resolveConfig({
    provider: profile.kind,
    providerId: profile.id,
    providerLabel: profile.name,
    apiKeyEnv: profile.apiKeyEnv,
    apiKey: profile.apiKey,
    credentialRevision,
    providerFeatures: profile.features,
    visionModel: profile.capabilityModels?.vision,
    imageModel: profile.capabilityModels?.image,
    videoModel: profile.capabilityModels?.video,
    audioModel: profile.capabilityModels?.audio,
    baseURL: profile.baseURL,
    proxy: profile.proxy,
    contextWindow: profile.contextWindow ? String(profile.contextWindow) : undefined,
    model,
    cwd: workspace,
    language,
  });
}

/**
 * Compose the real Agent for a trusted desktop workspace. This module has no
 * Electron dependency, so the execution and approval authority remains in the
 * shared Node runtime rather than the renderer.
 */
export async function createWorkspaceAgentHost(workspace: string, options: { provider?: ModelProvider; profile?: ProviderProfile; backgroundRoot?: string; journalRoot?: string } = {}): Promise<WorkspaceAgentHost> {
  const settings = await new SettingsStore().load();
  let credentialStore;
  try { credentialStore = await createWindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key"); }
  catch { /* Environment and legacy credentials remain available; never copy a system secret to disk. */ }

  const registry = new ProviderRegistry(undefined, credentialStore);
  await registry.load();
  const savedProviderId = registry.activeId();
  const requestedProviderId = resolveStartupProviderId(undefined, savedProviderId, process.env.XIU_PROVIDER);
  const requestedProfile = startupProviderProfile(registry, requestedProviderId);
  const profile = options.profile ?? requestedProfile ?? UNCONFIGURED_PROVIDER_PROFILE;
  const model = resolveStartupModel(
    undefined,
    requestedProfile && requestedProviderId === savedProviderId ? registry.activeModel(requestedProviderId) : undefined,
    process.env.XIU_MODEL,
    profile.model,
  );
  const language = settings.language ?? defaultLanguage();
  const config = createWorkspaceProviderConfig(profile, model, workspace, registry.credentialRevision(profile.id), language);
  config.projectConfigurationTrusted = true;
  config.autoApprove = false;

  const [projectIndex, skillRegistry] = [new ProjectIndex(workspace), new SkillRegistry(workspace)];
  await Promise.all([projectIndex.initialize(), skillRegistry.refresh(true)]);
  const planManager = new TaskPlanManager(undefined, false, language);
  const checkpointManager = new CheckpointManager(workspace);
  const journal = new TaskRunJournal(workspace, options.journalRoot);
  const runtime = new XiuRuntime({
    sanitize: (value) => redactSecrets(value, config.apiKey ? [config.apiKey] : []),
  });
  let approvalMode: WorkspaceApprovalMode = "ask";
  let approvalTail: Promise<unknown> = Promise.resolve();
  const requestApproval = (request: ApprovalRequest): Promise<boolean> => {
    if (canAutomaticallyApprove(approvalMode, request)) {
      request.decisionSource = "automatic";
      return Promise.resolve(true);
    }
    const next = approvalTail.then(() => runtime.snapshot().task?.state === "running" ? runtime.requestApproval(request) : false);
    approvalTail = next.catch(() => false);
    return next;
  };
  const desktopDeferredTools = new Set(["start_background_command", "list_background_commands", "read_background_output", "stop_background_command"]);
  configureBackgroundWorkspace(workspace, options.backgroundRoot);
  configureBackgroundRuntime(await resolveNodeRuntime().catch(() => undefined));
  const tools = [
    ...builtinTools,
    ...createProjectIndexTools(projectIndex),
    ...createPlanTools(planManager),
    ...createSkillTools(skillRegistry),
    ...createMediaTools(config),
  ];

  let provider: ModelProvider;
  try {
    if (!requestedProfile && !options.provider) throw new Error("请先添加渠道 / Add a Provider first");
    provider = options.provider ?? createProvider(config);
  }
  catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), config.apiKey ? [config.apiKey] : []);
    provider = {
      async complete(): Promise<never> {
        throw new Error(language === "zh-CN"
          ? `当前 Provider 尚未配置：${message}。请在设置与模型中新增或配置渠道。`
          : `The current provider is not configured: ${message}. Add or configure a channel in Settings.`);
      },
    };
  }

  const coordinator = new MultiAgentCoordinator(workspace, async (task, context) => {
    const childConfig = { ...config, cwd: context.cwd, maxTurns: task.maxTurns ?? config.maxTurns, sessionNamespace: "agent-sessions" };
    const childIndex = new ProjectIndex(context.cwd);
    await childIndex.initialize();
    const childPlan = new TaskPlanManager(undefined, task.mode === "shared_readonly", language);
    const childTools = selectSubagentTools([...builtinTools.filter((tool) => !desktopDeferredTools.has(tool.name)), ...createProjectIndexTools(childIndex), ...createPlanTools(childPlan)], task.mode);
    const child = new Agent(childConfig, options.provider ?? createProvider(childConfig), childTools, requestApproval, {
      onModelStart: (turn) => context.reportProgress(`模型调用 · 第 ${turn} 轮`),
      onToolStart: (name, description) => context.reportProgress(`${name} · ${description}`),
      onToolProgress: (name, message) => context.reportProgress(`${name} · ${message}`),
    }, undefined, childIndex, childPlan, new CheckpointManager(context.cwd));
    // Children always remain workspace/worktree scoped, even under parent full access.
    const cancel = () => child.cancel();
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (context.signal.aborted) throw new Error("Subagent cancelled before execution.");
      const guidance = task.role === "implementer" ? "Modify only your isolated Worktree and verify changes." : "Do not modify files. Investigate the inherited workspace with available read-only tools. Reviewers/testers must end with VERDICT: PASS only with concrete passing evidence, otherwise VERDICT: FAIL.";
      const result = await child.run(`${task.title}\n${task.instructions}\n${guidance}\nReturn a concise result summary without raw diffs, credentials, or private reasoning.\nDependency results:\n${context.dependencyResults.map((item) => `[${item.id}] ${redactSecrets(item.result, config.apiKey ? [config.apiKey] : []).slice(0, 16_000)}`).join("\n")}`);
      const status = child.status();
      if (status.outcome !== "completed") throw new Error(`Subagent outcome: ${status.outcome}`);
      return { result: redactSecrets(result, config.apiKey ? [config.apiKey] : []).slice(0, 16_000), stats: status.stats };
    } finally { context.signal.removeEventListener("abort", cancel); }
  }, { onTaskUpdate: (run, task) => runtime.recordSubagent({ id: `${run.id}:${task.id}`, runId: run.id, title: task.title, role: task.role, status: task.status, startedAt: task.startedAt, completedAt: task.completedAt, durationMs: task.stats?.activeMs, progress: task.progress, result: task.result, error: task.error }) }, config.agentConcurrency, config.apiKey ? [config.apiKey] : []);
  await coordinator.initialize();
  tools.push(...createMultiAgentTools(coordinator).map((tool) => tool.name !== "integrate_agent" ? tool : { ...tool, execute: async (input: Record<string, unknown>, context: import("../types.js").ToolContext) => {
    const allowed = await runtime.requestApproval({ risk: "dangerous", description: "将子智能体 Worktree 变更整合到主工作区（始终需要确认）", preview: await tool.preview!(input, context) });
    if (!allowed) throw new Error("Worktree integration was denied.");
    return tool.execute(input, context);
  } }));
  const agent = new Agent(
    config,
    provider,
    tools,
    requestApproval,
    runtime.agentEvents(),
    undefined,
    projectIndex,
    planManager,
    checkpointManager,
    skillRegistry,
    journal,
  );
  const adapter = new AgentRuntimeAdapter(agent);
  runtime.attachDriver({
    run: async (task) => { try { return await adapter.run(task); } finally { await coordinator.shutdown(); } },
    cancel: () => { const cancelled = adapter.cancel(); void coordinator.shutdown(); return cancelled; },
    steer: (text) => adapter.steer(text), status: () => adapter.status(),
  });
  let mcpCredentials;
  try { mcpCredentials = await createWindowsSystemCredentialStore<import("../mcp-auth-store.js").McpAuthSecretRecord, "mcp-oauth-record">("mcp-oauth-record"); }
  catch { /* Keep legacy/environment auth available, never downgrade system references. */ }
  const mcpManager = createMcpManager(workspace, mcpCredentials);
  const mcp = new WorkspaceMcpService(mcpManager, () => agent.replaceTools([...tools, ...mcpManager.tools()]));
  const interrupted = await journal.interrupted();
  const latest = interrupted ?? await journal.latest();
  if (latest) checkpointManager.setSession(latest.sessionId);
  if (interrupted) {
    runtime.recordRecovery({
      runId: interrupted.runId,
      status: interrupted.status === "paused" ? "paused" : "recoverable",
      interruptedOperations: interrupted.interruptedOperations.length,
      unknownSideEffects: interrupted.pendingSideEffects.length,
      recommendation: interrupted.recommendation,
    });
  }
  return {
    providerConfigured: Boolean(requestedProfile || options.provider), runtime, provider: { id: profile.id, label: profile.name, model }, journal, agent, checkpointManager, projectIndex,
    setApprovalMode: (mode) => {
      approvalMode = mode;
      agent.setAccessMode(mode === "full" ? "full" : "workspace");
    },
    coordinator, background: () => listBackgroundProcesses().slice(0, 80), mcp, close: async () => { await coordinator.shutdown(); await mcp.close(); },
  };
}
