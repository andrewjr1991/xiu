import { Agent } from "../agent.js";
import { CheckpointManager } from "../checkpoint.js";
import { resolveConfig } from "../config.js";
import { defaultLanguage } from "../i18n.js";
import { TaskPlanManager, createPlanTools } from "../plan.js";
import { ProjectIndex, createProjectIndexTools } from "../project-index.js";
import { ProviderRegistry, resolveStartupModel, resolveStartupProviderId, type ProviderProfile } from "../provider-registry.js";
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

export interface WorkspaceAgentHost {
  runtime: XiuRuntime;
  provider: { id: string; label: string; model: string };
  journal: TaskRunJournal;
  agent?: Agent;
  checkpointManager?: CheckpointManager;
  projectIndex?: ProjectIndex;
  setApprovalMode?: (mode: WorkspaceApprovalMode) => void;
}

export type WorkspaceApprovalMode = "ask" | "workspace" | "full";

export function canAutomaticallyApprove(mode: WorkspaceApprovalMode, request: Pick<ApprovalRequest, "risk" | "sessionScope">): boolean {
  if (request.risk === "dangerous") return false;
  if (mode === "full") return true;
  if (mode !== "workspace") return false;
  return request.sessionScope === "workspace-files:write"
    || request.sessionScope === "workspace-files:edit"
    || request.sessionScope === "project-verification";
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
export async function createWorkspaceAgentHost(workspace: string): Promise<WorkspaceAgentHost> {
  const settings = await new SettingsStore().load();
  let credentialStore;
  try { credentialStore = await createWindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key"); }
  catch { /* Environment and legacy credentials remain available; never copy a system secret to disk. */ }

  const registry = new ProviderRegistry(undefined, credentialStore);
  await registry.load();
  const savedProviderId = registry.activeId();
  const requestedProviderId = resolveStartupProviderId(undefined, savedProviderId, process.env.XIU_PROVIDER);
  const requestedProfile = registry.get(requestedProviderId);
  const profile = requestedProfile ?? registry.get("openai")!;
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
  const journal = new TaskRunJournal(workspace);
  const runtime = new XiuRuntime({
    sanitize: (value) => redactSecrets(value, config.apiKey ? [config.apiKey] : []),
  });
  let approvalMode: WorkspaceApprovalMode = "ask";
  const requestApproval = (request: ApprovalRequest): Promise<boolean> => {
    if (canAutomaticallyApprove(approvalMode, request)) {
      request.decisionSource = "automatic";
      return Promise.resolve(true);
    }
    return runtime.requestApproval(request);
  };
  const desktopDeferredTools = new Set(["start_background_command", "list_background_commands", "read_background_output", "stop_background_command"]);
  const tools = [
    ...builtinTools.filter((tool) => !desktopDeferredTools.has(tool.name)),
    ...createProjectIndexTools(projectIndex),
    ...createPlanTools(planManager),
    ...createSkillTools(skillRegistry),
  ];

  let provider: ModelProvider;
  try { provider = createProvider(config); }
  catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), config.apiKey ? [config.apiKey] : []);
    provider = {
      async complete(): Promise<never> {
        throw new Error(language === "zh-CN"
          ? `当前 Provider 尚未配置：${message}。请先在 CLI 中使用 /provider key 或 /providers 完成配置。`
          : `The current provider is not configured: ${message}. Configure it in the CLI with /provider key or /providers.`);
      },
    };
  }

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
  runtime.attachDriver(new AgentRuntimeAdapter(agent));
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
    runtime, provider: { id: profile.id, label: profile.name, model }, journal, agent, checkpointManager, projectIndex,
    setApprovalMode: (mode) => { approvalMode = mode; },
  };
}
