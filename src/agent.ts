import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./config.js";
import { refreshModelContext } from "./context.js";
import { buildSystemPrompt } from "./prompt.js";
import { canonicalXiuIdentity, isXiuIdentityQuestion } from "./identity.js";
import type { ProjectIndex } from "./project-index.js";
import type { TaskPlan, TaskPlanManager } from "./plan.js";
import type { CheckpointManager } from "./checkpoint.js";
import { selectableModels } from "./model-catalog.js";
import { ToolLoopGuard, toolCallSignature } from "./loop-guard.js";
import type { AvailableModel } from "./types.js";
import type { SkillRegistry } from "./skills.js";
import { normalizeAssistantText } from "./language-output.js";
import { localize } from "./i18n.js";
import type { UiLanguage } from "./i18n.js";
import { emptySessionStats, estimateConversationTokens, type RestoredSession, type SessionReplayTurn, type SessionStats } from "./session.js";
import { executeTool, formatProcessInvocation, looksLikeVerification } from "./tools.js";
import type { AgentTool, ApprovalRequest, ConversationMessage, ModelProvider } from "./types.js";
import { buildWorkspaceChangeNotice, captureWorkspaceFiles, type WorkspaceChangeNotice } from "./change-summary.js";
import { restoreTaskDiagnostics, TaskDiagnostics, type TaskDiagnosticSnapshot } from "./diagnostics.js";
import { sanitizeSecrets } from "./secret-redaction.js";
import { readEnvironmentCredential } from "./credential-store.js";
import { isTransientProviderError, safeProviderErrorMessage, type ProviderFailoverController } from "./provider-failover.js";
import { retryDecision, retryDelay } from "./retry-policy.js";
import { determineProviderRoutingPhase, type ProviderRoutingController, type ProviderRoutingPhase } from "./provider-routing.js";
import { taskOperationSignature, taskToolSideEffect, type InterruptedTaskRun, type TaskRunJournal } from "./task-run.js";

export interface AgentEvents {
  onModelStart?: (turn: number) => void;
  onModelEnd?: () => void;
  onText?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onTextStreamEnd?: () => void;
  onAssistantTurn?: (text: string, hasToolCalls: boolean) => void;
  onToolStart?: (name: string, description: string, details: { changesWorkspace: boolean; verification: boolean; risk: "read" | "write" | "execute" | "dangerous" }) => void;
  onToolProgress?: (name: string, message: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onCompletionGate?: (message: string) => void;
  onCompaction?: (message: string) => void;
  onRetry?: (message: string) => void;
  onFailure?: (message: string) => void;
  onProviderFailover?: (details: { fromProviderId: string; fromModel: string; toProviderId: string; toModel: string; reason: string; skipped: Array<{ providerId: string; reason: string }> }) => void;
  onProviderFailoverUnavailable?: (details: { providerId: string; model: string; reason: string; skipped: Array<{ providerId: string; reason: string }> }) => void;
  onProviderRoute?: (details: { phase: ProviderRoutingPhase; fromProviderId: string; fromModel: string; toProviderId: string; toModel: string; reason: string }) => void;
  onProviderRouteSkipped?: (details: { phase: ProviderRoutingPhase; providerId: string; model: string; targetProviderId?: string; reason: string }) => void;
  onProviderRouteRestore?: (details: { providerId: string; model: string }) => void;
  onPlanUpdate?: (plan: TaskPlan) => void;
  onWorkspaceChange?: (change: WorkspaceChangeNotice) => void;
  onCheckpoint?: (message: string) => void;
  onTaskComplete?: (summary: { turns: number; toolCalls: number; changed: boolean; verified: boolean; outcome: "completed" | "unverified" | "failed"; durationMs: number; diagnostics?: TaskDiagnosticSnapshot }) => void;
}

export type AgentRunOutcome = "idle" | "running" | "completed" | "unverified" | "failed" | "cancelled";

interface ToolEvidenceEntry {
  signature: string;
  name: string;
  input: string;
  outcome: string;
  count: number;
}

export class Agent {
  private messages: ConversationMessage[] = [];
  private system?: string;
  private sessionPath?: string;
  private activeController?: AbortController;
  private stats: SessionStats = emptySessionStats();
  private sessionId?: string;
  private repeatedFailures = new Map<string, number>();
  private pendingSteering: string[] = [];
  private steeringHistory: string[] = [];
  private primaryTask?: string;
  private toolEvidence: ToolEvidenceEntry[] = [];
  private lastRunOutcome: AgentRunOutcome = "idle";
  private currentTurn = 0;
  private taskDiagnostics?: TaskDiagnostics;
  private failoverController?: ProviderFailoverController;
  private routingController?: ProviderRoutingController;
  private taskFailoverOriginProviderId?: string;
  private taskAttemptedProviders = new Set<string>();
  private taskRoutingOrigin?: { config: AgentConfig; provider: ModelProvider; tools: AgentTool[] };
  private taskWasRouted = false;
  private taskRouteNotices = new Set<string>();
  private recoverySource?: InterruptedTaskRun;
  private blockedRecoveryOperations = new Set<string>();

  constructor(
    private config: AgentConfig,
    private provider: ModelProvider,
    private tools: AgentTool[],
    private approve: (request: ApprovalRequest) => Promise<boolean>,
    private events: AgentEvents = {},
    restored?: RestoredSession,
    private projectIndex?: ProjectIndex,
    private planManager?: TaskPlanManager,
    private checkpointManager?: CheckpointManager,
    private skillRegistry?: SkillRegistry,
    private taskRunJournal?: TaskRunJournal,
  ) {
    if (restored) {
      this.messages = restored.messages;
      this.sessionPath = restored.file;
      this.sessionId = restored.id;
      this.stats = restored.stats;
      if (restored.model) this.setModelInMemory(restored.model);
      this.planManager?.restore(restored.plan, restored.planMode);
      this.checkpointManager?.setSession(restored.id);
      this.taskDiagnostics = restoreTaskDiagnostics(restored.diagnostics);
    }
  }

