import { randomUUID } from "node:crypto";
import type { AgentEvents, AgentRunOutcome, AgentFailureReason } from "../agent.js";
import { redactSecrets, sanitizeSecrets } from "../secret-redaction.js";
import type { ApprovalRequest, ToolResult } from "../types.js";
import {
  XIU_RUNTIME_SCHEMA_VERSION,
  type RuntimeApprovalSnapshot,
  type RuntimeConnection,
  type RuntimeEvent,
  type RuntimeEventPayloads,
  type RuntimeEventType,
  type RuntimeRecoverySnapshot,
  type RuntimeTaskSnapshot,
  type RuntimeTaskState,
  type XiuRuntimeSnapshot,
} from "./protocol.js";

const MAX_EVENTS = 1_000;
const MAX_TASK_TEXT = 4_000;
const MAX_MESSAGE_TEXT = 256_000;
const MAX_TOOL_TEXT = 16_000;
const MAX_DRAFT_TEXT = 16_000;

export interface RuntimeTaskDriver {
  run(task: string): Promise<string>;
  cancel(): boolean;
  steer(text: string): boolean;
  status(): { outcome: AgentRunOutcome; planMode?: boolean; failureReason?: AgentFailureReason };
  setPlanMode?(enabled: boolean): Promise<void>;
}

export interface XiuRuntimeOptions {
  now?: () => Date;
  sanitize?: (value: string) => string;
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;
}

type RuntimeListener = (event: RuntimeEvent) => void;

interface PendingApproval {
  snapshot: RuntimeApprovalSnapshot;
  request: ApprovalRequest;
  resolve: (allowed: boolean) => void;
  reject: (error: unknown) => void;
}

function terminalState(outcome: AgentRunOutcome): Exclude<RuntimeTaskState, "idle" | "running" | "waiting_approval" | "stopping" | "recoverable"> {
  if (outcome === "completed") return "completed";
  if (outcome === "unverified") return "unverified";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "paused") return "paused";
  return "failed";
}

function approvalEffects(risk: ApprovalRequest["risk"]): string[] {
  if (risk === "write") return ["可能修改可信工作区中的文件"];
  if (risk === "execute") return ["将在本机启动进程", "命令可能修改工作区或产生外部副作用"];
  return ["操作可能不可逆", "可能影响工作区外的数据或外部系统"];
}

function approvalRecovery(risk: ApprovalRequest["risk"]): string {
  return risk === "write"
    ? "文件工具通常会先创建恢复点；仍请在执行后审查变更。"
    : "进程、网络和外部系统副作用可能无法由 Xiu 自动恢复。";
}

function boundedToolResult(result: ToolResult, clean: (value: string, maximum: number) => string): ToolResult {
  return sanitizeSecrets({
    ...result,
    output: clean(result.output, MAX_TOOL_TEXT),
  });
}

export class XiuRuntime {
  recordSubagent(agent: import("./protocol.js").RuntimeSubagentCard): void {
    if (!this.task) return;
    const safe = sanitizeSecrets({ ...agent, title: this.clean(agent.title, 240), progress: agent.progress ? this.clean(agent.progress, 2_000) : undefined, result: agent.result ? this.clean(agent.result, 16_000) : undefined, error: agent.error ? this.clean(agent.error, 2_000) : undefined });
    this.task.subagents = [...(this.task.subagents ?? []).filter((item) => item.id !== safe.id), safe].slice(-80);
    this.emit("subagent.updated", { agent: safe });
  }
  private driver?: RuntimeTaskDriver;
  private changingPlanMode = false;
  private sequence = 0;
  private task?: RuntimeTaskSnapshot;
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<RuntimeListener>();
  private pendingApproval?: PendingApproval;
  private readonly sessionApprovalScopes = new Set<string>();
  private lastDraftAt = 0;
  private lastDraftChars = 0;
  private readonly now: () => Date;
  private readonly sanitizeText: (value: string) => string;

