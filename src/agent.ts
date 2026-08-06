import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import type { ProjectIndex } from "./project-index.js";
import type { TaskPlan, TaskPlanManager } from "./plan.js";
import type { CheckpointManager } from "./checkpoint.js";
import { selectableModels } from "./model-catalog.js";
import { ToolLoopGuard, toolCallSignature } from "./loop-guard.js";
import type { AvailableModel } from "./types.js";
import type { SkillRegistry } from "./skills.js";
import { emptySessionStats, estimateConversationTokens, type RestoredSession, type SessionStats } from "./session.js";
import { executeTool, looksLikeVerification } from "./tools.js";
import type { AgentTool, ApprovalRequest, ConversationMessage, ModelProvider } from "./types.js";

export interface AgentEvents {
  onModelStart?: (turn: number) => void;
  onModelEnd?: () => void;
  onText?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onTextStreamEnd?: () => void;
  onToolStart?: (name: string, description: string, details: { changesWorkspace: boolean; verification: boolean }) => void;
  onToolProgress?: (name: string, message: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onCompletionGate?: (message: string) => void;
  onCompaction?: (message: string) => void;
  onRetry?: (message: string) => void;
  onFailure?: (message: string) => void;
  onPlanUpdate?: (plan: TaskPlan) => void;
  onWorkspaceChange?: (change: { tool: string; paths: string[]; description: string }) => void;
  onCheckpoint?: (message: string) => void;
  onTaskComplete?: (summary: { turns: number; toolCalls: number; changed: boolean; verified: boolean; outcome: "completed" | "unverified"; durationMs: number }) => void;
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
  ) {
    if (restored) {
      this.messages = restored.messages;
      this.sessionPath = restored.file;
      this.sessionId = restored.id;
      this.stats = restored.stats;
      if (restored.model) this.setModelInMemory(restored.model);
      this.planManager?.restore(restored.plan, restored.planMode);
      this.checkpointManager?.setSession(restored.id);
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
    try {
      return await this.runWithSignal(task, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        this.lastRunOutcome = "cancelled";
        throw new Error("Task cancelled.");
      }
      this.lastRunOutcome = "failed";
      throw error;
    } finally {
      this.stats.activeMs += Date.now() - startedAt;
      this.stats.estimatedTokens = estimateConversationTokens(this.messages);
      if (this.sessionPath) await this.log(this.sessionPath, { type: "stats", stats: this.stats });
      if (this.activeController === controller) this.activeController = undefined;
      this.pendingSteering = [];
      this.primaryTask = undefined;
      this.steeringHistory = [];
    }
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
  }

  private async runWithSignal(task: string, signal: AbortSignal): Promise<string> {
    const startedAt = Date.now();
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
    this.system ??= await buildSystemPrompt(this.config.cwd, this.skillRegistry?.catalog());
    if (!this.sessionPath) {
      this.sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const namespace = this.config.sessionNamespace ?? "sessions";
      if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid session namespace.");
      this.sessionPath = path.join(this.config.cwd, ".xiu", namespace, `${this.sessionId}.jsonl`);
    }
    this.checkpointManager?.setSession(this.sessionId!);
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    await this.log(this.sessionPath, {
      type: "task",
      task,
      contextualTask,
      config: {
        ...this.config,
        baseURL: this.config.baseURL ? "configured" : undefined,
        proxy: this.config.proxy ? "configured" : undefined,
      },
    });
    if (this.planManager) {
      await this.log(this.sessionPath, { type: "plan_mode", enabled: this.planManager.mode() });
      const existingPlan = this.planManager.snapshot();
      if (existingPlan) await this.log(this.sessionPath, { type: "plan", plan: existingPlan });
    }

    let workspaceChanged = false;
    let verifiedAfterChange = false;
    let verificationAttempted = false;
    let completionReminderSent = false;
    let auditedSteeringCount = 0;
    let planReminderSent = false;
    let toolCallCount = 0;
    const loopGuard = new ToolLoopGuard();
    for (let turn = 1; ; turn++) {
      if (this.config.maxTurns !== undefined && turn > this.config.maxTurns) {
        throw new Error(`Agent reached the user-configured ${this.config.maxTurns}-turn limit before completing the task.`);
      }
      this.currentTurn = turn;
      if (signal.aborted) throw new Error("Task cancelled.");
      await this.applyPendingSteering(turn);
      if (estimateConversationTokens(this.messages) >= (this.config.contextLimit ?? 60_000)) {
        await this.compactWithSignal(signal, "automatic context limit");
        loopGuard.reset();
      }
      this.events.onModelStart?.(turn);
      let response;
      let streamed = false;
      try {
        const requested = await this.requestModel(signal);
        response = requested.response;
        streamed = requested.streamed;
      } finally {
        this.events.onModelEnd?.();
      }
      this.recordUsage(response.usage, response.text);
      if (response.text && !streamed) this.events.onText?.(response.text);
      if (streamed && response.text) this.events.onTextStreamEnd?.();
      this.messages.push({ role: "assistant", content: response.text, raw: response.raw, toolCalls: response.toolCalls });
      await this.log(this.sessionPath, { type: "assistant", turn, text: response.text, raw: response.raw, toolCalls: response.toolCalls, usage: response.usage });

      if (response.toolCalls.length === 0) {
        if (await this.applyPendingSteering(turn)) continue;
        const unfinishedPlan = this.planManager?.snapshot()?.steps.some((step) => step.status === "pending" || step.status === "in_progress");
        if (unfinishedPlan && !this.planManager?.mode() && !planReminderSent) {
          const reminder = "Plan gate: the visible task plan still has pending or in-progress steps. Complete the work or update blocked steps with an explanation before finishing.";
          this.messages.push({ role: "user", content: reminder });
          await this.log(this.sessionPath, { type: "plan_gate", turn, message: reminder });
          this.events.onCompletionGate?.(reminder);
          planReminderSent = true;
          continue;
        }
        if (this.steeringHistory.length > auditedSteeringCount) {
          const gate = `Task-contract completion audit: do not finish merely because you answered the latest steering. Re-check every required outcome below against concrete evidence. If any item is incomplete, continue using tools now. Only finish after the PRIMARY GOAL and all ADDITIONAL REQUIREMENTS are complete.\n\nPRIMARY GOAL (still mandatory):\n${this.primaryTask}\n\nADDITIONAL REQUIREMENTS:\n${this.steeringHistory.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
          this.messages.push({ role: "user", content: gate });
          await this.log(this.sessionPath, { type: "task_contract_gate", turn, message: gate });
          this.events.onCompletionGate?.(gate);
          auditedSteeringCount = this.steeringHistory.length;
          continue;
        }
        if (workspaceChanged && !verifiedAfterChange && !completionReminderSent) {
          const gate = `Completion gate: files changed but no verification has passed${verificationAttempted ? "; the attempted check failed or was unavailable" : ""}. Run a relevant test, typecheck, lint, build, or explicit output validation now. If verification remains impossible, report the limitation; Xiu will mark the task unverified rather than successful.`;
          this.messages.push({ role: "user", content: gate });
          await this.log(this.sessionPath, { type: "completion_gate", turn, message: gate });
          this.events.onCompletionGate?.(gate);
          completionReminderSent = true;
          continue;
        }
        const outcome = workspaceChanged && !verifiedAfterChange ? "unverified" : "completed";
        this.lastRunOutcome = outcome;
        this.events.onTaskComplete?.({
          turns: turn,
          toolCalls: toolCallCount,
          changed: workspaceChanged,
          verified: verifiedAfterChange,
          outcome,
          durationMs: Date.now() - startedAt,
        });
        return response.text;
      }

      for (const call of response.toolCalls) {
        toolCallCount++;
        this.stats.toolCalls++;
        const tool = this.tools.find((candidate) => candidate.name === call.name);
        let result: string;
        let abortForLoop = false;
        if (!tool) {
          result = `Unknown tool: ${call.name}`;
        } else {
          const description = tool.describe(call.input);
          const risk = typeof tool.risk === "function" ? tool.risk(call.input) : tool.risk;
          const changesWorkspace = typeof tool.changesWorkspace === "function"
            ? tool.changesWorkspace(call.input)
            : tool.changesWorkspace;
          this.events.onToolStart?.(call.name, description, {
            changesWorkspace: Boolean(changesWorkspace),
            verification: this.isVerificationAttempt(call.name, call.input),
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
          } else {
            result = await executeTool(tool, call.input, {
              cwd: this.config.cwd,
              approve: async (request) => {
                const approved = await this.approve(request);
                if (approved && changesWorkspace) {
                  const checkpoint = await this.checkpointManager?.capture(call.name, call.input, tool.describe(call.input));
                  if (checkpoint) {
                    await this.log(this.sessionPath!, { type: "checkpoint", checkpoint });
                    this.events.onCheckpoint?.(`Checkpoint ${checkpoint.id} saved for ${checkpoint.files.map((file) => file.path).join(", ")}`);
                  }
                }
                return approved;
              },
              signal,
              reportProgress: (message) => this.events.onToolProgress?.(call.name, message),
            });
          }
          this.events.onToolEnd?.(call.name, result);
          if (/^(Tool error:|Exit code: (?!0\b)|Command timed out|Verification timed out|Verification unavailable)/i.test(result)) {
            this.repeatedFailures.set(failureKey, (this.repeatedFailures.get(failureKey) ?? 0) + 1);
            this.events.onFailure?.(`${call.name}: ${result.split(/\r?\n/, 1)[0]}`);
          } else this.repeatedFailures.delete(failureKey);
          if (call.name === "update_task_plan" && !/^Tool error:/.test(result)) {
            const plan = this.planManager?.snapshot();
            if (plan) await this.log(this.sessionPath, { type: "plan", plan });
            if (plan) this.events.onPlanUpdate?.(plan);
          }
          if (changesWorkspace && !/^Tool (error|execution denied)/.test(result)) {
            workspaceChanged = true;
            verifiedAfterChange = false;
            loopGuard.reset();
            this.projectIndex?.invalidate();
            const paths = this.workspacePaths(call.input);
            if (paths.length) this.events.onWorkspaceChange?.({ tool: call.name, paths, description });
          }
          if (tool.isVerification?.(call.input, result)) verifiedAfterChange = true;
          if (tool.isVerification?.(call.input, result) || this.isVerificationAttempt(call.name, call.input)) verificationAttempted = true;
        }
        this.recordToolEvidence(call.name, call.input, result);
        const contextResult = this.boundToolContext(result);
        this.messages.push({ role: "tool", content: contextResult, toolCallId: call.id, toolName: call.name });
        await this.log(this.sessionPath, {
          type: "tool",
          turn,
          id: call.id,
          name: call.name,
          input: call.input,
          result,
          ...(contextResult === result ? {} : { contextResult }),
        });
        if (abortForLoop) throw new Error("Agent stopped after repeatedly revisiting the same tool calls without making progress.");
      }
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
    this.planManager?.restore(undefined, false);
    this.checkpointManager?.clearSession();
  }

  async compact(): Promise<string> {
    if (!this.messages.length) return "No conversation context to compact.";
    const controller = new AbortController();
    this.activeController = controller;
    try { return await this.compactWithSignal(controller.signal, "manual request"); }
    finally { if (this.activeController === controller) this.activeController = undefined; }
  }

  history(limit = 20): string {
    const visible = this.messages.filter((message) => message.role !== "tool").slice(-limit);
    if (!visible.length) return "No conversation history.";
    return visible.map((message) => {
      const content = message.content.replace(/\s+/g, " ").trim();
      return `${message.role}: ${content.length > 240 ? `${content.slice(0, 240)}...` : content}`;
    }).join("\n");
  }

  status(): { sessionId?: string; model: string; messages: number; stats: SessionStats; contextLimit: number; index?: ReturnType<ProjectIndex["status"]>; planMode: boolean; outcome: AgentRunOutcome; turn: number; maxTurns?: number; pendingSteering: number } {
    return {
      sessionId: this.sessionId,
      model: this.config.model,
      messages: this.messages.length,
      stats: { ...this.stats, estimatedTokens: estimateConversationTokens(this.messages) },
      contextLimit: this.config.contextLimit ?? 60_000,
      index: this.projectIndex?.status(),
      planMode: this.planManager?.mode() ?? false,
      outcome: this.lastRunOutcome,
      turn: this.currentTurn,
      maxTurns: this.config.maxTurns,
      pendingSteering: this.pendingSteering.length,
    };
  }

  async setModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) throw new Error("Model name cannot be empty.");
    this.setModelInMemory(trimmed);
    if (this.sessionPath) await this.log(this.sessionPath, { type: "model_changed", model: trimmed });
  }

  async listModels(): Promise<{ models: AvailableModel[]; discoveryError?: string }> {
    let discovered: AvailableModel[] = [];
    let discoveryError: string | undefined;
    if (this.provider.listModels) {
      try { discovered = await this.provider.listModels(); }
      catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
    }
    return { models: selectableModels(this.config.provider, this.config.model, discovered), discoveryError };
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
    if (restored.model) this.setModelInMemory(restored.model);
    this.planManager?.restore(restored.plan, restored.planMode);
    this.checkpointManager?.setSession(restored.id);
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    if (!this.planManager) throw new Error("Plan manager is unavailable.");
    this.planManager.setMode(enabled);
    if (this.sessionPath) await this.log(this.sessionPath, { type: "plan_mode", enabled });
  }

  plan(): string {
    return this.planManager?.format() ?? "Plan manager is unavailable.";
  }

  reloadInstructions(): void {
    this.system = undefined;
  }

  private setModelInMemory(model: string): void {
    const previous = this.config.model;
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
    const content = `User steering received while the task was running. It adds requirements but NEVER replaces or lowers the priority of the primary goal. Do not stop after answering only the steering. Continue until both sections are complete.\n\nPRIMARY GOAL (still mandatory):\n${this.primaryTask}\n\nADDITIONAL REQUIREMENTS:\n${this.steeringHistory.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nNEWLY RECEIVED IN THIS TURN:\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
    this.messages.push({ role: "user", content });
    if (this.sessionPath) await this.log(this.sessionPath, { type: "steering", turn, items });
    return true;
  }

  private isVerificationAttempt(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName === "verify_project") return true;
    if (toolName !== "run_command") return false;
    return looksLikeVerification(String(input.command ?? ""));
  }

  private workspacePaths(input: Record<string, unknown>): string[] {
    const values = [input.path, input.output_path, input.destination, input.file];
    if (Array.isArray(input.paths)) values.push(...input.paths);
    return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].slice(0, 6);
  }

  private async compactWithSignal(signal: AbortSignal, reason: string): Promise<string> {
    if (this.messages.length < 2) return "Conversation is already compact.";
    const before = estimateConversationTokens(this.messages);
    this.events.onCompaction?.(`Compacting ${before.toLocaleString()} estimated tokens (${reason})`);
    const primaryGoal = this.primaryTask?.trim() || this.recentUserGoals()[0] || "Continue the most recent user task.";
    const additionalRequirements = this.steeringHistory.length
      ? this.steeringHistory.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "None recorded.";
    const currentPlan = this.planManager?.snapshot() ? this.planManager.format() : "No explicit task plan recorded.";
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
      "TOOL EVIDENCE LEDGER (program-recorded; do not repeat completed calls without a concrete reason):",
      this.formatToolEvidence(),
    ].join("\n");
    const transcript = this.messages.map((message) => {
      const label = message.role === "tool" ? `tool:${message.toolName ?? "unknown"}` : message.role;
      return `[${label}]\n${message.content}`;
    }).join("\n\n");
    let summary: string;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    try {
      const response = await this.provider.complete(
        "You are performing a CONTEXT CHECKPOINT COMPACTION for a coding agent; in other words, you compact coding-agent context. Produce a concise, factual handoff for the next model. Use these headings: Current progress; Completed evidence; Key findings and decisions; Failed approaches (do not repeat); Files and exact commands; Next action; Verification status; Constraints. Never replace or weaken the authoritative task contract. Distinguish completed facts from intended work. Do not call tools or add conversational commentary.",
        [{ role: "user", content: `${taskContract}\n\nFULL TRANSCRIPT TO COMPACT:\n${transcript}` }],
        [],
        signal,
      );
      summary = this.boundCheckpointSummary(response.text);
      usage = response.usage;
      this.recordUsage(response.usage, response.text);
    } catch (error) {
      if (signal.aborted) throw error;
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
    return `Compacted context from about ${before.toLocaleString()} to ${this.stats.estimatedTokens.toLocaleString()} tokens.`;
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

  private async requestModel(signal: AbortSignal): Promise<{ response: Awaited<ReturnType<ModelProvider["complete"]>>; streamed: boolean }> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let emitted = false;
      try {
        if (this.provider.stream && this.events.onTextDelta) {
          const response = await this.provider.stream(this.system!, this.messages, this.tools, (delta) => {
            emitted = true;
            this.events.onTextDelta?.(delta);
          }, signal);
          return { response, streamed: emitted };
        }
        return { response: await this.provider.complete(this.system!, this.messages, this.tools, signal), streamed: false };
      } catch (error) {
        if (signal.aborted || emitted || attempt === maxAttempts || !this.isTransientError(error)) {
          this.events.onFailure?.(`Model request failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        this.events.onRetry?.(`Temporary model error; retrying ${attempt + 1}/${maxAttempts} in ${delayMs}ms`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Task cancelled.")); }, { once: true });
        });
      }
    }
    throw new Error("Model request failed after retries.");
  }

  private isTransientError(error: unknown): boolean {
    const value = error as { status?: number; code?: string; message?: string };
    return value.status === 408 || value.status === 409 || value.status === 429 || (typeof value.status === "number" && value.status >= 500)
      || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|temporar|rate limit/i.test(`${value.code ?? ""} ${value.message ?? ""}`);
  }

  private async log(file: string, value: unknown): Promise<void> {
    await fs.appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value as object })}\n`, "utf8");
  }
}
