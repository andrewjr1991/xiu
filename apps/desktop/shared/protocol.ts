export const DESKTOP_BRIDGE_VERSION = 1 as const;
export { applyRuntimeEvent } from "../../../src/runtime/protocol.js";
export type { RuntimeApprovalSnapshot, RuntimeConnection, RuntimeEvent, RuntimeTaskState, XiuRuntimeSnapshot } from "../../../src/runtime/protocol.js";
export type { ReviewFileEntry, ReviewFilePreview } from "../../../src/runtime/review.js";
import type { RuntimeConnection, RuntimeEvent } from "../../../src/runtime/protocol.js";
import type { TaskChangeReport } from "../../../src/task-changes.js";
import type { ReviewFileEntry, ReviewFilePreview } from "../../../src/runtime/review.js";
export type { WorkspaceMcpSnapshot, WorkspaceMcpDraft, WorkspaceMcpOAuthFlow } from "../../../src/runtime/mcp-service.js";
import type { WorkspaceMcpSnapshot } from "../../../src/runtime/mcp-service.js";
import type { WorkspaceMcpDraft } from "../../../src/runtime/mcp-service.js";
import type { DesktopProviderRecoveryRequest, DesktopProviderRecoverySnapshot } from "./provider-recovery.js";
export type { DesktopProviderRecoveryRequest, DesktopProviderRecoverySnapshot } from "./provider-recovery.js";
export interface DesktopMcpApproveRequest { name: string; fingerprint: string; confirmed: true }
export type DesktopMcpManageRequest =
  | { action: "save"; draft: WorkspaceMcpDraft }
  | { action: "delete" | "logout"; name: string; fingerprint: string; confirmed: true }
  | { action: "login"; name: string; fingerprint: string }
  | { action: "oauth-decision"; flowId: string; allowed: boolean }
  | { action: "oauth-cancel"; flowId: string };
export interface DesktopMcpBrowseRequest { name: string; action: "resources" | "read" | "prompts" | "prompt"; value?: string; args?: Record<string, string> }

export type WorkspaceTrustState = "none" | "required" | "trusted";

export interface DesktopTaskSummary {
  id: string;
  title: string;
  updatedAt: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled" | "unverified" | "abandoned" | "session";
}

export interface DesktopRecentWorkspace {
  id: string;
  name: string;
  trusted: boolean;
  lastOpenedAt: string;
}

export interface DesktopWorkspaceSnapshot {
  bridgeVersion: typeof DESKTOP_BRIDGE_VERSION;
  trust: WorkspaceTrustState;
  workspace?: {
    id: string;
    name: string;
    path?: string;
    lock: "available" | "active-elsewhere" | "recoverable";
  };
  recent: DesktopRecentWorkspace[];
  tasks: DesktopTaskSummary[];
  error?: string;
}

export interface TrustWorkspaceRequest {
  workspaceId: string;
  acknowledged: true;
}

export interface DesktopRuntimeConnection {
  runtime: RuntimeConnection;
  /** Stable conversation/session identity; runtime task ids change on follow-up. */
  conversationId?: string;
  provider: { id: string; label: string; model: string };
  writer: "available" | "active-here" | "active-elsewhere";
  approvalMode?: DesktopApprovalMode;
  /** Opaque host/conversation revision for an idle-only mode change. */
  modeContextId?: string;
}

export type DesktopApprovalMode = "ask" | "workspace" | "full";
export interface DesktopPlanModeRequest { enabled: boolean; contextId: string }
export interface DesktopApprovalModeRequest { mode: DesktopApprovalMode }

export interface DesktopProviderProfile {
  id: string;
  name: string;
  kind: string;
  defaultModel: string;
  selectedModel: string;
  builtin: boolean;
  baseURL?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  credential: {
    source: "environment" | "system" | "legacy-file" | "missing" | "not-required";
    configured: boolean;
    editable: boolean;
  };
  capabilityModels: { vision?: string; image?: string; video?: string; audio?: string };
  features: { tools: boolean; vision: boolean; image: boolean; video: boolean; audio: boolean };
}

export type DesktopProviderKind = "openai" | "anthropic" | "agnes" | "openai-compatible" | "ollama" | "lmstudio" | "vllm";
export interface DesktopProviderUpsertRequest {
  existingId?: string;
  id: string;
  name: string;
  kind: DesktopProviderKind;
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  contextWindow?: number;
  capabilityModels?: { vision?: string; image?: string; video?: string; audio?: string };
  features: { tools: boolean; vision: boolean; image: boolean; video: boolean; audio: boolean };
}
export interface DesktopProviderDeleteRequest { providerId: string; confirmed: true }

export interface DesktopModelOption {
  id: string;
  name?: string;
  description?: string;
  source: "api" | "builtin" | "current";
  contextWindow?: number;
}