  constructor(private readonly options: XiuRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sanitizeText = options.sanitize ?? ((value) => redactSecrets(value));
  }

  attachDriver(driver: RuntimeTaskDriver): void {
    if (this.driver && this.driver !== driver) throw new Error("XiuRuntime already has a task driver.");
    this.driver = driver;
  }

  snapshot(): XiuRuntimeSnapshot {
    return sanitizeSecrets({
      schemaVersion: XIU_RUNTIME_SCHEMA_VERSION,
      sequence: this.sequence,
      generatedAt: this.timestamp(),
      planMode: this.driver?.status().planMode ?? false,
      ...(this.task ? { task: structuredClone(this.task) } : {}),
    });
  }

  connect(afterSequence?: number): RuntimeConnection {
    const snapshot = this.snapshot();
    if (afterSequence === undefined) return { snapshot, events: [], resyncRequired: false };
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.sequence) {
      return { snapshot, events: [], resyncRequired: true };
    }
    if (afterSequence === this.sequence) return { snapshot, events: [], resyncRequired: false };
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    if (afterSequence + 1 < first) return { snapshot, events: this.events.map((event) => structuredClone(event)), resyncRequired: true };
    return {
      snapshot,
      events: this.events.filter((event) => event.sequence > afterSequence).map((event) => structuredClone(event)),
      resyncRequired: false,
    };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resetConversation(history: RuntimeEvent[] = []): void {
    if (this.changingPlanMode || (this.task && ["running", "waiting_approval", "stopping"].includes(this.task.state))) {
      throw new Error("Cannot reset the conversation while a task is active.");
    }
    this.task = undefined;
    this.pendingApproval = undefined;
    this.sessionApprovalScopes.clear();
    this.events.length = 0;
    this.sequence = 0;
    // Seed only trusted, already-redacted history. Do not replay events to
    // subscribers or restore approvals, tasks, grants, or recovery state.
    for (const event of history.slice(-MAX_EVENTS)) this.events.push({ ...event, sequence: ++this.sequence });
    this.lastDraftAt = 0;
    this.lastDraftChars = 0;
  }

  /** The driver owns the same TaskPlanManager used by tool policy and completion gates. */
  async setPlanMode(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Invalid Plan mode.");
    if (this.changingPlanMode || (this.task && ["running", "waiting_approval", "stopping"].includes(this.task.state))) {
      throw new Error("Cannot change Plan mode while a task or mode change is active.");
    }
    const driver = this.requireDriver();
    if (!driver.setPlanMode) throw new Error("Plan mode is unavailable in this runtime.");
    this.changingPlanMode = true;
    try { await driver.setPlanMode(enabled); }
    finally { this.changingPlanMode = false; }
  }

