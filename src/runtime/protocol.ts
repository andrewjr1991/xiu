import type { WorkspaceChangeNotice } from "../change-summary.js";
import type { TaskPlan } from "../plan.js";
import type { ApprovalRequest, ToolResult } from "../types.js";

export const XIU_RUNTIME_SCHEMA_VERSION = 1 as const;

export type RuntimeTaskState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "stopping"
  | "completed"
  | "unverified"
  | "failed"
  | "cancelled"
  | "paused"
  | "recoverable";

export interface RuntimeApprovalSnapshot {
  id: string;
  description: string;
  risk: ApprovalRequest["risk"];
  preview?: string;
  sessionScope?: string;
  scope: "once";
  effects: string[];
  recovery: string;
  requestedAt: string;
}

export interface RuntimeRecoverySnapshot {
  runId: string;
  status: "paused" | "recoverable";
  interruptedOperations: number;
  unknownSideEffects: number;
  recommendation: string;
}

export interface RuntimeTaskSnapshot {
  subagents?: RuntimeSubagentCard[];
  id: string;
  state: RuntimeTaskState;
  taskPreview: string;
  startedAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  plan?: TaskPlan;
  pendingApproval?: RuntimeApprovalSnapshot;
  recovery?: RuntimeRecoverySnapshot;
}

export interface XiuRuntimeSnapshot {
  schemaVersion: typeof XIU_RUNTIME_SCHEMA_VERSION;
  sequence: number;
  generatedAt: string;
  /** Current execution policy; older snapshots default to execution mode. */
  planMode?: boolean;
  task?: RuntimeTaskSnapshot;
}

export interface RuntimeEventPayloads {
  "subagent.updated": { agent: RuntimeSubagentCard };
  "task.started": { taskPreview: string; resumedFrom?: string };
  "task.state": { state: RuntimeTaskState; reason?: string };
  "task.steered": { text: string };
  "task.finished": { state: Exclude<RuntimeTaskState, "idle" | "running" | "waiting_approval" | "stopping" | "recoverable">; result?: string; error?: string };
  "assistant.message": { text: string; hasToolCalls: boolean };
  "assistant.draft": { text: string; receivedChars: number };
  "assistant.stream-end": Record<string, never>;
  "model.started": { turn: number };
  "model.finished": Record<string, never>;
  "tool.started": { name: string; description: string; changesWorkspace: boolean; verification: boolean; risk: ApprovalRequest["risk"] | "read" };
  "tool.progress": { name: string; message: string };
  "tool.finished": { name: string; summary: string; result?: ToolResult; verification: boolean };
  "plan.updated": { plan: TaskPlan };
  "workspace.changed": { change: WorkspaceChangeNotice };
  "approval.requested": { approval: RuntimeApprovalSnapshot };
  "approval.decided": { approvalId: string; allowed: boolean; source: "command" | "handler" | "handler-error" };
  "recovery.detected": { recovery: RuntimeRecoverySnapshot };
  "runtime.notice": { kind: "checkpoint" | "completion-gate" | "failure"; message: string };
}

export type RuntimeEventType = keyof RuntimeEventPayloads;

export interface RuntimeSubagentCard {
  id: string; runId: string; title: string; role: string; status: string;
  taskId?: string; mode?: "shared_readonly" | "worktree"; dependencies?: string[]; createdAt?: string;
  startedAt?: string; completedAt?: string; durationMs?: number;
  progress?: string; result?: string; error?: string;
}

export type RuntimeEvent<K extends RuntimeEventType = RuntimeEventType> = {
  [P in K]: {
    schemaVersion: typeof XIU_RUNTIME_SCHEMA_VERSION;
    eventId: string;
    taskId: string;
    sequence: number;
    timestamp: string;
    type: P;
    payload: RuntimeEventPayloads[P];
  }
}[K];

export type RuntimeCommand =
  | { type: "task.create"; task: string }
  | { type: "task.steer"; text: string }
  | { type: "task.stop" }
  | { type: "plan.mode.set"; enabled: boolean }
  | { type: "approval.decide"; approvalId: string; allowed: boolean; rememberForSession?: true; confirmedRisk?: "dangerous" };

export interface RuntimeConnection {
  snapshot: XiuRuntimeSnapshot;
  events: RuntimeEvent[];
  resyncRequired: boolean;
}

/**
 * Pure renderer-side reducer. Duplicate events are ignored; gaps fail closed so
 * callers can request a fresh snapshot instead of inventing missing state.
 */
export function applyRuntimeEvent(snapshot: XiuRuntimeSnapshot, event: RuntimeEvent): XiuRuntimeSnapshot {
  if (event.schemaVersion !== XIU_RUNTIME_SCHEMA_VERSION) throw new Error("Unsupported Xiu runtime event schema.");
  if (event.sequence <= snapshot.sequence) return snapshot;
  if (event.sequence !== snapshot.sequence + 1) throw new Error(`Runtime event gap: expected ${snapshot.sequence + 1}, received ${event.sequence}.`);
  if (snapshot.task && snapshot.task.id !== event.taskId) {
    const previousTerminal = !["running", "waiting_approval", "stopping"].includes(snapshot.task.state);
    if (event.type !== "task.started" || !previousTerminal) throw new Error("Runtime event belongs to another task; request a fresh snapshot.");
    return {
      schemaVersion: XIU_RUNTIME_SCHEMA_VERSION,
      sequence: event.sequence,
      generatedAt: event.timestamp,
      ...(snapshot.planMode !== undefined ? { planMode: snapshot.planMode } : {}),
      task: {
        id: event.taskId,
        state: "running",
        taskPreview: event.payload.taskPreview,
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
      },
    };
  }

  const next = structuredClone(snapshot);
  next.sequence = event.sequence;
  next.generatedAt = event.timestamp;
  if (!next.task) {
    if (event.type === "task.started") {
      next.task = {
        id: event.taskId,
        state: "running",
        taskPreview: event.payload.taskPreview,
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
      };
    } else if (event.type === "recovery.detected") {
      next.task = {
        id: event.taskId,
        state: "recoverable",
        taskPreview: "Interrupted task",
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
        recovery: structuredClone(event.payload.recovery),
      };
    } else {
      throw new Error("Runtime task snapshot is missing; request a fresh snapshot.");
    }
    return next;
  }

  next.task.updatedAt = event.timestamp;
  switch (event.type) {
    case "subagent.updated":
      next.task.subagents = [...(next.task.subagents ?? []).filter((agent) => agent.id !== event.payload.agent.id), event.payload.agent].slice(-80);
      break;
    case "task.started":
      next.task.state = "running";
      next.task.taskPreview = event.payload.taskPreview;
      next.task.startedAt = event.timestamp;
      next.task.recovery = undefined;
      break;
    case "task.state":
      next.task.state = event.payload.state;
      break;
    case "task.finished":
      next.task.state = event.payload.state;
      next.task.result = event.payload.result;
      next.task.error = event.payload.error;
      next.task.pendingApproval = undefined;
      break;
    case "plan.updated":
      next.task.plan = structuredClone(event.payload.plan);
      break;
    case "approval.requested":
      next.task.state = "waiting_approval";
      next.task.pendingApproval = structuredClone(event.payload.approval);
      break;
    case "approval.decided":
      next.task.pendingApproval = undefined;
      next.task.state = "running";
      break;
    case "recovery.detected":
      next.task.state = "recoverable";
      next.task.recovery = structuredClone(event.payload.recovery);
      break;
  }
  return next;
}
