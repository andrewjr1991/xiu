import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, Notification, net, protocol, session, type IpcMainInvokeEvent } from "electron";
import { PreferencesStore } from "./preferences-store.js";
import { spawn as spawnPty } from "node-pty";
import fs from "node:fs/promises";
import { restoreHistoryAttachments } from "./history-attachments.js";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopWorkspaceController } from "./workspace-controller.js";
import { DesktopTaskController } from "./task-controller.js";
import { DesktopProviderController } from "./provider-controller.js";
import { DesktopProviderRecoveryController } from "./provider-recovery-controller.js";
import type { DesktopProviderRecoveryRequest } from "../shared/provider-recovery.js";
import { DesktopTerminalController } from "./terminal-controller.js";
import { DesktopBrowserController } from "./browser-controller.js";
import { ComputerUseController } from "./computer-use-controller.js";
import { createWorkspaceAgentHost } from "../../../src/runtime/workspace-agent-host.js";
import { confirmFullAccess, confirmSubagentCancel, confirmComputerAction, confirmVisionProbe } from "./full-access-dialog.js";
import { VisionProbeController } from "./vision-probe-controller.js";
import { registerProviderIpc } from "./ipc-provider.js";
import { registerManagementIpc } from "./ipc-management.js";
import { SecurityAuditLog } from "../../../src/security-audit.js";
import { useBundledUv } from "../../../src/free-search.js";

const visionProbe = new VisionProbeController();
import { ClipboardAttachmentManager } from "../../../src/clipboard.js";
import { desktopChannels, type DesktopApprovalModeRequest, type DesktopPlanModeRequest, type DesktopAttachmentResult, type DesktopAttachmentUploadRequest, type DesktopCheckpointRestoreRequest, type DesktopFilePreviewRequest, type DesktopMediaPreviewRequest, type DesktopRecoveryAbandonRequest, type DesktopRecoveryRequest, type DesktopReviewRequest, type DesktopTaskContinueRequest, type DesktopTaskDeleteRequest, type DesktopTaskHistoryRequest, type DesktopTerminalResizeRequest, type DesktopTerminalSessionRequest, type DesktopTerminalStartRequest, type DesktopTerminalWriteRequest, type DesktopWorkspaceSnapshot, type OpenRecentWorkspaceRequest, type RemoveRecentWorkspaceRequest, type RuntimeApprovalDecisionRequest, type RuntimeConnectRequest, type RuntimeTaskRequest, type TrustWorkspaceRequest } from "../shared/protocol.js";
import { assertTrustedIpcSender, resolveRendererAsset, secureWebPreferences } from "./security-policy.js";
import { IpcArgumentError, hasIpcArgumentSchema, validateIpcArguments } from "./ipc-schema.js";
import { verifiedComponentPath } from "./unpacked-integrity.js";