  async createTask(task: string): Promise<string> {
    if (this.changingPlanMode) throw new Error("Wait for the Plan mode change before starting a task.");
    const driver = this.requireDriver();
    const normalized = task.trim();
    if (!normalized) throw new Error("Task must not be empty.");
    if (this.task && ["running", "waiting_approval", "stopping"].includes(this.task.state)) throw new Error("A task is already active.");

    const recovery = this.task?.state === "recoverable" ? this.task.recovery : undefined;
    const taskId = recovery?.runId ?? randomUUID();
    const timestamp = this.timestamp();
    this.task = {
      id: taskId,
      state: "running",
      taskPreview: this.clean(normalized, MAX_TASK_TEXT),
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.lastDraftAt = 0;
    this.lastDraftChars = 0;
    this.emit("task.started", { taskPreview: this.task.taskPreview, ...(recovery ? { resumedFrom: recovery.runId } : {}) });

    try {
      const result = await driver.run(normalized);
      const status = driver.status();
      const state = terminalState(status.outcome);
      const safeResult = this.clean(result, MAX_MESSAGE_TEXT);
      const reasons: Partial<Record<AgentFailureReason, string>> = {
        verification_failed: "尚有必需校验失败或在文件变更后失效；模型的完成声明不等于全部验证已通过。请继续补齐完成检查中列出的校验。",
        plan_incomplete: "任务计划仍有未完成步骤；模型的完成声明未通过程序检查。",
        tool_failed: "最后一次工具操作未成功；请检查运行提醒后继续。",
      };
      const error = state === "failed" && status.failureReason ? reasons[status.failureReason] : undefined;
      this.finish(state, { result: safeResult, ...(error ? { error } : {}) });
      return result;
    } catch (error) {
      const state = terminalState(driver.status().outcome);
      const message = this.clean(error instanceof Error ? error.message : String(error), MAX_TOOL_TEXT);
      this.finish(state, { error: message });
      throw error;
    }
  }

  steerTask(text: string): boolean {
    const normalized = text.trim();
    if (!normalized || !this.task || this.task.state !== "running") return false;
    if (!this.requireDriver().steer(normalized)) return false;
    this.emit("task.steered", { text: this.clean(normalized, MAX_TASK_TEXT) });
    return true;
  }

  stopTask(): boolean {
    if (!this.task || !["running", "waiting_approval"].includes(this.task.state)) return false;
    if (this.pendingApproval) this.decideApproval(this.pendingApproval.snapshot.id, false);
    const cancelled = this.requireDriver().cancel();
    if (!cancelled) return false;
    this.setState("stopping");
    return true;
  }

  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (!this.task || this.task.state !== "running") throw new Error("Approval requested without an active task.");
    if (this.pendingApproval) throw new Error("Another approval is already pending.");
    if (request.sessionScope && this.sessionApprovalScopes.has(request.sessionScope) && request.risk !== "dangerous") {
      request.decisionSource = "remembered";
      this.notice("checkpoint", `已按本次会话记住的精确权限自动允许：${request.description}`);
      return true;
    }
    request.decisionSource ??= "prompted";
    const approval: RuntimeApprovalSnapshot = {
      id: randomUUID(),
      description: this.clean(request.description, 2_000),
      risk: request.risk,
      ...(request.preview ? { preview: this.clean(request.preview, MAX_TOOL_TEXT) } : {}),
      ...(request.sessionScope ? { sessionScope: this.clean(request.sessionScope, 200) } : {}),
      scope: "once",
      effects: approvalEffects(request.risk),
      recovery: approvalRecovery(request.risk),
      requestedAt: this.timestamp(),
    };
    const promise = new Promise<boolean>((resolve, reject) => {
      this.pendingApproval = { snapshot: approval, request, resolve, reject };
    });
    this.task.pendingApproval = approval;
    this.task.state = "waiting_approval";
    this.task.updatedAt = this.timestamp();
    this.emit("approval.requested", { approval });

    if (this.options.approvalHandler) {
      void this.options.approvalHandler(request).then(
        (allowed) => {
          if (this.pendingApproval?.snapshot.id === approval.id) this.resolveApproval(approval.id, allowed, "handler");
        },
        (error) => this.rejectApproval(approval.id, error),
      );
    }
    return promise;
  }

  decideApproval(approvalId: string, allowed: boolean, confirmedRisk?: "dangerous", rememberForSession?: true): void {
    if (allowed && this.pendingApproval?.snapshot.risk === "dangerous" && confirmedRisk !== "dangerous") {
      throw new Error("Dangerous approval requires explicit risk confirmation.");
    }
    if (rememberForSession) {
      const pending = this.pendingApproval?.snapshot;
      if (!allowed || !pending?.sessionScope || pending.risk === "dangerous") {
        throw new Error("Session approval requires an allowed, non-dangerous, explicitly scoped operation.");
      }
      this.sessionApprovalScopes.add(pending.sessionScope);
    }
    this.resolveApproval(approvalId, allowed, "command");
  }