export interface DesktopProviderSnapshot {
  templates?: DesktopProviderUpsertRequest[];
  activeProviderId: string;
  activeModel: string;
  profiles: DesktopProviderProfile[];
  models: DesktopModelOption[];
  modelProviderId: string;
  modelsByProvider: Record<string, DesktopModelOption[]>;
  capabilityModelsByProvider: Record<string, {
    vision: DesktopModelOption[];
    image: DesktopModelOption[];
    video: DesktopModelOption[];
    audio: DesktopModelOption[];
  }>;
  discoveryError?: string;
}

export type DesktopProviderCapability = "vision" | "image" | "video" | "audio";
export interface DesktopProviderSelectRequest { providerId: string; model: string; capability?: DesktopProviderCapability }
export interface DesktopProviderModelsRequest { providerId: string }
export interface DesktopProviderCredentialRequest { providerId: string; apiKey: string }
export interface DesktopProviderTestRequest { providerId: string; model?: string }
export interface DesktopProviderTestResult { ok: true; message: string; modelsDiscovered: number }
export interface DesktopProviderMutationResult {
  settings: DesktopProviderSnapshot;
  connection: DesktopRuntimeConnection;
}

export interface RuntimeConnectRequest { afterSequence?: number }
export interface RuntimeTaskRequest { text: string }
export interface DesktopTaskContinueRequest extends RuntimeTaskRequest { taskId: string }
export interface DesktopAttachment {
  reference: string;
  path: string;
  name: string;
  bytes: number;
  kind: "image" | "file";
  previewDataUrl?: string;
}
export interface DesktopAttachmentResult { insertText: string; attachments: DesktopAttachment[]; notice?: string }
export interface DesktopAttachmentUploadRequest { files: Array<{ name: string; data: Uint8Array }> }
export interface RuntimeApprovalDecisionRequest {
  approvalId: string;
  allowed: boolean;
  rememberForSession?: true;
  confirmedRisk?: "dangerous";
}

export interface DesktopTaskHistoryRequest { taskId: string }
export interface DesktopTaskDeleteRequest { taskId: string; confirmed: true }
export interface DesktopTaskHistoryEntry {
  id: string;
  kind: "user" | "assistant" | "activity" | "completion";
  title: string;
  text: string;
}
export interface DesktopTaskHistorySnapshot {
  taskId: string;
  title: string;
  status: DesktopTaskSummary["status"];
  updatedAt: string;
  providerId?: string;
  model?: string;
  entries: DesktopTaskHistoryEntry[];
  events: RuntimeEvent[];
  fidelity: "exact" | "reconstructed";
  changes?: TaskChangeReport;
  changeRounds?: DesktopChangeRound[];
  tools?: DesktopReviewOperation[];
  validations?: DesktopReviewOperation[];
}

export interface DesktopChangeRound { id: string; startedAt: string; report?: TaskChangeReport }