protocol.registerSchemesAsPrivileged([{
  scheme: "xiu-app",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}, { scheme: "xiu-preview", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererRoot = path.join(appRoot, "renderer");
const controller = new DesktopWorkspaceController();
let mainWindow: BrowserWindow | undefined;
const preferencesStore = new PreferencesStore(path.join(app.getPath("userData"), "desktop-preferences.json"));
function updateNativeAppearance(): void {
  nativeTheme.themeSource = preferencesStore.value.theme;
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow?.setBackgroundColor(dark ? "#181a1d" : "#fafafa");
  if (mainWindow && process.platform !== "darwin") mainWindow.setTitleBarOverlay({ color: dark ? "#181a1d" : "#fbfcfe", symbolColor: dark ? "#bbc1ca" : "#65758b" });
}
let browserController: DesktopBrowserController | undefined;
let computerUseController: ComputerUseController | undefined;
function stopComputerUse(): import("../shared/computer-use.js").ComputerUseState {
  const bound = computerUseController?.hasBoundTask;
  const state = computerUseController?.stop() ?? { state: "idle" as const };
  if (bound) { try { void taskController.stopTask(controller.trustedWorkspacePath()).catch(() => undefined); } catch { /* Authority already revoked. */ } }
  return state;
}
const smokeLog = process.env.XIU_DESKTOP_SMOKE_LOG;
function smokeMilestone(value: string): void {
  if (!smokeLog) return;
  try { appendFileSync(smokeLog, `${new Date().toISOString()} ${value}\n`, "utf8"); } catch { /* Diagnostics must not affect startup. */ }
}
smokeMilestone("module-loaded");
const taskController = new DesktopTaskController((event) => {
  if (event.type === "task.started") computerUseController?.taskStarted(event.taskId!);
  if (event.type === "task.finished") computerUseController?.taskFinished();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopChannels.runtimeEvent, event);
  const p = preferencesStore.value;
  const body = event.type === "approval.requested" && p.notifyApproval ? "任务需要你的批准"
    : event.type === "task.finished" && event.payload.state === "completed" && p.notifyComplete ? "任务已完成"
    : event.type === "task.finished" && ["failed", "unverified"].includes(event.payload.state) && p.notifyFailure ? "任务未完成，请查看详情" : undefined;
  if (body && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
    try {
      const notification = new Notification({ title: "Xiu", body, silent: !p.sound });
      notification.on("click", () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
      notification.show();
    } catch { /* OS notifications cannot interrupt the task. */ }
  }
}, async (workspace) => {
  const check = () => {
    if (controller.trustedWorkspacePath() !== workspace || !computerUseController || host.runtime.snapshot().planMode) throw new Error("电脑操作授权不可用；Plan 或工作区已变化。");
    return computerUseController;
  };
  // Packaged builds verify the unpacked worker against the asar manifest on every start (S6).
  const host = await createWorkspaceAgentHost(workspace, { backgroundWorkerSource: () => verifiedComponentPath("main/background-worker.mjs"), computerUse: {
    windows: () => check().discover(workspace),
    select: (handle, provider, fullAccess, signal) => check().selectForModel(workspace, handle, provider, fullAccess, signal),
    observe: (provider, signal) => check().observeForModel(workspace, provider, signal),
    input: (input, signal) => check().input(workspace, input as import("../shared/computer-use.js").ComputerInput, signal),
    feedbackFinished: () => check().feedbackFinished(),
    status: () => { const target = check().selectedStatus(); return target; },
    confirms: (step) => {
      try { return check().confirms(step); }
      catch { return false; } // No trusted controller for this workspace (Plan or workspace change): keep the generic approval.
    },
  } });
  const close = host.close;
  host.close = async () => { computerUseController?.revokeFullAccess(); await close?.(); };
  return host;
});
const terminalController = new DesktopTerminalController((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopChannels.terminalEvent, event);
}, (file, args, options) => spawnPty(file, args, options), undefined, async () => ({
  hideSecrets: preferencesStore.value.terminalHidesSecrets,
  // Provider key variables are hidden by name even when they do not look like secrets; the values stay in the registry.
  secretNames: await getProviderController().then((provider) => provider.secretEnvironmentNames(), () => []),
}));
let providerController: Promise<DesktopProviderController> | undefined;
const providerRecoveryController = new DesktopProviderRecoveryController({
  isBusy: () => !taskController.canChangeWorkspace() || terminalController.snapshot().state === "running",
  contextIdentity: () => taskController.recoveryContextId(),
  confirm: async (preview) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    await browserController?.control({ action: "layout", bounds: { x: 0, y: 56, width: 0, height: 0 }, visible: false });
    const keepCurrent = preview.action === "keep-current";
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "Provider 配置恢复", defaultId: 0, cancelId: 0, noLink: true,
      buttons: ["取消", keepCurrent ? "保留配置并清理写锁" : "确认恢复备份"],
      message: keepCurrent ? "保留当前配置，仅清理已确认退出进程的中断写锁？" : "恢复此备份并替换当前 Provider 配置？",
      detail: `${keepCurrent ? "不恢复备份、不复制配置。" : `备份：${preview.backupId} · 版本 ${preview.sourceVersion}。当前配置将保留在受保护备份中。`}\n请先关闭其他 Xiu 客户端。恢复后必须重启，CLI 与桌面需要配套升级。系统凭据不会被恢复，旧凭据引用可能已失效。\n\n${preview.warnings.join("\n")}`,
    });
    return result.response === 1;
  },
  onRecovered: () => { taskController.detach(); providerController = undefined; },
});
let writerStartQueue: Promise<void> = Promise.resolve();
function getProviderController(): Promise<DesktopProviderController> {
  return providerController ??= DesktopProviderController.create({
    // Same ledger and record shape as the CLI's /credentials commands; the ledger is per user, scoped to the open workspace.
    audit: async (action, subject, outcome) => {
      let workspace: string;
      try { workspace = controller.trustedWorkspacePath(); } catch { workspace = process.cwd(); }
      await new SecurityAuditLog(undefined, workspace).record({ category: "credential", action, outcome, subject, source: "command" });
    },
  });
}