  recordRecovery(recovery: RuntimeRecoverySnapshot): void {
    if (recovery.unknownSideEffects < 0 || recovery.interruptedOperations < recovery.unknownSideEffects) throw new Error("Invalid recovery snapshot.");
    const timestamp = this.timestamp();
    this.task = {
      id: recovery.runId,
      state: "recoverable",
      taskPreview: "Interrupted task",
      startedAt: timestamp,
      updatedAt: timestamp,
      recovery: structuredClone(recovery),
    };
    this.emit("recovery.detected", { recovery });
  }

  assertRecoveryConfirmed(recoveryId: string, unknownSideEffectsConfirmed: boolean): void {
    const recovery = this.task?.recovery;
    if (!recovery || recovery.runId !== recoveryId) throw new Error("Recovery record is unavailable or stale.");
    if (recovery.unknownSideEffects > 0 && !unknownSideEffectsConfirmed) {
      throw new Error("Unknown side effects must be verified or explicitly acknowledged before recovery.");
    }
  }

  abandonRecovery(recoveryId: string): void {
    const recovery = this.task?.recovery;
    if (!recovery || recovery.runId !== recoveryId) throw new Error("Recovery record is unavailable or stale.");
    this.finish("cancelled", { result: "旧任务已放弃；没有重放任何操作。" });
  }

  agentEvents(existing: AgentEvents = {}): AgentEvents {
    return {
      ...existing,
      onModelStart: (turn) => { existing.onModelStart?.(turn); this.emitIfActive("model.started", { turn }); },
      onModelProgress: (() => {
        let last = 0;
        return (progress) => {
          existing.onModelProgress?.(progress);
          const now = this.now().getTime();
          if (now - last >= 5_000) {
            last = now;
            const counters = Object.fromEntries(Object.entries(progress ?? {}).filter(([key, value]) => ["chunks", "textCharacters", "argumentCharacters"].includes(key) && Number.isSafeInteger(value) && value >= 0));
            this.emitIfActive("model.progress", counters);
          }
        };
      })(),
      onModelEnd: (responseReceived) => { existing.onModelEnd?.(responseReceived); this.emitIfActive("model.finished", { responseReceived }); },
      onAssistantTurn: (text, hasToolCalls) => {
        existing.onAssistantTurn?.(text, hasToolCalls);
        this.emitIfActive("assistant.message", { text: this.clean(text, MAX_MESSAGE_TEXT), hasToolCalls });
      },
      onDraftPreview: (text, receivedChars) => {
        existing.onDraftPreview?.(text, receivedChars);
        const now = this.now().getTime();
        if (this.lastDraftChars === 0 || receivedChars - this.lastDraftChars >= 512 || now - this.lastDraftAt >= 100) {
          this.lastDraftAt = now;
          this.lastDraftChars = receivedChars;
          this.emitIfActive("assistant.draft", { text: this.cleanTail(text, MAX_DRAFT_TEXT), receivedChars });
        }
      },
      onTextStreamEnd: () => {
        existing.onTextStreamEnd?.();
        this.lastDraftAt = 0;
        this.lastDraftChars = 0;
        this.emitIfActive("assistant.stream-end", {});
      },
      onToolStart: (name, description, details) => {
        existing.onToolStart?.(name, description, details);
        this.emitIfActive("tool.started", { name, description: this.clean(description, 2_000), ...details });
      },
      onToolProgress: (name, message) => {
        existing.onToolProgress?.(name, message);
        this.emitIfActive("tool.progress", { name, message: this.clean(message, 4_000) });
      },
      onToolEnd: (name, result, details) => {
        existing.onToolEnd?.(name, result, details);
        this.emitIfActive("tool.finished", {
          name,
          summary: this.clean(result, MAX_TOOL_TEXT),
          ...(details ? { result: boundedToolResult(details.result, (value, maximum) => this.clean(value, maximum)), verification: details.verification } : { verification: false }),
        });
      },
      onPlanUpdate: (plan) => {
        existing.onPlanUpdate?.(plan);
        if (this.task) this.task.plan = sanitizeSecrets(structuredClone(plan));
        this.emitIfActive("plan.updated", { plan: sanitizeSecrets(structuredClone(plan)) });
      },
      onWorkspaceChange: (change) => {
        existing.onWorkspaceChange?.(change);
        this.emitIfActive("workspace.changed", { change: sanitizeSecrets(structuredClone(change)) });
      },
      onCheckpoint: (message) => { existing.onCheckpoint?.(message); this.notice("checkpoint", message); },
      onCompletionGate: (message) => { existing.onCompletionGate?.(message); this.notice("completion-gate", message); },
      onFailure: (message) => { existing.onFailure?.(message); this.notice("failure", message); },
    };
  }