export type DesktopReviewTab = "changes" | "files" | "terminal" | "evidence" | "agents" | "data" | "home" | "web";
export interface DesktopBrowserState { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export type DesktopBrowserRequest = { action: "navigate"; url: string } | { action: "back" | "forward" | "reload" | "close" | "snapshot" } | { action: "layout"; bounds: { x: number; y: number; width: number; height: number }; visible: boolean };
export type DesktopChangeView = "task" | "workspace" | "staged";

export interface DesktopReviewOperation {
  id: string;
  kind: "command" | "verification";
  name: string;
  status: "planned" | "started" | "succeeded" | "failed" | "cancelled" | "unknown";
  sideEffect: "none" | "workspace" | "process" | "external" | "unknown";
  risk?: "read" | "write" | "execute" | "dangerous";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  evidence?: string;
}

export interface DesktopReviewCheckpoint {
  id: string;
  createdAt: string;
  tool: string;
  description: string;
  files: Array<{ path: string; existed: boolean }>;
}

export interface DesktopRecoveryEvidence {
  runId: string;
  taskPreview: string;
  status: "paused" | "recoverable";
  recommendation: string;
  unknownOperations: DesktopReviewOperation[];
  lastRecoveryPoint?: { at: string; kind: string; evidence: string };
}

export interface DesktopReviewSnapshot {
  artifacts?: Array<{ path: string; kind: string }>;
  background?: Array<{ id: string; command: string; state: string; running: boolean; elapsedMs: number; outputBytes: number }>;
  tools?: DesktopReviewOperation[];
  changeRounds?: DesktopChangeRound[];
  generatedAt: string;
  changeView: DesktopChangeView;
  changes: TaskChangeReport;
  files: ReviewFileEntry[];
  commands: DesktopReviewOperation[];
  validations: DesktopReviewOperation[];
  checkpoints: DesktopReviewCheckpoint[];
  run?: { id: string; status: string; startedAt: string; updatedAt: string; finishedAt?: string };
  recovery?: DesktopRecoveryEvidence;
}

export interface DesktopReviewRequest { changeView?: DesktopChangeView }
export interface DesktopFilePreviewRequest { path: string }
export interface DesktopCheckpointRestoreRequest { checkpointId: string }
export interface DesktopRecoveryRequest { runId: string }
export interface DesktopRecoveryAbandonRequest { runId: string }

export type DesktopTerminalState = "idle" | "running" | "exited" | "error";
export interface DesktopTerminalSnapshot {
  state: DesktopTerminalState;
  sessionId?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  exitCode?: number;
  signal?: number;
  message?: string;
  /** Bounded, in-memory replay for renderer recovery. Never persisted or audited. */
  output?: string;
}
export interface DesktopTerminalStartRequest { cols?: number; rows?: number }
export interface DesktopTerminalSessionRequest { sessionId: string }
export interface DesktopTerminalWriteRequest extends DesktopTerminalSessionRequest { data: string }
export interface DesktopTerminalResizeRequest extends DesktopTerminalSessionRequest { cols: number; rows: number }
export type DesktopTerminalEvent =
  | { sessionId: string; sequence: number; kind: "output"; data: string }
  | { sessionId: string; sequence: number; kind: "state"; snapshot: DesktopTerminalSnapshot }
  | { sessionId: string; sequence: number; kind: "exit"; exitCode: number; signal?: number };

export interface OpenRecentWorkspaceRequest {
  workspaceId: string;
}

export interface RemoveRecentWorkspaceRequest {
  workspaceId: string;
  confirmed: true;
}

export interface XiuDesktopBridge {
  managementSnapshot(): Promise<import("../../../src/runtime/workspace-management.js").WorkspaceManagementSnapshot>;
  prepareSkillInstallation(): Promise<Awaited<ReturnType<import("../../../src/runtime/workspace-management.js").WorkspaceManagementService["prepareSkill"]>> | undefined>;
  cancelSkillInstallation(): Promise<void>;
  changeManagement(request: import("../../../src/runtime/workspace-management.js").WorkspaceManagementRequest): Promise<DesktopRuntimeConnection>;
  taskDiagnostics(): Promise<{ report: string; diagnostics: string }>;
  browser(request: DesktopBrowserRequest): Promise<DesktopBrowserState>;
  onBrowserState(listener: (state: DesktopBrowserState) => void): () => void;
  manageMcp(request: DesktopMcpManageRequest): Promise<WorkspaceMcpSnapshot>;
  browseMcp(request: DesktopMcpBrowseRequest): Promise<unknown>;
  mcpSnapshot(): Promise<WorkspaceMcpSnapshot>;
  reloadMcp(): Promise<WorkspaceMcpSnapshot>;
  disconnectMcp(): Promise<WorkspaceMcpSnapshot>;
  approveMcp(request: DesktopMcpApproveRequest): Promise<WorkspaceMcpSnapshot>;
  snapshot(): Promise<DesktopWorkspaceSnapshot>;
  chooseWorkspace(): Promise<DesktopWorkspaceSnapshot>;
  closeWorkspace(): Promise<DesktopWorkspaceSnapshot>;
  openRecentWorkspace(request: OpenRecentWorkspaceRequest): Promise<DesktopWorkspaceSnapshot>;
  removeRecentWorkspace(request: RemoveRecentWorkspaceRequest): Promise<DesktopWorkspaceSnapshot>;
  trustWorkspace(request: TrustWorkspaceRequest): Promise<DesktopWorkspaceSnapshot>;
  runtimeConnect(request?: RuntimeConnectRequest): Promise<DesktopRuntimeConnection>;
  createTask(request: RuntimeTaskRequest): Promise<DesktopRuntimeConnection>;
  continueTask(request: DesktopTaskContinueRequest): Promise<DesktopRuntimeConnection>;
  newConversation(): Promise<DesktopRuntimeConnection>;
  steerTask(request: RuntimeTaskRequest): Promise<boolean>;
  stopTask(): Promise<boolean>;
  setPlanMode(request: DesktopPlanModeRequest): Promise<DesktopRuntimeConnection>;
  setApprovalMode(request: DesktopApprovalModeRequest): Promise<DesktopRuntimeConnection>;
  decideApproval(request: RuntimeApprovalDecisionRequest): Promise<void>;
  openTaskHistory(request: DesktopTaskHistoryRequest): Promise<DesktopTaskHistorySnapshot>;
  deleteTask(request: DesktopTaskDeleteRequest): Promise<DesktopWorkspaceSnapshot>;
  chooseAttachments(): Promise<DesktopAttachmentResult>;
  pasteAttachments(): Promise<DesktopAttachmentResult>;
  importAttachments(request: DesktopAttachmentUploadRequest): Promise<DesktopAttachmentResult>;
  reviewSnapshot(request?: DesktopReviewRequest): Promise<DesktopReviewSnapshot>;
  previewFile(request: DesktopFilePreviewRequest): Promise<ReviewFilePreview>;
  restoreCheckpoint(request: DesktopCheckpointRestoreRequest): Promise<DesktopReviewSnapshot>;
  recoverTask(request: DesktopRecoveryRequest): Promise<DesktopRuntimeConnection>;
  abandonRecovery(request: DesktopRecoveryAbandonRequest): Promise<DesktopReviewSnapshot>;
  providerSnapshot(): Promise<DesktopProviderSnapshot>;
  providerRecovery(request: DesktopProviderRecoveryRequest): Promise<DesktopProviderRecoverySnapshot>;
  discoverProviderModels(request: DesktopProviderModelsRequest): Promise<DesktopProviderSnapshot>;
  selectProvider(request: DesktopProviderSelectRequest): Promise<DesktopProviderMutationResult>;
  saveProviderCredential(request: DesktopProviderCredentialRequest): Promise<DesktopProviderMutationResult>;
  testProvider(request: DesktopProviderTestRequest): Promise<DesktopProviderTestResult>;
  upsertProvider(request: DesktopProviderUpsertRequest): Promise<DesktopProviderMutationResult>;
  deleteProvider(request: DesktopProviderDeleteRequest): Promise<DesktopProviderMutationResult>;
  terminalSnapshot(): Promise<DesktopTerminalSnapshot>;
  startTerminal(request?: DesktopTerminalStartRequest): Promise<DesktopTerminalSnapshot>;
  writeTerminal(request: DesktopTerminalWriteRequest): Promise<void>;
  resizeTerminal(request: DesktopTerminalResizeRequest): Promise<DesktopTerminalSnapshot>;
  stopTerminal(request: DesktopTerminalSessionRequest): Promise<DesktopTerminalSnapshot>;
  onSnapshot(listener: (snapshot: DesktopWorkspaceSnapshot) => void): () => void;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
  onTerminalEvent(listener: (event: DesktopTerminalEvent) => void): () => void;
}

export const desktopChannels = {
  managementSnapshot: "management:snapshot",
  skillPrepare: "skill:prepare",
  skillCancel: "skill:cancel",
  managementChange: "management:change",
  taskDiagnostics: "task:diagnostics",
  browser: "browser:control",
  browserState: "browser:state",
  mcpManage: "mcp:manage",
  mcpBrowse: "mcp:browse",
  mcpSnapshot: "mcp:snapshot",
  mcpReload: "mcp:reload",
  mcpDisconnect: "mcp:disconnect",
  mcpApprove: "mcp:approve",
  snapshot: "desktop:snapshot",
  chooseWorkspace: "workspace:choose",
  closeWorkspace: "workspace:close",
  openRecentWorkspace: "workspace:open-recent",
  removeRecentWorkspace: "workspace:remove-recent",
  trustWorkspace: "workspace:trust",
  snapshotChanged: "desktop:snapshot-changed",
  runtimeConnect: "runtime:connect",
  taskCreate: "runtime:task-create",
  taskContinue: "runtime:task-continue",
  conversationNew: "runtime:conversation-new",
  taskSteer: "runtime:task-steer",
  taskStop: "runtime:task-stop",
  planModeSet: "runtime:plan-mode-set",
  approvalModeSet: "runtime:approval-mode-set",
  approvalDecide: "runtime:approval-decide",
  taskHistoryOpen: "runtime:task-history-open",
  taskDelete: "runtime:task-delete",
  attachmentsChoose: "attachments:choose",
  attachmentsPaste: "attachments:paste",
  attachmentsImport: "attachments:import",
  runtimeEvent: "runtime:event",
  reviewSnapshot: "review:snapshot",
  filePreview: "review:file-preview",
  checkpointRestore: "review:checkpoint-restore",
  recoveryResume: "recovery:resume",
  recoveryAbandon: "recovery:abandon",
  providerSnapshot: "provider:snapshot",
  providerRecovery: "provider:configuration-recovery",
  providerModels: "provider:models",
  providerSelect: "provider:select",
  providerCredentialSave: "provider:credential-save",
  providerTest: "provider:test",
  providerUpsert: "provider:upsert",
  providerDelete: "provider:delete",
  terminalSnapshot: "terminal:snapshot",
  terminalStart: "terminal:start",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalStop: "terminal:stop",
  terminalEvent: "terminal:event",
} as const;