function serializeWriterStart<T>(operation: () => Promise<T>, recovery = false): Promise<T> {
  const guarded = () => {
    if (!recovery) { providerRecoveryController.assertCanContinue(); providerRecoveryController.invalidateContext(); }
    return operation();
  };
  const result = writerStartQueue.then(guarded, guarded);
  writerStartQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Every renderer→main invoke channel validates its arguments against `ipc-schema.ts` before its handler runs; a channel without a schema cannot be registered. */
function handleIpc(channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  if (!hasIpcArgumentSchema(channel)) throw new IpcArgumentError(channel, "no argument schema is registered for this channel");
  ipcMain.handle(channel, (event, ...args) => listener(event, ...(validateIpcArguments(channel, args) as never[])));
}

function assertTrustedSender(event: IpcMainInvokeEvent, recovery = false): void {
  assertTrustedIpcSender(event, mainWindow?.webContents.id);
  if (!recovery) providerRecoveryController.assertCanContinue();
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/** Scales a decoded image to at most 1280×960 for an inline conversation preview; undefined when it cannot be decoded. */
function boundedImageThumbnail(data: Buffer): string | undefined {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  const scale = Math.min(1, 1280 / Math.max(1, size.width), 960 / Math.max(1, size.height));
  return image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" }).toDataURL();
}

async function presentAttachments(workspace: string, result: Awaited<ReturnType<ClipboardAttachmentManager["attachFiles"]>>): Promise<DesktopAttachmentResult> {
  const root = path.resolve(workspace);
  const attachments = await Promise.all(result.attachments.map(async (relative) => {
    const normalized = relative.replace(/\\/g, "/");
    const absolute = path.resolve(root, relative);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (absolute !== root && !absolute.startsWith(prefix)) throw new Error("附件路径超出工作区。");
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("附件不是安全的普通文件。");
    const kind = IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase()) ? "image" as const : "file" as const;
    let previewDataUrl: string | undefined;
    if (kind === "image" && stat.size <= 25 * 1024 * 1024) {
      const image = nativeImage.createFromPath(absolute);
      if (!image.isEmpty()) {
        const size = image.getSize();
        const scale = Math.min(1, 180 / Math.max(1, size.width), 120 / Math.max(1, size.height));
        previewDataUrl = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" }).toDataURL();
      }
    }
    const reference = /\s/.test(normalized) ? `@${JSON.stringify(normalized)}` : `@${normalized}`;
    return { reference, path: normalized, name: path.basename(relative), bytes: stat.size, kind, ...(previewDataUrl ? { previewDataUrl } : {}) };
  }));
  return { insertText: "", attachments, ...(result.notice ? { notice: result.notice } : {}) };
}

function emitSnapshot(snapshot: DesktopWorkspaceSnapshot): DesktopWorkspaceSnapshot {
  computerUseController?.retainWorkspace(snapshot.trust === "trusted" ? snapshot.workspace?.path : undefined);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopChannels.snapshotChanged, snapshot);
  return snapshot;
}