  async run(task: string): Promise<string> {
    const startedAt = Date.now();
    const controller = new AbortController();
    this.activeController = controller;
    this.lastRunOutcome = "running";
    this.currentTurn = 0;
    this.repeatedFailures.clear();
    this.primaryTask = task.trim();
    this.steeringHistory = [];
    this.toolEvidence = [];
    this.taskDiagnostics = new TaskDiagnostics(task.trim());
    this.taskFailoverOriginProviderId = this.config.providerId;
    this.taskAttemptedProviders = new Set([this.config.providerId]);
    this.taskRoutingOrigin = { config: structuredClone(this.config), provider: this.provider, tools: [...this.tools] };
    this.taskWasRouted = false;
    this.taskRouteNotices.clear();
    this.ensureSession();
    try {
      await this.taskRunJournal?.begin({
        sessionId: this.sessionId!,
        task,
        providerId: this.config.providerId,
        model: this.config.model,
        ...(this.recoverySource ? { resumedFrom: this.recoverySource.runId } : {}),
      });
      const response = await this.runWithSignal(task, controller.signal);
      const terminalOutcome = this.lastRunOutcome as AgentRunOutcome;
      await this.taskRunJournal?.complete(terminalOutcome === "unverified" ? "unverified" : terminalOutcome === "failed" ? "failed" : "completed");
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        this.lastRunOutcome = "cancelled";
        this.taskDiagnostics?.complete("cancelled");
        if (this.taskRunJournal?.currentRun()) await this.taskRunJournal.complete("cancelled");
        throw new Error("Task cancelled.");
      }
      this.lastRunOutcome = "failed";
      this.taskDiagnostics?.complete("failed");
      if (this.taskRunJournal?.currentRun()) await this.taskRunJournal.complete("failed");
      throw error;
    } finally {
      this.stats.activeMs += Date.now() - startedAt;
      this.stats.estimatedTokens = estimateConversationTokens(this.messages);
      if (this.sessionPath) await this.log(this.sessionPath, { type: "stats", stats: this.stats });
      await this.checkpointDiagnostics();
      if (this.activeController === controller) this.activeController = undefined;
      this.pendingSteering = [];
      this.primaryTask = undefined;
      this.steeringHistory = [];
      this.taskFailoverOriginProviderId = undefined;
      this.taskAttemptedProviders.clear();
      if (this.taskWasRouted && this.taskRoutingOrigin) {
        Object.assign(this.config, this.taskRoutingOrigin.config);
        this.provider = this.taskRoutingOrigin.provider;
        this.tools = [...this.taskRoutingOrigin.tools];
        this.system = undefined;
        this.events.onProviderRouteRestore?.({ providerId: this.config.providerId, model: this.config.model });
      }
      this.taskRoutingOrigin = undefined;
      this.taskWasRouted = false;
      this.taskRouteNotices.clear();
      this.recoverySource = undefined;
      this.blockedRecoveryOperations.clear();
    }
  }

  setRecoverySource(run: InterruptedTaskRun | undefined): void {
    if (this.activeController) throw new Error("Cannot change recovery state while a task is running.");
    this.recoverySource = run;
    this.blockedRecoveryOperations = new Set(run?.operations
      .filter((operation) => operation.sideEffect !== "none" && (operation.status === "started" || operation.status === "succeeded"))
      .map((operation) => operation.signature)
      .filter((value): value is string => Boolean(value)) ?? []);
  }

  cancel(): boolean {
    if (!this.activeController) return false;
    this.activeController.abort();
    return true;
  }

  steer(text: string): boolean {
    const normalized = text.trim();
    if (!normalized || !this.activeController || this.activeController.signal.aborted) return false;
    if (this.pendingSteering.length >= 20) return false;
    this.pendingSteering.push(normalized);
    this.steeringHistory.push(normalized);
    return true;
  }

  replaceTools(tools: AgentTool[]): void {
    this.tools = [...tools];
    this.system = undefined;
  }

  setFailoverController(controller: ProviderFailoverController | undefined): void {
    this.failoverController = controller;
  }

  setRoutingController(controller: ProviderRoutingController | undefined): void {
    this.routingController = controller;
  }

  async replaceProvider(config: AgentConfig, provider: ModelProvider): Promise<void> {
    if (this.activeController) throw new Error("Cannot switch providers while a task is running.");
    Object.assign(this.config, config);
    this.provider = provider;
    this.system = undefined;
    if (this.sessionPath) await this.log(this.sessionPath, {
      type: "provider_changed",
      providerId: config.providerId,
      provider: config.provider,
      model: config.model,
    });
  }

