import { contextBridge, ipcRenderer } from "electron";
import {
  desktopChannels,
  type DesktopMcpApproveRequest,
  type DesktopApprovalModeRequest,
  type DesktopCheckpointRestoreRequest,
  type DesktopAttachmentUploadRequest,
  type DesktopTaskContinueRequest,
  type DesktopTaskDeleteRequest,
  type DesktopFilePreviewRequest,
  type DesktopProviderCredentialRequest,
  type DesktopProviderDeleteRequest,
  type DesktopProviderModelsRequest,
  type DesktopProviderSelectRequest,
  type DesktopProviderTestRequest,
  type DesktopProviderUpsertRequest,
  type DesktopTaskHistoryRequest,
  type DesktopTerminalEvent,
  type DesktopTerminalResizeRequest,
  type DesktopTerminalSessionRequest,
  type DesktopTerminalStartRequest,
  type DesktopTerminalWriteRequest,
  type DesktopRecoveryAbandonRequest,
  type DesktopRecoveryRequest,
  type DesktopReviewRequest,
  type DesktopWorkspaceSnapshot,
  type OpenRecentWorkspaceRequest,
  type RemoveRecentWorkspaceRequest,
  type RuntimeApprovalDecisionRequest,
  type RuntimeConnectRequest,
  type RuntimeEvent,
  type RuntimeTaskRequest,
  type TrustWorkspaceRequest,
  type XiuDesktopBridge,
} from "../shared/protocol.js";

const bridge: XiuDesktopBridge = Object.freeze({
  mcpSnapshot: () => ipcRenderer.invoke(desktopChannels.mcpSnapshot),
  reloadMcp: () => ipcRenderer.invoke(desktopChannels.mcpReload),
  disconnectMcp: () => ipcRenderer.invoke(desktopChannels.mcpDisconnect),
  approveMcp: (request: DesktopMcpApproveRequest) => ipcRenderer.invoke(desktopChannels.mcpApprove, request),
  snapshot: () => ipcRenderer.invoke(desktopChannels.snapshot),
  chooseWorkspace: () => ipcRenderer.invoke(desktopChannels.chooseWorkspace),
  closeWorkspace: () => ipcRenderer.invoke(desktopChannels.closeWorkspace),
  openRecentWorkspace: (request: OpenRecentWorkspaceRequest) => ipcRenderer.invoke(desktopChannels.openRecentWorkspace, request),
  removeRecentWorkspace: (request: RemoveRecentWorkspaceRequest) => ipcRenderer.invoke(desktopChannels.removeRecentWorkspace, request),
  trustWorkspace: (request: TrustWorkspaceRequest) => ipcRenderer.invoke(desktopChannels.trustWorkspace, request),
  runtimeConnect: (request?: RuntimeConnectRequest) => ipcRenderer.invoke(desktopChannels.runtimeConnect, request),
  createTask: (request: RuntimeTaskRequest) => ipcRenderer.invoke(desktopChannels.taskCreate, request),
  continueTask: (request: DesktopTaskContinueRequest) => ipcRenderer.invoke(desktopChannels.taskContinue, request),
  newConversation: () => ipcRenderer.invoke(desktopChannels.conversationNew),
  steerTask: (request: RuntimeTaskRequest) => ipcRenderer.invoke(desktopChannels.taskSteer, request),
  stopTask: () => ipcRenderer.invoke(desktopChannels.taskStop),
  setApprovalMode: (request: DesktopApprovalModeRequest) => ipcRenderer.invoke(desktopChannels.approvalModeSet, request),
  decideApproval: (request: RuntimeApprovalDecisionRequest) => ipcRenderer.invoke(desktopChannels.approvalDecide, request),
  openTaskHistory: (request: DesktopTaskHistoryRequest) => ipcRenderer.invoke(desktopChannels.taskHistoryOpen, request),
  deleteTask: (request: DesktopTaskDeleteRequest) => ipcRenderer.invoke(desktopChannels.taskDelete, request),
  chooseAttachments: () => ipcRenderer.invoke(desktopChannels.attachmentsChoose),
  pasteAttachments: () => ipcRenderer.invoke(desktopChannels.attachmentsPaste),
  importAttachments: (request: DesktopAttachmentUploadRequest) => ipcRenderer.invoke(desktopChannels.attachmentsImport, request),
  reviewSnapshot: (request?: DesktopReviewRequest) => ipcRenderer.invoke(desktopChannels.reviewSnapshot, request),
  previewFile: (request: DesktopFilePreviewRequest) => ipcRenderer.invoke(desktopChannels.filePreview, request),
  restoreCheckpoint: (request: DesktopCheckpointRestoreRequest) => ipcRenderer.invoke(desktopChannels.checkpointRestore, request),
  recoverTask: (request: DesktopRecoveryRequest) => ipcRenderer.invoke(desktopChannels.recoveryResume, request),
  abandonRecovery: (request: DesktopRecoveryAbandonRequest) => ipcRenderer.invoke(desktopChannels.recoveryAbandon, request),
  providerSnapshot: () => ipcRenderer.invoke(desktopChannels.providerSnapshot),
  discoverProviderModels: (request: DesktopProviderModelsRequest) => ipcRenderer.invoke(desktopChannels.providerModels, request),
  selectProvider: (request: DesktopProviderSelectRequest) => ipcRenderer.invoke(desktopChannels.providerSelect, request),
  saveProviderCredential: (request: DesktopProviderCredentialRequest) => ipcRenderer.invoke(desktopChannels.providerCredentialSave, request),
  testProvider: (request: DesktopProviderTestRequest) => ipcRenderer.invoke(desktopChannels.providerTest, request),
  upsertProvider: (request: DesktopProviderUpsertRequest) => ipcRenderer.invoke(desktopChannels.providerUpsert, request),
  deleteProvider: (request: DesktopProviderDeleteRequest) => ipcRenderer.invoke(desktopChannels.providerDelete, request),
  terminalSnapshot: () => ipcRenderer.invoke(desktopChannels.terminalSnapshot),
  startTerminal: (request?: DesktopTerminalStartRequest) => ipcRenderer.invoke(desktopChannels.terminalStart, request),
  writeTerminal: (request: DesktopTerminalWriteRequest) => ipcRenderer.invoke(desktopChannels.terminalWrite, request),
  resizeTerminal: (request: DesktopTerminalResizeRequest) => ipcRenderer.invoke(desktopChannels.terminalResize, request),
  stopTerminal: (request: DesktopTerminalSessionRequest) => ipcRenderer.invoke(desktopChannels.terminalStop, request),
  onSnapshot: (listener: (snapshot: DesktopWorkspaceSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopWorkspaceSnapshot) => listener(snapshot);
    ipcRenderer.on(desktopChannels.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(desktopChannels.snapshotChanged, handler);
  },
  onRuntimeEvent: (listener: (event: RuntimeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent) => listener(runtimeEvent);
    ipcRenderer.on(desktopChannels.runtimeEvent, handler);
    return () => ipcRenderer.removeListener(desktopChannels.runtimeEvent, handler);
  },
  onTerminalEvent: (listener: (event: DesktopTerminalEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: DesktopTerminalEvent) => listener(terminalEvent);
    ipcRenderer.on(desktopChannels.terminalEvent, handler);
    return () => ipcRenderer.removeListener(desktopChannels.terminalEvent, handler);
  },
});

contextBridge.exposeInMainWorld("xiuDesktop", bridge);