function registerIpc(): void {
  handleIpc(desktopChannels.computerUse, async (event, request: import("../shared/computer-use.js").ComputerUseRequest) => {
    assertTrustedSender(event, request?.action === "stop");
    if (!computerUseController) throw new Error("受控预览尚未就绪。");
    if (request?.action === "stop") return stopComputerUse();
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (request?.action !== "state") await taskController.assertCanUseTerminal(workspace);
      const connection = await taskController.connect(workspace, 0);
      if (request?.action === "automatic") {
        // The grant names the actual vision destination; a workspace without one cannot be granted automatic operation.
        if (connection.runtime.snapshot.planMode === true) throw new Error("Plan 只读模式不能开启自动电脑操作。");
        const route = await taskController.computerVisionRoute(workspace);
        if (!route) throw new Error("当前渠道没有视觉能力，不能开启自动电脑操作。");
        return computerUseController!.requestAutomatic(workspace, route);
      }
      return computerUseController!.control(workspace, request, connection.runtime.snapshot.planMode === true);
    });
  });
  handleIpc(desktopChannels.preferences, (event) => { assertTrustedSender(event, true); return { ...preferencesStore.value }; });
  handleIpc(desktopChannels.preferencesSave, async (event, value: unknown) => {
    assertTrustedSender(event, true);
    const next = await preferencesStore.save(value); updateNativeAppearance(); return next;
  });
  handleIpc(desktopChannels.about, (event) => { assertTrustedSender(event, true); return { version: app.getVersion(), packaged: app.isPackaged, notificationsSupported: Notification.isSupported() }; });
  handleIpc(desktopChannels.providerRecovery, async (event, request: DesktopProviderRecoveryRequest) => {
    assertTrustedSender(event, true);
    return serializeWriterStart(() => providerRecoveryController.handle(request), true);
  });
  handleIpc(desktopChannels.browser, async (event, request) => { assertTrustedSender(event); if (!browserController) throw new Error("网页工作台尚未就绪。"); return browserController.control(request); });
  handleIpc(desktopChannels.snapshot, async (event) => {
    assertTrustedSender(event);
    return controller.snapshot();
  });
  handleIpc(desktopChannels.chooseWorkspace, async (event) => serializeWriterStart(async () => {
    assertTrustedSender(event);
    if (!taskController.canChangeWorkspace()) throw new Error("任务仍在运行，请先停止并等待任务结束。");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择 Xiu 工作区",
      properties: ["openDirectory", "dontAddToRecent"],
    });
    if (result.canceled || result.filePaths.length !== 1) return controller.snapshot();
    terminalController.stopAll("工作区已切换，终端会话已关闭。");
    taskController.detach();
    return emitSnapshot(await controller.selectWorkspace(result.filePaths[0]!));
  }));
  handleIpc(desktopChannels.closeWorkspace, async (event) => serializeWriterStart(async () => {
    assertTrustedSender(event);
    terminalController.stopAll("工作区已关闭，终端会话已结束。");
    taskController.detach();
    return emitSnapshot(await controller.clearSelection());
  }));
  handleIpc(desktopChannels.openRecentWorkspace, async (event, request: OpenRecentWorkspaceRequest) => serializeWriterStart(async () => {
    assertTrustedSender(event);
    terminalController.stopAll("工作区已切换，终端会话已关闭。");
    taskController.detach();
    return emitSnapshot(await controller.openRecent(request));
  }));
  handleIpc(desktopChannels.removeRecentWorkspace, async (event, request: RemoveRecentWorkspaceRequest) => serializeWriterStart(async () => {
    assertTrustedSender(event);
    const snapshot = await controller.snapshot();
    const selected = snapshot.recent.find((item) => item.id === request?.workspaceId);
    if (!selected) throw new Error("最近项目不存在或已经移除。");
    if (request?.confirmed !== true) throw new Error("移除最近项目需要明确确认。");
    const removingCurrent = snapshot.workspace?.id === request.workspaceId;
    if (removingCurrent) {
      if (!taskController.canChangeWorkspace()) throw new Error("任务仍在运行，请先停止并等待任务结束。");
      terminalController.stopAll("工作区已移除，终端会话已关闭。");
      taskController.detach();
    }
    return emitSnapshot(await controller.removeRecent(request, request.confirmed));
  }));
  handleIpc(desktopChannels.trustWorkspace, async (event, request: TrustWorkspaceRequest) => {
    assertTrustedSender(event);
    providerRecoveryController.invalidateContext();
    return emitSnapshot(await controller.trustCurrent(request));
  });
  handleIpc(desktopChannels.runtimeConnect, async (event, request?: RuntimeConnectRequest) => {
    assertTrustedSender(event);
    const after = request?.afterSequence;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error("Invalid runtime sequence.");
    return taskController.connect(controller.trustedWorkspacePath(), after);
  });
  handleIpc(desktopChannels.taskCreate, async (event, request: RuntimeTaskRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (terminalController.isRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再启动 Agent 任务。");
      return taskController.createTask(workspace, request?.text, request?.answerTo);
    });
  });
  handleIpc(desktopChannels.taskContinue, async (event, request: DesktopTaskContinueRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (terminalController.isRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再继续 Agent 任务。");
      return taskController.continueTask(workspace, request?.taskId, request?.text);
    });
  });
  handleIpc(desktopChannels.conversationNew, async (event) => {
    assertTrustedSender(event);
    return serializeWriterStart(() => taskController.newConversation(controller.trustedWorkspacePath()));
  });
  handleIpc(desktopChannels.taskSteer, async (event, request: RuntimeTaskRequest) => {
    assertTrustedSender(event);
    return taskController.steerTask(controller.trustedWorkspacePath(), request?.text);
  });
  handleIpc(desktopChannels.taskStop, async (event) => {
    assertTrustedSender(event);
    return taskController.stopTask(controller.trustedWorkspacePath());
  });
  handleIpc(desktopChannels.planModeSet, async (event, request: DesktopPlanModeRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (terminalController.isRunning(workspace)) throw new Error("交互终端仍在运行，请先关闭终端再切换 Plan 模式。");
      computerUseController?.stop();
      return taskController.setPlanMode(workspace, request);
    });
  });
  handleIpc(desktopChannels.approvalModeSet, async (event, request: DesktopApprovalModeRequest) => {
    assertTrustedSender(event);
    return taskController.setApprovalMode(controller.trustedWorkspacePath(), request, async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      await browserController?.control({ action: "layout", bounds: { x: 0, y: 56, width: 0, height: 0 }, visible: false });
      const workspace = controller.trustedWorkspacePath();
      const route = await taskController.computerVisionRoute(workspace);
      const accepted = await confirmFullAccess(mainWindow, route);
      if (accepted && route && controller.trustedWorkspacePath() === workspace) computerUseController?.grantFullAccess(workspace, route);
      return accepted;
    });
  });
  handleIpc(desktopChannels.approvalDecide, async (event, request: RuntimeApprovalDecisionRequest) => {
    assertTrustedSender(event);
    return taskController.decideApproval(controller.trustedWorkspacePath(), request);
  });
  handleIpc(desktopChannels.computerAcceptance, async (event, request: import("../shared/protocol.js").DesktopComputerAcceptanceRequest) => {
    assertTrustedSender(event);
    return taskController.computerAcceptance(controller.trustedWorkspacePath(), request, async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      return confirmComputerAction(mainWindow, request.decision === "passed" ? "确认电脑操作结果通过？" : "记录电脑操作结果未通过？", "仅记录你对这一轮电脑操作结果的人工判断，不覆盖程序验证、失败校验或过程提醒，不授予执行或恢复权限。确认前请检查目标应用的最终结果。后续轮次不会继承本次验收。");
    });
  });
  handleIpc(desktopChannels.taskHistoryOpen, async (event, request: DesktopTaskHistoryRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    const history = await taskController.openTaskHistory(workspace, request);
    const attachments = await restoreHistoryAttachments(workspace, history.attachmentReferences ?? {}, data => {
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) return undefined;
      const size = image.getSize();
      const scale = Math.min(1, 180 / Math.max(1, size.width), 120 / Math.max(1, size.height));
      return image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" }).toDataURL();
    });
    // Do not send results from a workspace closed/switched while files loaded.
    if (controller.trustedWorkspacePath() !== workspace) throw new Error("Workspace changed while loading history.");
    return { ...history, attachments };
  });
  handleIpc(desktopChannels.taskDelete, async (event, request: DesktopTaskDeleteRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (request?.confirmed !== true) throw new Error("删除任务需要明确确认。");
      await taskController.deleteTask(workspace, request, request.confirmed);
      return emitSnapshot(await controller.snapshot());
    });
  });
  handleIpc(desktopChannels.attachmentsChoose, async (event) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "添加文件或图片",
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
    });
    if (result.canceled || result.filePaths.length === 0) return { insertText: "", attachments: [] };
    return presentAttachments(workspace, await new ClipboardAttachmentManager(workspace, undefined, "zh-CN").attachFiles(result.filePaths));
  });
  handleIpc(desktopChannels.attachmentsPaste, async (event) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    return presentAttachments(workspace, await new ClipboardAttachmentManager(workspace, undefined, "zh-CN").paste());
  });
  handleIpc(desktopChannels.copyMessage, (event, text: unknown) => {
    assertTrustedSender(event);
    controller.trustedWorkspacePath();
    if (typeof text !== "string" || text.length === 0 || text.length > 200_000) throw new Error("复制内容无效或过长。");
    clipboard.writeText(text);
  });
  handleIpc(desktopChannels.attachmentsImport, async (event, request: DesktopAttachmentUploadRequest) => {
    assertTrustedSender(event);
    if (!request || !Array.isArray(request.files)) throw new Error("Invalid attachment request.");
    const workspace = controller.trustedWorkspacePath();
    return presentAttachments(workspace, await new ClipboardAttachmentManager(workspace, undefined, "zh-CN").attachBytes(request.files));
  });
  handleIpc(desktopChannels.reviewSnapshot, async (event, request?: DesktopReviewRequest) => {
    assertTrustedSender(event);
    return taskController.reviewSnapshot(controller.trustedWorkspacePath(), request?.changeView);
  });
  handleIpc(desktopChannels.subagentCancel, async (event, request: import("../shared/protocol.js").DesktopSubagentCancelRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => taskController.cancelSubagent(controller.trustedWorkspacePath(), request, async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      await browserController?.control({ action: "layout", bounds: { x: 0, y: 56, width: 0, height: 0 }, visible: false });
      return confirmSubagentCancel(mainWindow);
    }));
  });
  handleIpc(desktopChannels.filePreview, async (event, request: DesktopFilePreviewRequest) => {
    assertTrustedSender(event);
    return taskController.previewFile(controller.trustedWorkspacePath(), request);
  });
  handleIpc(desktopChannels.mediaPreview, async (event, request: DesktopMediaPreviewRequest) => {
    assertTrustedSender(event);
    return taskController.previewMedia(controller.trustedWorkspacePath(), request, boundedImageThumbnail);
  });
  handleIpc(desktopChannels.checkpointRestore, async (event, request: DesktopCheckpointRestoreRequest) => {
    assertTrustedSender(event);
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "warning", title: "恢复检查点", message: "恢复会覆盖当前文件内容。是否继续？",
      detail: `检查点：${request?.checkpointId ?? "未知"}\nXiu 会先为涉及文件创建新的安全检查点。`,
      buttons: ["取消", "确认恢复"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return taskController.restoreCheckpoint(controller.trustedWorkspacePath(), request, confirmation.response === 1);
  });
  handleIpc(desktopChannels.recoveryResume, async (event, request: DesktopRecoveryRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (terminalController.isRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再恢复 Agent 任务。");
      const review = await taskController.reviewSnapshot(workspace, "workspace");
      if (!review.recovery || review.recovery.runId !== request?.runId) throw new Error("恢复记录不存在或已经变化。");
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: "warning", title: "恢复中断任务", message: "确认先核验未知副作用，再继续任务？",
        detail: `待核验操作：${review.recovery.unknownOperations.length} 项。Xiu 不会自动重放这些操作。`,
        buttons: ["取消", "确认恢复"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmation.response !== 1) throw new Error("已取消恢复。");
      return taskController.recoverTask(workspace, request, true);
    });
  });
  handleIpc(desktopChannels.recoveryAbandon, async (event, request: DesktopRecoveryAbandonRequest) => {
    assertTrustedSender(event);
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "warning", title: "放弃中断任务", message: "确认将旧任务标记为已放弃？",
      detail: "不会重放旧操作，也不会删除工作区文件或检查点。", buttons: ["取消", "确认放弃"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return taskController.abandonRecovery(controller.trustedWorkspacePath(), request, confirmation.response === 1);
  });
  registerManagementIpc({
    handleIpc, assertTrustedSender, serializeWriterStart,
    trustedWorkspacePath: () => controller.trustedWorkspacePath(),
    tasks: taskController, terminalRunning: (workspace) => terminalController.isRunning(workspace),
    chooseSkillSource: async (sourceKind) => {
      if (!mainWindow || mainWindow.isDestroyed()) return undefined;
      const result = await dialog.showOpenDialog(mainWindow, sourceKind === "directory"
        ? { title: "选择本地 Skill 包目录", properties: ["openDirectory"] }
        : { title: "选择 SKILL.md 或 ZIP 技能包", properties: ["openFile"], filters: [{ name: "Skill 文件与压缩包", extensions: ["md", "zip"] }] });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  registerProviderIpc({
    handleIpc, assertTrustedSender, serializeWriterStart,
    trustedWorkspacePath: () => controller.trustedWorkspacePath(),
    providers: getProviderController, tasks: taskController, visionProbe, mainWindow: () => mainWindow, confirmVisionProbe,
  });
  handleIpc(desktopChannels.terminalSnapshot, async (event) => {
    assertTrustedSender(event);
    return terminalController.snapshot(controller.trustedWorkspacePath());
  });
  handleIpc(desktopChannels.terminalStart, async (event, request?: DesktopTerminalStartRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      await taskController.assertCanUseTerminal(workspace);
      return terminalController.start(workspace, request);
    });
  });
  handleIpc(desktopChannels.terminalWrite, async (event, request: DesktopTerminalWriteRequest) => {
    assertTrustedSender(event);
    terminalController.write(controller.trustedWorkspacePath(), request);
  });
  handleIpc(desktopChannels.terminalResize, async (event, request: DesktopTerminalResizeRequest) => {
    assertTrustedSender(event);
    return terminalController.resize(controller.trustedWorkspacePath(), request);
  });
  handleIpc(desktopChannels.terminalStop, async (event, request: DesktopTerminalSessionRequest) => {
    assertTrustedSender(event);
    return terminalController.stop(controller.trustedWorkspacePath(), request?.sessionId);
  });
}

async function registerLocalProtocol(): Promise<void> {
  protocol.handle("xiu-app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "bundle") return new Response("Not found", { status: 404 });
    const target = resolveRendererAsset(rendererRoot, url.pathname);
    if (!target) return new Response("Forbidden", { status: 403 });
    const stat = await fs.lstat(target).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow(): BrowserWindow {
  // Packaged Windows GUI launchers do not consistently preserve ad-hoc argv
  // through every shell. Keep the argument for developers and an explicit,
  // test-only environment switch for deterministic packaged acceptance.
  const smokeTest = process.argv.includes("--smoke-test") || process.env.XIU_DESKTOP_SMOKE === "1";
  const smokeHold = process.env.XIU_DESKTOP_SMOKE_HOLD === "1";
  smokeMilestone(`create-window smoke=${smokeTest} hold=${smokeHold}`);
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 840,
    minHeight: 600,
    show: !smokeTest && !smokeHold,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181a1d" : "#f7f9fc",
    title: "Xiu",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: { color: "#fbfcfe", symbolColor: "#65758b", height: 56 },
    }),
    icon: path.join(appRoot, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(appRoot, "preload", "index.cjs"),
      ...secureWebPreferences,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", () => { stopComputerUse(); /* No automatic task replay. */ });
  browserController = new DesktopBrowserController(window, (state) => { if (!window.isDestroyed()) window.webContents.send(desktopChannels.browserState, state); });
  window.once("close", () => browserController?.close());
  computerUseController = new ComputerUseController(window, undefined, stopComputerUse);
  window.once("close", () => computerUseController?.stop());
  window.once("closed", () => terminalController.stopAll("窗口已关闭，终端会话已结束。"));
  window.webContents.once("did-fail-load", (_event, _code, description) => {
    smokeMilestone(`load-failed ${description}`);
    if (smokeTest) {
      console.error(description);
      app.exit(1);
    }
  });
  window.webContents.once("did-finish-load", () => {
    smokeMilestone("load-finished");
    if (smokeTest && !smokeHold) app.exit(0);
  });
  if (!smokeTest && !smokeHold) window.once("ready-to-show", () => window.show());
  void window.loadURL("xiu-app://bundle/index.html");
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    await preferencesStore.load();
    nativeTheme.themeSource = preferencesStore.value.theme;
    nativeTheme.on("updated", updateNativeAppearance);
    smokeMilestone("app-ready");
    // Installed builds ship a pinned uv (resources/uv) so local free-search needs no setup.
    if (app.isPackaged && useBundledUv(path.join(process.resourcesPath, "uv"))) smokeMilestone("bundled-uv");
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    await registerLocalProtocol();
    mainWindow = createWindow();
    globalShortcut.register("Control+Alt+Backspace", stopComputerUse);
    updateNativeAppearance();
    smokeMilestone("window-created");
  }).catch((error) => {
    smokeMilestone(`startup-error ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

let shutdownComplete = false;
let shutdownStarted = false;
app.on("before-quit", (event) => {
  visionProbe.cancel();
  globalShortcut.unregisterAll();
  computerUseController?.stop();
  terminalController.stopAll("Xiu 正在退出，终端会话已结束。");
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  // Await stdio children / HTTP sessions before leaving the main process.
  void taskController.shutdown().catch(() => undefined).finally(() => { shutdownComplete = true; app.quit(); });
});
app.on("window-all-closed", () => app.quit());