  private async runWithSignal(task: string, signal: AbortSignal): Promise<string> {
    const startedAt = Date.now();
    const identityQuestion = isXiuIdentityQuestion(task);
    const relevant = this.projectIndex ? await this.projectIndex.search(task, 6) : "No relevant files found.";
    const profile = this.projectIndex?.profile();
    const automaticContext = [
      profile ? `Detected project: ${profile.stacks.join(", ") || "unknown stack"}; checks: ${JSON.stringify(profile.checks)}` : "",
      relevant === "No relevant files found." ? "" : `Relevant code candidates (verify by reading files before editing):\n${relevant}`,
    ].filter(Boolean).join("\n\n");
    const planModeContext = this.planManager?.mode()
      ? "Plan mode is ON. Inspect and reason, update the task plan, but do not modify files or execute project commands."
      : "";
    const prepared = [automaticContext ? `Automatically prepared project context:\n${automaticContext}` : "", planModeContext].filter(Boolean).join("\n\n");
    const contextualTask = prepared ? `${task}\n\n${prepared}` : task;
    this.messages.push({ role: "user", content: contextualTask });
    this.system ??= await buildSystemPrompt(this.config.cwd, this.skillRegistry?.catalog(), this.config.language ?? "en-US");
    this.ensureSession();
    const sessionPath = this.sessionPath!;
    this.checkpointManager?.setSession(this.sessionId!);
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await this.log(sessionPath, {
      type: "task",
      task,
      contextualTask,
      config: {
        ...this.config,
        apiKey: this.config.apiKey ? "configured" : undefined,
        baseURL: this.config.baseURL ? "configured" : undefined,
        proxy: this.config.proxy ? "configured" : undefined,
      },
    });
    await this.checkpointDiagnostics();
    if (this.planManager) {
      await this.log(sessionPath, { type: "plan_mode", enabled: this.planManager.mode() });
      const existingPlan = this.planManager.snapshot();
      if (existingPlan) await this.log(sessionPath, { type: "plan", plan: existingPlan });
    }

    let workspaceChanged = false;
    let verifiedAfterChange = false;
    let verificationAttempted = false;
    let completionReminderSent = false;
    let auditedSteeringCount = 0;
    let planReminderSent = false;
    let toolCallCount = 0;
    let lastToolFailed = false;
    const loopGuard = new ToolLoopGuard();
    for (let turn = 1; ; turn++) {
      if (this.config.maxTurns !== undefined && turn > this.config.maxTurns) {
        throw new Error(`Agent reached the user-configured ${this.config.maxTurns}-turn limit before completing the task.`);
      }
      this.currentTurn = turn;
      if (signal.aborted) throw new Error("Task cancelled.");
      await this.applyPendingSteering(turn);
      if (estimateConversationTokens(this.messages) >= (this.config.contextLimit ?? 102_400)) {
        await this.compactWithSignal(signal, "automatic context limit");
        loopGuard.reset();
      }
      this.events.onModelStart?.(turn);
      let response;
      let streamed = false;
      const modelOperation = await this.taskRunJournal?.beginOperation({ kind: "model", name: `turn ${turn}`, sideEffect: "none" });
      try {
        // Buffer Chinese output so it can be normalized before anything is
        // rendered. Streaming partial tokens cannot be converted reliably.
        const activePlanStep = this.planManager?.snapshot()?.steps.find((step) => step.status === "in_progress")?.title ?? "";
        const routing = determineProviderRoutingPhase({
          turn,
          planMode: this.planManager?.mode() === true,
          completionGateActive: completionReminderSent,
          activePlanStep,
        });
        const requested = await this.requestModel(signal, !identityQuestion && this.config.language !== "zh-CN", true, undefined, undefined, routing.phase, routing.reason);
        response = requested.response;
        streamed = requested.streamed;
      } catch (error) {
        if (modelOperation) await this.taskRunJournal?.finishOperation(modelOperation, signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        this.events.onModelEnd?.();
      }
      if (identityQuestion) {
        response = {
          ...response,
          text: canonicalXiuIdentity(this.config.language ?? "en-US"),
          toolCalls: [],
          raw: undefined,
        };
      } else {
        const normalized = normalizeAssistantText(response.text, this.config.language ?? "en-US");
        if (normalized !== response.text) response = { ...response, text: normalized, raw: undefined };
      }
      this.recordUsage(response.usage, response.text);
      if (response.text && !streamed) this.events.onText?.(response.text);
      if (streamed && response.text) this.events.onTextStreamEnd?.();
      if (response.text) this.events.onAssistantTurn?.(response.text, response.toolCalls.length > 0);
      this.messages.push({ role: "assistant", content: response.text, raw: response.raw, toolCalls: response.toolCalls });
      await this.log(sessionPath, { type: "assistant", turn, text: response.text, raw: response.raw, toolCalls: response.toolCalls, usage: response.usage });
      if (modelOperation) {
        await this.taskRunJournal?.finishOperation(modelOperation, "succeeded", `assistant turn ${turn} persisted`);
        await this.taskRunJournal?.recoveryPoint("assistant", `assistant turn ${turn} completed`, modelOperation);
      }

      if (response.toolCalls.length === 0) {
        if (await this.applyPendingSteering(turn)) continue;
        const unfinishedPlan = this.planManager?.snapshot()?.steps.some((step) => step.status === "pending" || step.status === "in_progress");
        if (unfinishedPlan && !this.planManager?.mode() && !planReminderSent) {
          const reminder = "Plan gate: the visible task plan still has pending or in-progress steps. Complete the work or update blocked steps with an explanation before finishing.";
          this.messages.push({ role: "user", content: reminder });
          await this.log(sessionPath, { type: "plan_gate", turn, message: reminder });
          this.events.onCompletionGate?.(reminder);
          planReminderSent = true;
          continue;
        }
        if (this.steeringHistory.length > auditedSteeringCount) {
          const gate = `Task-contract completion audit: do not finish merely because you answered the latest steering. Re-check every required outcome below against concrete evidence. If any item is incomplete, continue using tools now. Only finish after the PRIMARY GOAL and all ADDITIONAL REQUIREMENTS are complete.\n\nPRIMARY GOAL (still mandatory):\n${this.primaryTask}\n\nADDITIONAL REQUIREMENTS:\n${this.steeringHistory.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
          this.messages.push({ role: "user", content: gate });
          await this.log(sessionPath, { type: "task_contract_gate", turn, message: gate });
          this.events.onCompletionGate?.(gate);
          auditedSteeringCount = this.steeringHistory.length;
          continue;
        }
        if (workspaceChanged && !verifiedAfterChange && !completionReminderSent) {
          const gate = `Completion gate: files changed but no verification has passed${verificationAttempted ? "; the attempted check failed or was unavailable" : ""}. Run a relevant test, typecheck, lint, build, or use verify_output with explicit expectations for a generated artifact. A check must fail deterministically when an expectation is unmet; printing booleans or search counts is not sufficient. If verification remains impossible, report the limitation; Xiu will mark the task unverified rather than successful.`;
          this.messages.push({ role: "user", content: gate });
          await this.log(sessionPath, { type: "completion_gate", turn, message: gate });
          this.events.onCompletionGate?.(gate);
          completionReminderSent = true;
          continue;
        }
        const outcome = lastToolFailed ? "failed" : workspaceChanged && !verifiedAfterChange ? "unverified" : "completed";
        this.lastRunOutcome = outcome;
        this.taskDiagnostics?.complete(outcome);
        await this.checkpointDiagnostics();
        this.events.onTaskComplete?.({
          turns: turn,
          toolCalls: toolCallCount,
          changed: workspaceChanged,
          verified: verifiedAfterChange,
          outcome,
          durationMs: Date.now() - startedAt,
          diagnostics: this.taskDiagnostics?.snapshot(),
        });
        return response.text;
      }

      let toolBatchSucceeded = false;
      let toolBatchFailed = false;
      for (const call of response.toolCalls) {
        toolCallCount++;
        this.stats.toolCalls++;
        this.taskDiagnostics?.beginTool(call.name, call.input);
        const tool = this.tools.find((candidate) => candidate.name === call.name);
        let result: string;
        let abortForLoop = false;
        let taskOperationId: string | undefined;
        let taskOperationKind: "tool" | "verification" = "tool";
        if (!tool) {
          result = `Unknown tool: ${call.name}`;
        } else {
          try {
          const description = tool.describe(call.input);
          const risk = typeof tool.risk === "function" ? tool.risk(call.input) : tool.risk;
          const changesWorkspace = typeof tool.changesWorkspace === "function"
            ? tool.changesWorkspace(call.input)
            : tool.changesWorkspace;
          const workspacePaths = changesWorkspace ? this.workspacePaths(call.input) : [];
          const workspaceBefore = workspacePaths.length ? await captureWorkspaceFiles(this.config.cwd, workspacePaths) : new Map();
          this.events.onToolStart?.(call.name, description, {
            changesWorkspace: Boolean(changesWorkspace),
            verification: this.isVerificationAttempt(call.name, call.input),
            risk,
          });
          const failureKey = `${call.name}:${JSON.stringify(call.input)}`;
          const loop = loopGuard.observe(call.name, call.input);
          abortForLoop = loop.abort;
          if (loop.blocked) {
            result = `Tool error: ${loop.reason}`;
          } else if (this.planManager?.mode() && risk !== "read") {
            result = `Tool execution denied: plan mode is read-only. Update the plan or ask the user to turn plan mode off.`;
          } else if ((this.repeatedFailures.get(failureKey) ?? 0) >= 3) {
            result = "Tool error: the same operation already failed three times. Diagnose the cause or choose a different approach.";
          } else if (this.blockedRecoveryOperations.has(taskOperationSignature(call.name, call.input))) {
            result = "Tool execution blocked by crash recovery: this exact side-effecting operation was in-flight when Xiu stopped. Verify its effect first; do not replay it automatically.";
          } else {
            taskOperationKind = this.isVerificationAttempt(call.name, call.input) ? "verification" : "tool";
            try {
              taskOperationId = await this.taskRunJournal?.beginOperation({
                kind: taskOperationKind,
                name: call.name,
                signature: taskOperationSignature(call.name, call.input),
                risk,
                sideEffect: taskToolSideEffect(risk, Boolean(changesWorkspace)),
              });
            } catch (error) {
              throw new Error(`Task recovery journal unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
            result = await executeTool(tool, call.input, {
              cwd: this.config.cwd,
              approve: async (request) => {
                this.taskDiagnostics?.beginApproval(request.description);
                let approved: boolean | undefined;
                try { approved = await this.approve(request); }
                finally { this.taskDiagnostics?.finishApproval(approved !== false, request.decisionSource ?? "prompted"); }
                if (approved && changesWorkspace) {
                  const checkpointOperation = await this.taskRunJournal?.beginOperation({ kind: "checkpoint", name: `before ${call.name}`, sideEffect: "none" });
                  let checkpoint: Awaited<ReturnType<CheckpointManager["capture"]>>;
                  try {
                    checkpoint = await this.checkpointManager?.capture(call.name, call.input, tool.describe(call.input));
                    if (checkpointOperation) await this.taskRunJournal?.finishOperation(checkpointOperation, "succeeded", checkpoint ? `checkpoint ${checkpoint.id}` : "checkpoint not required");
                  } catch (error) {
                    if (checkpointOperation) await this.taskRunJournal?.finishOperation(checkpointOperation, "failed", error instanceof Error ? error.message : String(error));
                    throw error;
                  }
                  if (checkpoint) {
                    await this.log(this.sessionPath!, { type: "checkpoint", checkpoint });
                    await this.taskRunJournal?.recoveryPoint("checkpoint", `checkpoint ${checkpoint.id} captured`, checkpointOperation);
                    this.events.onCheckpoint?.(localize(this.config.language ?? "en-US", `已保存恢复点 ${checkpoint.id}：${checkpoint.files.map((file) => file.path).join(", ")}`, `Checkpoint ${checkpoint.id} saved for ${checkpoint.files.map((file) => file.path).join(", ")}`));
                  }
                }
                return approved;
              },
              signal,
              reportProgress: (message) => this.events.onToolProgress?.(call.name, message),
            });
          }
          this.events.onToolEnd?.(call.name, result);
          if (this.toolResultFailed(result)) {
            this.repeatedFailures.set(failureKey, (this.repeatedFailures.get(failureKey) ?? 0) + 1);
            this.events.onFailure?.(`${call.name}: ${result.split(/\r?\n/, 1)[0]}`);
          } else this.repeatedFailures.delete(failureKey);
          if (call.name === "update_task_plan" && !/^Tool error:/.test(result)) {
            const plan = this.planManager?.snapshot();
            if (plan) await this.log(sessionPath, { type: "plan", plan });
            if (plan) this.events.onPlanUpdate?.(plan);
            if (plan) this.taskDiagnostics?.recordProgress();
          }
          if (changesWorkspace && !/^Tool (error|execution denied)/.test(result)) {
            workspaceChanged = true;
            this.taskDiagnostics?.recordProgress();
            verifiedAfterChange = false;
            loopGuard.reset();
            this.projectIndex?.invalidate();
            if (workspacePaths.length) {
              const workspaceAfter = await captureWorkspaceFiles(this.config.cwd, workspacePaths);
              const change = buildWorkspaceChangeNotice(call.name, description, workspacePaths, workspaceBefore, workspaceAfter);
              if (change) this.events.onWorkspaceChange?.(change);
            }
          }
          if (tool.isVerification?.(call.input, result)) {
            verifiedAfterChange = true;
            this.taskDiagnostics?.recordProgress();
          }
          if (tool.isVerification?.(call.input, result) || this.isVerificationAttempt(call.name, call.input)) verificationAttempted = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.startsWith("Task recovery journal unavailable:")) throw error;
            result = `Tool error: invalid arguments for ${call.name}: ${message}`;
            this.events.onToolEnd?.(call.name, result);
            this.events.onFailure?.(`${call.name}: ${result}`);
          }
        }
        const callFailed = this.toolResultFailed(result) || /^Tool execution denied by user\./i.test(result);
        if (callFailed) toolBatchFailed = true;
        else toolBatchSucceeded = true;
        const diagnosticOutcome = /^Tool execution denied by user\./i.test(result) ? "denied" : (this.toolResultFailed(result) ? "failure" : "success");
        this.taskDiagnostics?.finishTool(diagnosticOutcome, result);
        this.recordToolEvidence(call.name, call.input, result);
        const contextResult = this.boundToolContext(result);
        this.messages.push({ role: "tool", content: contextResult, toolCallId: call.id, toolName: call.name });
        await this.log(sessionPath, {
          type: "tool",
          turn,
          id: call.id,
          name: call.name,
          input: call.input,
          result,
          ...(contextResult === result ? {} : { contextResult }),
        });
        if (taskOperationId) {
          await this.taskRunJournal?.finishOperation(taskOperationId, callFailed ? "failed" : "succeeded", result);
          await this.taskRunJournal?.recoveryPoint(taskOperationKind, `${call.name} ${callFailed ? "failed" : "succeeded"}`, taskOperationId);
        }
        await this.checkpointDiagnostics();
        if (abortForLoop) throw new Error("Agent stopped after repeatedly revisiting the same tool calls without making progress.");
      }
      lastToolFailed = toolBatchFailed && !toolBatchSucceeded;
    }
  }

  clearConversation(): void {
    this.messages = [];
    this.system = undefined;
    this.sessionPath = undefined;
    this.sessionId = undefined;
    this.stats = emptySessionStats();
    this.lastRunOutcome = "idle";
    this.currentTurn = 0;
    this.pendingSteering = [];
    this.steeringHistory = [];
    this.primaryTask = undefined;
    this.toolEvidence = [];
    this.taskDiagnostics = undefined;
    this.planManager?.restore(undefined, false);
    this.checkpointManager?.clearSession();
  }

  async compact(focus?: string): Promise<string> {
    if (!this.messages.length) return localize(this.config.language ?? "en-US", "没有可压缩的对话上下文。", "No conversation context to compact.");
    const controller = new AbortController();
    this.activeController = controller;
    try { return await this.compactWithSignal(controller.signal, "manual request", focus); }
    finally { if (this.activeController === controller) this.activeController = undefined; }
  }

  history(limit = 20): string {
    const visible = this.messages.filter((message) => message.role !== "tool").slice(-limit);
    const language = this.config.language ?? "en-US";
    if (!visible.length) return localize(language, "没有对话历史。", "No conversation history.");
    return visible.map((message) => {
      const content = message.content.replace(/\s+/g, " ").trim();
      const role = message.role === "user" ? localize(language, "用户", "user") : message.role === "assistant" ? "Xiu" : localize(language, "工具", "tool");
      return `${role}: ${content.length > 240 ? `${content.slice(0, 240)}...` : content}`;
    }).join("\n");
  }

  status(): { sessionId?: string; model: string; messages: number; stats: SessionStats; contextLimit: number; contextWindow: number; contextWindowSource: string; contextLimitMode: string; index?: ReturnType<ProjectIndex["status"]>; planMode: boolean; outcome: AgentRunOutcome; turn: number; maxTurns?: number; pendingSteering: number; diagnostics?: TaskDiagnosticSnapshot } {
    return {
      sessionId: this.sessionId,
      model: this.config.model,
      messages: this.messages.length,
      stats: { ...this.stats, estimatedTokens: estimateConversationTokens(this.messages) },
      contextLimit: this.config.contextLimit ?? 102_400,
      contextWindow: this.config.contextWindow ?? 128_000,
      contextWindowSource: this.config.contextWindowSource ?? "fallback",
      contextLimitMode: this.config.contextLimitMode ?? "automatic",
      index: this.projectIndex?.status(),
      planMode: this.planManager?.mode() ?? false,
      outcome: this.lastRunOutcome,
      turn: this.currentTurn,
      maxTurns: this.config.maxTurns,
      pendingSteering: this.pendingSteering.length,
      diagnostics: this.taskDiagnostics?.snapshot(),
    };
  }

  async setModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) throw new Error("Model name cannot be empty.");
    this.setModelInMemory(trimmed);
    if (this.sessionPath) await this.log(this.sessionPath, { type: "model_changed", model: trimmed });
  }

  /** Persist the semantic terminal result once the CLI has assembled its visible cards. */
  async recordReplayTurn(turn: SessionReplayTurn): Promise<void> {
    if (this.sessionPath) await this.log(this.sessionPath, { type: "ui_turn", version: 1, turn });
  }

  async listModels(): Promise<{ models: AvailableModel[]; discoveryError?: string }> {
    let discovered: AvailableModel[] = [];
    let discoveryError: string | undefined;
    if (this.provider.listModels) {
      try { discovered = await this.provider.listModels(); }
      catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
    }
    const features = this.config.providerFeatures;
    const capabilities = features
      ? ["text", features.tools && "tools", features.vision && "vision", features.image && "image", features.video && "video"].filter(Boolean) as string[]
      : ["text", "tools"];
    return {
      models: selectableModels(this.config.provider, this.config.model, discovered, this.config.language).map((model) => ({
        ...model,
        capabilities,
        contextWindow: model.contextWindow ?? (model.id === this.config.model ? this.config.contextWindow : undefined),
        providerId: this.config.providerId,
      })),
      discoveryError,
    };
  }

  restoreSession(restored: RestoredSession): void {
    if (this.activeController) throw new Error("Cannot switch sessions while a task is running.");
    this.messages = restored.messages;
    this.sessionPath = restored.file;
    this.sessionId = restored.id;
    this.stats = restored.stats;
    this.system = undefined;
    this.lastRunOutcome = "idle";
    this.currentTurn = 0;
    this.pendingSteering = [];
    this.steeringHistory = [];
    this.primaryTask = undefined;
    this.toolEvidence = [];
    this.taskDiagnostics = restoreTaskDiagnostics(restored.diagnostics);
    if (restored.model) this.setModelInMemory(restored.model);
    this.planManager?.restore(restored.plan, restored.planMode);
    this.checkpointManager?.setSession(restored.id);
  }

  private ensureSession(): void {
    if (this.sessionPath && this.sessionId) return;
    this.sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const namespace = this.config.sessionNamespace ?? "sessions";
    if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid session namespace.");
    this.sessionPath = path.join(this.config.cwd, ".xiu", namespace, `${this.sessionId}.jsonl`);
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    if (!this.planManager) throw new Error("Plan manager is unavailable.");
    this.planManager.setMode(enabled);
    if (this.sessionPath) await this.log(this.sessionPath, { type: "plan_mode", enabled });
  }

  plan(): string {
    return this.planManager?.format() ?? localize(this.config.language ?? "en-US", "任务计划管理器不可用。", "Plan manager is unavailable.");
  }

  reloadInstructions(): void {
    this.system = undefined;
  }

  setLanguage(language: UiLanguage): void {
    this.config.language = language;
    this.planManager?.setLanguage(language);
    this.reloadInstructions();
  }

  private setModelInMemory(model: string): void {
    const previous = this.config.model;
    refreshModelContext(this.config, model);
    this.config.model = model;
    if (this.config.capabilities) {
      this.config.capabilities.text = model;
      if (this.config.provider !== "agnes" || this.config.capabilities.vision === previous) this.config.capabilities.vision = model;
    }
  }

  private recordUsage(usage: { inputTokens: number; outputTokens: number } | undefined, text: string): void {
    this.stats.modelCalls++;
    this.stats.inputTokens += usage?.inputTokens ?? estimateConversationTokens(this.messages);
    this.stats.outputTokens += usage?.outputTokens ?? Math.ceil(text.length / 4);
    this.stats.estimatedTokens = estimateConversationTokens(this.messages);
  }

  private async applyPendingSteering(turn: number): Promise<boolean> {
    if (!this.pendingSteering.length) return false;
    const items = this.pendingSteering.splice(0);
    const operation = await this.taskRunJournal?.beginOperation({ kind: "steering", name: `turn ${turn} steering`, sideEffect: "none" });
    const content = `User steering received while the task was running. It adds requirements but NEVER replaces or lowers the priority of the primary goal. Do not stop after answering only the steering. Continue until both sections are complete.\n\nPRIMARY GOAL (still mandatory):\n${this.primaryTask}\n\nADDITIONAL REQUIREMENTS:\n${this.steeringHistory.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nNEWLY RECEIVED IN THIS TURN:\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
    this.messages.push({ role: "user", content });
    this.taskDiagnostics?.recordProgress();
    if (this.sessionPath) await this.log(this.sessionPath, { type: "steering", turn, items });
    if (operation) {
      await this.taskRunJournal?.finishOperation(operation, "succeeded", `${items.length} steering item(s) persisted`);
      await this.taskRunJournal?.recoveryPoint("steering", `turn ${turn} steering persisted`, operation);
    }
    return true;
  }

  private isVerificationAttempt(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName === "verify_output" || toolName === "validate_project") return true;
    if (toolName === "run_command") return looksLikeVerification(String(input.command ?? ""));
    if (toolName === "run_process") {
      const program = typeof input.program === "string" ? input.program : "";
      const args = Array.isArray(input.args) ? input.args.filter((value): value is string => typeof value === "string") : [];
      return looksLikeVerification(formatProcessInvocation(program, args));
    }
    return false;
  }

  private workspacePaths(input: Record<string, unknown>): string[] {
    const values = [input.path, input.output_path, input.destination, input.file];
    if (Array.isArray(input.paths)) values.push(...input.paths);
    return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].slice(0, 6);
  }

  private async compactWithSignal(signal: AbortSignal, reason: string, focus?: string): Promise<string> {
    if (this.messages.length < 2) return localize(this.config.language ?? "en-US", "当前对话已经足够精简。", "Conversation is already compact.");
    const before = estimateConversationTokens(this.messages);
    this.events.onCompaction?.(localize(this.config.language ?? "en-US", `正在压缩约 ${before.toLocaleString()} tokens（${reason}）`, `Compacting ${before.toLocaleString()} estimated tokens (${reason})`));
    const primaryGoal = this.primaryTask?.trim() || this.recentUserGoals()[0] || "Continue the most recent user task.";
    const additionalRequirements = this.steeringHistory.length
      ? this.steeringHistory.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "None recorded.";
    const currentPlan = this.planManager?.snapshot() ? this.planManager.format() : "No explicit task plan recorded.";
    const recentRequirements = this.recentUserRequirements();
    const taskContract = [
      "ACTIVE TASK CONTRACT (authoritative; must survive compaction)",
      "PRIMARY GOAL:",
      primaryGoal,
      "",
      "ADDITIONAL REQUIREMENTS:",
      additionalRequirements,
      "",
      "CURRENT PLAN:",
      currentPlan,
      "",
      "RECENT USER REQUIREMENTS (verbatim; preserve exact nuance):",
      recentRequirements,
      "",
      "COMPACTION FOCUS:",
      focus?.trim() || "Preserve decisions, code changes, verification evidence, unresolved risks, and the exact next action.",
      "",
      "TOOL EVIDENCE LEDGER (program-recorded; do not repeat completed calls without a concrete reason):",
      this.formatToolEvidence(),
    ].join("\n");
    const transcript = this.messages.map((message) => {
      const label = message.role === "tool" ? `tool:${message.toolName ?? "unknown"}` : message.role;
      return `[${label}]\n${message.content}`;
    }).join("\n\n");
    let summary: string;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    const diagnoseCompaction = this.lastRunOutcome === "running" ? this.taskDiagnostics : undefined;
    diagnoseCompaction?.recordCompaction();
    try {
      const previousMessages = this.messages;
      const previousSystem = this.system;
      const previousDiagnostics = this.taskDiagnostics;
      this.messages = [{ role: "user", content: `${taskContract}\n\nFULL TRANSCRIPT TO COMPACT:\n${transcript}` }];
      this.system = "You are performing a CONTEXT CHECKPOINT COMPACTION for a coding agent; in other words, you compact coding-agent context. Produce a concise, factual handoff for the next model. Use these headings: Current progress; Completed evidence; Key findings and decisions; Failed approaches (do not repeat); Files and exact commands; Next action; Verification status; Constraints. Never replace or weaken the authoritative task contract. Distinguish completed facts from intended work. Do not call tools or add conversational commentary.";
      this.taskDiagnostics = diagnoseCompaction;
      let response: Awaited<ReturnType<ModelProvider["complete"]>>;
      try {
        ({ response } = await this.requestModel(signal, false, false, [], "context compaction"));
      } finally {
        this.messages = previousMessages;
        this.system = previousSystem;
        this.taskDiagnostics = previousDiagnostics;
      }
      summary = this.boundCheckpointSummary(response.text);
      usage = response.usage;
      this.recordUsage(response.usage, response.text);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const userGoals = this.recentUserGoals().slice(0, 8).map((message) => message.slice(0, 2500));
      const recent = this.messages.slice(-12).map((message) => `[${message.role}${message.toolName ? `:${message.toolName}` : ""}] ${message.content.slice(0, 2500)}`);
      summary = this.boundCheckpointSummary(`Model-assisted compaction failed (${error instanceof Error ? error.message : String(error)}). Local continuation brief:\nRecent user goals:\n${userGoals.join("\n---\n")}\n\nRecent activity:\n${recent.join("\n\n")}`);
    }
    const context = [
      taskContract,
      "",
      `CONTEXT CHECKPOINT (${new Date().toISOString()}):`,
      summary,
      "",
      "CONTINUATION RULES:",
      "1. Resume from the recorded Next action; do not restart discovery or reread files already covered by Completed evidence unless the evidence is missing or stale.",
      "2. The PRIMARY GOAL remains mandatory. ADDITIONAL REQUIREMENTS supplement it and never replace it.",
      "3. Verify concrete outputs before declaring completion.",
    ].join("\n");
    this.messages = [{ role: "user", content: context }];
    this.stats.compactions++;
    this.stats.estimatedTokens = estimateConversationTokens(this.messages);
    if (this.sessionPath) await this.log(this.sessionPath, { type: "compact", reason, beforeTokens: before, afterTokens: this.stats.estimatedTokens, context, usage });
    await this.checkpointDiagnostics();
    return localize(this.config.language ?? "en-US", `上下文已从约 ${before.toLocaleString()} tokens 压缩到 ${this.stats.estimatedTokens.toLocaleString()} tokens。`, `Compacted context from about ${before.toLocaleString()} to ${this.stats.estimatedTokens.toLocaleString()} tokens.`);
  }

  private recentUserGoals(): string[] {
    const internalPrefixes = [
      "Compacted session context",
      "ACTIVE TASK CONTRACT",
      "User steering received while the task was running",
      "Task-contract completion audit",
      "Completion gate:",
      "Plan gate:",
    ];
    return this.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.trim())
      .filter((content) => content && !internalPrefixes.some((prefix) => content.startsWith(prefix)))
      .reverse();
  }

  private recentUserRequirements(): string {
    const selected: string[] = [];
    let tokens = 0;
    for (const message of this.recentUserGoals()) {
      const bounded = message.length > 24_000 ? `${message.slice(0, 16_000)}\n...[middle omitted]...\n${message.slice(-8_000)}` : message;
      const estimated = estimateConversationTokens([{ role: "user", content: bounded }]);
      if (selected.length && tokens + estimated > 16_000) break;
      selected.push(bounded);
      tokens += estimated;
      if (tokens >= 16_000 || selected.length >= 6) break;
    }
    return selected.reverse().map((message, index) => `[User requirement ${index + 1}]\n${message}`).join("\n\n") || "None recorded.";
  }

  private boundCheckpointSummary(summary: string): string {
    const normalized = summary.trim();
    const limit = 24_000;
    if (normalized.length <= limit) return normalized;
    const marker = "\n\n[Checkpoint summary middle omitted to stay within the context budget.]\n\n";
    return `${normalized.slice(0, 16_000)}${marker}${normalized.slice(-8_000)}`;
  }

  private boundToolContext(result: string): string {
    const limit = 32_000;
    if (result.length <= limit) return result;
    const marker = `\n\n[Tool output middle omitted from model context: ${result.length.toLocaleString()} characters total. Full output remains in the session log.]\n\n`;
    const available = limit - marker.length;
    const head = Math.ceil(available * 0.6);
    const tail = available - head;
    return `${result.slice(0, head)}${marker}${result.slice(-tail)}`;
  }

  private recordToolEvidence(name: string, input: Record<string, unknown>, result: string): void {
    const signature = toolCallSignature(name, input);
    const existingIndex = this.toolEvidence.findIndex((entry) => entry.signature === signature);
    const safeInput = Object.fromEntries(Object.entries(input).map(([key, value]) => {
      if (["content", "old_text", "new_text"].includes(key) && typeof value === "string") return [key, `<${value.length} characters>`];
      return [key, value];
    }));
    const serialized = JSON.stringify(safeInput);
    const outcome = result.replace(/\s+/g, " ").trim().slice(0, 240) || "empty result";
    const entry: ToolEvidenceEntry = {
      signature,
      name,
      input: serialized.length > 800 ? `${serialized.slice(0, 800)}...` : serialized,
      outcome,
      count: existingIndex >= 0 ? this.toolEvidence[existingIndex]!.count + 1 : 1,
    };
    if (existingIndex >= 0) this.toolEvidence.splice(existingIndex, 1);
    this.toolEvidence.push(entry);
    if (this.toolEvidence.length > 60) this.toolEvidence.shift();
  }

  private formatToolEvidence(): string {
    if (!this.toolEvidence.length) return "No tool evidence recorded yet.";
    return this.toolEvidence.slice(-40).map((entry) =>
      `- ${entry.name} ${entry.input} => ${entry.outcome}${entry.count > 1 ? ` (completed ${entry.count} times)` : ""}`
    ).join("\n");
  }

  private async requestModel(signal: AbortSignal, allowStreaming = true, reportFailure = true, toolOverride?: AgentTool[], operationOverride?: string, routingPhase?: ProviderRoutingPhase, routingReason = "implementation"): Promise<{ response: Awaited<ReturnType<ModelProvider["complete"]>>; streamed: boolean }> {
    const maxAttempts = 3;
    const originProviderId = this.taskFailoverOriginProviderId ?? this.config.providerId;
    this.taskAttemptedProviders.add(this.config.providerId);
    if (routingPhase && this.routingController) {
      const fromProviderId = this.config.providerId;
      const fromModel = this.config.model;
      const estimatedInputTokens = estimateConversationTokens(this.messages);
      let resolution;
      try {
        const taskDefault = this.taskRoutingOrigin?.config ?? this.config;
        resolution = await this.routingController.resolve({
          phase: routingPhase,
          currentProviderId: fromProviderId,
          currentModel: fromModel,
          defaultProviderId: taskDefault.providerId,
          defaultModel: taskDefault.model,
          estimatedInputTokens,
          requiresTools: (toolOverride ?? this.tools).length > 0,
        });
      } catch (error) {
        resolution = { reason: error instanceof Error ? error.message : String(error) };
      }
      const candidate = resolution.useDefault && this.taskRoutingOrigin
        ? { ...this.taskRoutingOrigin, label: "task default" }
        : resolution.candidate;
      if (candidate && (candidate.config.providerId !== fromProviderId || candidate.config.model !== fromModel)) {
        Object.assign(this.config, candidate.config);
        this.provider = candidate.provider;
        this.tools = [...candidate.tools];
        this.taskAttemptedProviders.add(candidate.config.providerId);
        this.taskWasRouted = true;
        const reason = resolution.reason ?? `configured ${routingPhase} route`;
        this.taskDiagnostics?.recordProviderRoute(routingPhase, fromProviderId, fromModel, candidate.config.providerId, candidate.config.model, "switched", reason);
        if (this.sessionPath) await this.log(this.sessionPath, {
          type: "provider_route", phase: routingPhase, outcome: "switched",
          fromProviderId, fromModel, toProviderId: candidate.config.providerId, toModel: candidate.config.model, reason,
        });
        this.events.onProviderRoute?.({ phase: routingPhase, fromProviderId, fromModel, toProviderId: candidate.config.providerId, toModel: candidate.config.model, reason });
        await this.checkpointDiagnostics();
      } else if (resolution.reason && resolution.targetProviderId) {
        const noticeKey = `${routingPhase}\0${fromProviderId}\0${fromModel}\0${resolution.targetProviderId}\0${resolution.reason}`;
        if (!this.taskRouteNotices.has(noticeKey)) {
          this.taskRouteNotices.add(noticeKey);
          this.taskDiagnostics?.recordProviderRoute(routingPhase, fromProviderId, fromModel, resolution.targetProviderId, undefined, "skipped", resolution.reason);
          if (this.sessionPath) await this.log(this.sessionPath, {
            type: "provider_route", phase: routingPhase, outcome: "skipped",
            fromProviderId, fromModel, toProviderId: resolution.targetProviderId, reason: resolution.reason,
          });
          this.events.onProviderRouteSkipped?.({ phase: routingPhase, providerId: fromProviderId, model: fromModel, targetProviderId: resolution.targetProviderId, reason: resolution.reason });
          await this.checkpointDiagnostics();
        }
      }
    }
    if (routingPhase) this.taskDiagnostics?.recordProviderPhase(routingPhase, this.config.providerId ?? this.config.provider, this.config.model, routingReason);
    let attempt = 1;
    for (;;) {
      let emitted = false;
      const operation = operationOverride ?? `turn ${this.currentTurn}`;
      const estimatedInput = estimateConversationTokens(this.messages);
      this.taskDiagnostics?.beginModel(operation, attempt);
      try {
        let response: Awaited<ReturnType<ModelProvider["complete"]>>;
        let streamed = false;
        const modelTools = toolOverride ?? (this.config.providerFeatures?.tools === false ? [] : this.tools);
        if (allowStreaming && this.provider.stream && this.events.onTextDelta) {
          response = await this.provider.stream(this.system!, this.messages, modelTools, (delta) => {
            emitted = true;
            this.events.onTextDelta?.(delta);
          }, signal);
          streamed = emitted;
        } else {
          response = await this.provider.complete(this.system!, this.messages, modelTools, signal);
        }
        this.taskDiagnostics?.finishModel(response.usage ?? { inputTokens: estimatedInput, outputTokens: Math.ceil(response.text.length / 4) }, true);
        await this.checkpointDiagnostics();
        return { response, streamed };
      } catch (error) {
        const safeError = safeProviderErrorMessage(error, [this.config.apiKey ?? ""]);
        if (signal.aborted) {
          this.taskDiagnostics?.cancelActive();
          await this.checkpointDiagnostics();
          throw error;
        }
        this.taskDiagnostics?.finishModel(undefined, false, safeError);
        await this.checkpointDiagnostics();
        const transient = isTransientProviderError(error);
        const decision = retryDecision({
          operation: "model",
          error,
          attempt,
          maxAttempts,
          replaySafety: "safe",
          commitState: "not-committed",
          outputEmitted: emitted,
        });
        if (emitted || !transient) {
          if (reportFailure) this.events.onFailure?.(localize(this.config.language ?? "en-US", `模型请求失败：${safeError}`, `Model request failed: ${safeError}`));
          throw new Error(safeError);
        }
        if (decision.retry) {
          const delayMs = decision.delayMs ?? 0;
          this.events.onRetry?.(localize(this.config.language ?? "en-US", `模型暂时出错；${delayMs}ms 后重试 ${attempt + 1}/${maxAttempts}`, `Temporary model error; retrying ${attempt + 1}/${maxAttempts} in ${delayMs}ms`));
          await retryDelay(delayMs, signal);
          attempt++;
          continue;
        }

        const failedProviderId = this.config.providerId;
        const failedModel = this.config.model;
        const failedApiKey = this.config.apiKey;
        let resolution;
        try {
          resolution = await this.failoverController?.resolve({
            originProviderId,
            currentProviderId: failedProviderId,
            currentModel: failedModel,
            attemptedProviderIds: [...this.taskAttemptedProviders],
            error,
            estimatedInputTokens: estimatedInput,
            requiresTools: (toolOverride ?? (this.config.providerFeatures?.tools === false ? [] : this.tools)).length > 0,
          });
        } catch (failoverError) {
          resolution = { reason: failoverError instanceof Error ? failoverError.message : String(failoverError) };
        }
        if (!resolution?.candidate) {
          const reason = resolution?.reason ?? localize(this.config.language ?? "en-US", "没有配置可用的备用 Provider", "No usable fallback provider is configured");
          if (reportFailure) {
            this.events.onProviderFailoverUnavailable?.({ providerId: failedProviderId, model: failedModel, reason, skipped: resolution?.skipped ?? [] });
            this.events.onFailure?.(localize(this.config.language ?? "en-US", `模型请求失败：${safeError}`, `Model request failed: ${safeError}`));
          }
          throw new Error(safeError);
        }

        const candidate = resolution.candidate;
        Object.assign(this.config, candidate.config);
        this.provider = candidate.provider;
        this.tools = [...candidate.tools];
        this.taskAttemptedProviders.add(candidate.config.providerId);
        const reason = safeProviderErrorMessage(error, [failedApiKey ?? ""]);
        this.taskDiagnostics?.recordProviderFailover(failedProviderId, failedModel, candidate.config.providerId, candidate.config.model, reason);
        if (this.sessionPath) await this.log(this.sessionPath, {
          type: "provider_failover",
          fromProviderId: failedProviderId,
          fromModel: failedModel,
          toProviderId: candidate.config.providerId,
          toModel: candidate.config.model,
          reason,
          skipped: resolution.skipped ?? [],
        });
        this.events.onProviderFailover?.({
          fromProviderId: failedProviderId,
          fromModel: failedModel,
          toProviderId: candidate.config.providerId,
          toModel: candidate.config.model,
          reason,
          skipped: resolution.skipped ?? [],
        });
        await this.checkpointDiagnostics();
        attempt = 1;
      }
    }
  }

  private toolResultFailed(result: string): boolean {
    return /^(?:Tool error:|Tool execution blocked by crash recovery:|Unknown tool:|Exit code: (?!0\b)|Process timed out|Command timed out|Verification (?:timed out|unavailable|failed))/i.test(result);
  }

  private async checkpointDiagnostics(): Promise<void> {
    if (this.sessionPath && this.taskDiagnostics) await this.log(this.sessionPath, { type: "diagnostics", snapshot: this.taskDiagnostics.snapshot() });
  }

  private async log(file: string, value: unknown): Promise<void> {
    const activeSecrets = [
      this.config.apiKey,
      readEnvironmentCredential(this.config.apiKeyEnv),
    ].filter((item): item is string => Boolean(item));
    const event = sanitizeSecrets({ timestamp: new Date().toISOString(), ...value as object }, activeSecrets);
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  }
}