  private finish(state: Exclude<RuntimeTaskState, "idle" | "running" | "waiting_approval" | "stopping" | "recoverable">, details: { result?: string; error?: string }): void {
    if (!this.task) return;
    this.task.state = state;
    this.task.updatedAt = this.timestamp();
    this.task.result = details.result;
    this.task.error = details.error;
    this.task.pendingApproval = undefined;
    this.pendingApproval = undefined;
    this.emit("task.finished", { state, ...details });
  }

  private setState(state: RuntimeTaskState, reason?: string): void {
    if (!this.task) return;
    this.task.state = state;
    this.task.updatedAt = this.timestamp();
    this.emit("task.state", { state, ...(reason ? { reason: this.clean(reason, 2_000) } : {}) });
  }

  private resolveApproval(id: string, allowed: boolean, source: "command" | "handler"): void {
    const pending = this.pendingApproval;
    if (!pending || pending.snapshot.id !== id) throw new Error("Approval is unavailable or stale.");
    this.pendingApproval = undefined;
    if (this.task) {
      this.task.pendingApproval = undefined;
      this.task.state = "running";
      this.task.updatedAt = this.timestamp();
    }
    this.emit("approval.decided", { approvalId: id, allowed, source });
    pending.resolve(allowed);
  }

  private rejectApproval(id: string, error: unknown): void {
    const pending = this.pendingApproval;
    if (!pending || pending.snapshot.id !== id) return;
    this.pendingApproval = undefined;
    if (this.task) {
      this.task.pendingApproval = undefined;
      this.task.state = "running";
      this.task.updatedAt = this.timestamp();
    }
    this.emit("approval.decided", { approvalId: id, allowed: false, source: "handler-error" });
    pending.reject(error);
  }

  private notice(kind: "checkpoint" | "completion-gate" | "failure", message: string): void {
    this.emitIfActive("runtime.notice", { kind, message: this.clean(message, 4_000) });
  }

  private emitIfActive<K extends RuntimeEventType>(type: K, payload: RuntimeEventPayloads[K]): void {
    if (this.task && ["running", "waiting_approval", "stopping"].includes(this.task.state)) this.emit(type, payload);
  }

  private emit<K extends RuntimeEventType>(type: K, payload: RuntimeEventPayloads[K]): void {
    if (!this.task) throw new Error("Cannot emit a task event without a task.");
    const event = {
      schemaVersion: XIU_RUNTIME_SCHEMA_VERSION,
      eventId: randomUUID(),
      taskId: this.task.id,
      sequence: ++this.sequence,
      timestamp: this.timestamp(),
      type,
      payload: sanitizeSecrets(payload),
    } as RuntimeEvent<K>;
    this.events.push(event as RuntimeEvent);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const listener of this.listeners) {
      try { listener(structuredClone(event as RuntimeEvent)); }
      catch { this.listeners.delete(listener); }
    }
  }

  private requireDriver(): RuntimeTaskDriver {
    if (!this.driver) throw new Error("XiuRuntime task driver is not attached.");
    return this.driver;
  }

  private clean(value: string, maximum: number): string {
    const sanitized = this.sanitizeText(value);
    return [...sanitized].slice(0, maximum).join("");
  }

  private cleanTail(value: string, maximum: number): string {
    const sanitized = this.sanitizeText(value);
    return [...sanitized].slice(-maximum).join("");
  }

  private timestamp(): string { return this.now().toISOString(); }
}
