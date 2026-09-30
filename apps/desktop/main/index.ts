import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, session, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopWorkspaceController } from "./workspace-controller.js";
import { DesktopTaskController } from "./task-controller.js";
import { DesktopProviderController } from "./provider-controller.js";
import { DesktopTerminalController } from "./terminal-controller.js";
import { ClipboardAttachmentManager } from "../../../src/clipboard.js";
import { desktopChannels, type DesktopApprovalModeRequest, type DesktopAttachmentResult, type DesktopAttachmentUploadRequest, type DesktopCheckpointRestoreRequest, type DesktopFilePreviewRequest, type DesktopProviderCredentialRequest, type DesktopProviderDeleteRequest, type DesktopProviderModelsRequest, type DesktopProviderSelectRequest, type DesktopProviderTestRequest, type DesktopProviderUpsertRequest, type DesktopRecoveryAbandonRequest, type DesktopRecoveryRequest, type DesktopReviewRequest, type DesktopTaskContinueRequest, type DesktopTaskDeleteRequest, type DesktopTaskHistoryRequest, type DesktopTerminalResizeRequest, type DesktopTerminalSessionRequest, type DesktopTerminalStartRequest, type DesktopTerminalWriteRequest, type DesktopWorkspaceSnapshot, type OpenRecentWorkspaceRequest, type RemoveRecentWorkspaceRequest, type RuntimeApprovalDecisionRequest, type RuntimeConnectRequest, type RuntimeTaskRequest, type TrustWorkspaceRequest } from "../shared/protocol.js";
import { isTrustedRendererUrl, resolveRendererAsset, secureWebPreferences } from "./security-policy.js";

protocol.registerSchemesAsPrivileged([{
  scheme: "xiu-app",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererRoot = path.join(appRoot, "renderer");
const controller = new DesktopWorkspaceController();
let mainWindow: BrowserWindow | undefined;
const smokeLog = process.env.XIU_DESKTOP_SMOKE_LOG;
function smokeMilestone(value: string): void {
  if (!smokeLog) return;
  try { appendFileSync(smokeLog, `${new Date().toISOString()} ${value}\n`, "utf8"); } catch { /* Diagnostics must not affect startup. */ }
}
smokeMilestone("module-loaded");
const taskController = new DesktopTaskController((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopChannels.runtimeEvent, event);
});
const terminalController = new DesktopTerminalController((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopChannels.terminalEvent, event);
});
let providerController: Promise<DesktopProviderController> | undefined;
let writerStartQueue: Promise<void> = Promise.resolve();
function getProviderController(): Promise<DesktopProviderController> {
  return providerController ??= DesktopProviderController.create();
}

function serializeWriterStart<T>(operation: () => Promise<T>): Promise<T> {
  const result = writerStartQueue.then(operation, operation);
  writerStartQueue = result.then(() => undefined, () => undefined);
  return result;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !isTrustedRendererUrl(url)) {
    throw new Error("Rejected IPC from an untrusted renderer.");
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopChannels.snapshotChanged, snapshot);
  return snapshot;
}

function registerIpc(): void {
  ipcMain.handle(desktopChannels.snapshot, async (event) => {
    assertTrustedSender(event);
    return controller.snapshot();
  });
  ipcMain.handle(desktopChannels.chooseWorkspace, async (event) => {
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
  });
  ipcMain.handle(desktopChannels.closeWorkspace, async (event) => {
    assertTrustedSender(event);
    terminalController.stopAll("工作区已关闭，终端会话已结束。");
    taskController.detach();
    return emitSnapshot(await controller.clearSelection());
  });
  ipcMain.handle(desktopChannels.openRecentWorkspace, async (event, request: OpenRecentWorkspaceRequest) => {
    assertTrustedSender(event);
    terminalController.stopAll("工作区已切换，终端会话已关闭。");
    taskController.detach();
    return emitSnapshot(await controller.openRecent(request));
  });
  ipcMain.handle(desktopChannels.removeRecentWorkspace, async (event, request: RemoveRecentWorkspaceRequest) => {
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
  });
  ipcMain.handle(desktopChannels.trustWorkspace, async (event, request: TrustWorkspaceRequest) => {
    assertTrustedSender(event);
    return emitSnapshot(await controller.trustCurrent(request));
  });
  ipcMain.handle(desktopChannels.runtimeConnect, async (event, request?: RuntimeConnectRequest) => {
    assertTrustedSender(event);
    const after = request?.afterSequence;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error("Invalid runtime sequence.");
    return taskController.connect(controller.trustedWorkspacePath(), after);
  });
  ipcMain.handle(desktopChannels.taskCreate, async (event, request: RuntimeTaskRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (terminalController.isRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再启动 Agent 任务。");
      return taskController.createTask(workspace, request?.text);
    });
  });
  ipcMain.handle(desktopChannels.taskContinue, async (event, request: DesktopTaskContinueRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      if (terminalController.isRunning(workspace)) throw new Error("交互终端仍在运行。请先关闭终端，再继续 Agent 任务。");
      return taskController.continueTask(workspace, request?.taskId, request?.text);
    });
  });
  ipcMain.handle(desktopChannels.conversationNew, async (event) => {
    assertTrustedSender(event);
    return taskController.newConversation(controller.trustedWorkspacePath());
  });
  ipcMain.handle(desktopChannels.taskSteer, async (event, request: RuntimeTaskRequest) => {
    assertTrustedSender(event);
    return taskController.steerTask(controller.trustedWorkspacePath(), request?.text);
  });
  ipcMain.handle(desktopChannels.taskStop, async (event) => {
    assertTrustedSender(event);
    return taskController.stopTask(controller.trustedWorkspacePath());
  });
  ipcMain.handle(desktopChannels.approvalModeSet, async (event, request: DesktopApprovalModeRequest) => {
    assertTrustedSender(event);
    return taskController.setApprovalMode(controller.trustedWorkspacePath(), request);
  });
  ipcMain.handle(desktopChannels.approvalDecide, async (event, request: RuntimeApprovalDecisionRequest) => {
    assertTrustedSender(event);
    return taskController.decideApproval(controller.trustedWorkspacePath(), request);
  });
  ipcMain.handle(desktopChannels.taskHistoryOpen, async (event, request: DesktopTaskHistoryRequest) => {
    assertTrustedSender(event);
    return taskController.openTaskHistory(controller.trustedWorkspacePath(), request);
  });
  ipcMain.handle(desktopChannels.taskDelete, async (event, request: DesktopTaskDeleteRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    const snapshot = await controller.snapshot();
    const selected = snapshot.tasks.find((item) => item.id === request?.taskId);
    if (!selected) throw new Error("任务不存在或已经删除。");
    if (request?.confirmed !== true) throw new Error("删除任务需要明确确认。");
    await taskController.deleteTask(workspace, request, request.confirmed);
    return emitSnapshot(await controller.snapshot());
  });
  ipcMain.handle(desktopChannels.attachmentsChoose, async (event) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "添加文件或图片",
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
    });
    if (result.canceled || result.filePaths.length === 0) return { insertText: "", attachments: [] };
    return presentAttachments(workspace, await new ClipboardAttachmentManager(workspace, undefined, "zh-CN").attachFiles(result.filePaths));
  });
  ipcMain.handle(desktopChannels.attachmentsPaste, async (event) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    return presentAttachments(workspace, await new ClipboardAttachmentManager(workspace, undefined, "zh-CN").paste());
  });
  ipcMain.handle(desktopChannels.attachmentsImport, async (event, request: DesktopAttachmentUploadRequest) => {
    assertTrustedSender(event);
    if (!request || !Array.isArray(request.files)) throw new Error("Invalid attachment request.");
    const workspace = controller.trustedWorkspacePath();
    return presentAttachments(workspace, await new ClipboardAttachmentManager(workspace, undefined, "zh-CN").attachBytes(request.files));
  });
  ipcMain.handle(desktopChannels.reviewSnapshot, async (event, request?: DesktopReviewRequest) => {
    assertTrustedSender(event);
    return taskController.reviewSnapshot(controller.trustedWorkspacePath(), request?.changeView);
  });
  ipcMain.handle(desktopChannels.filePreview, async (event, request: DesktopFilePreviewRequest) => {
    assertTrustedSender(event);
    return taskController.previewFile(controller.trustedWorkspacePath(), request);
  });
  ipcMain.handle(desktopChannels.checkpointRestore, async (event, request: DesktopCheckpointRestoreRequest) => {
    assertTrustedSender(event);
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "warning", title: "恢复检查点", message: "恢复会覆盖当前文件内容。是否继续？",
      detail: `检查点：${request?.checkpointId ?? "未知"}\nXiu 会先为涉及文件创建新的安全检查点。`,
      buttons: ["取消", "确认恢复"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return taskController.restoreCheckpoint(controller.trustedWorkspacePath(), request, confirmation.response === 1);
  });
  ipcMain.handle(desktopChannels.recoveryResume, async (event, request: DesktopRecoveryRequest) => {
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
  ipcMain.handle(desktopChannels.recoveryAbandon, async (event, request: DesktopRecoveryAbandonRequest) => {
    assertTrustedSender(event);
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "warning", title: "放弃中断任务", message: "确认将旧任务标记为已放弃？",
      detail: "不会重放旧操作，也不会删除工作区文件或检查点。", buttons: ["取消", "确认放弃"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return taskController.abandonRecovery(controller.trustedWorkspacePath(), request, confirmation.response === 1);
  });
  ipcMain.handle(desktopChannels.providerSnapshot, async (event) => {
    assertTrustedSender(event);
    controller.trustedWorkspacePath();
    return (await getProviderController()).snapshot();
  });
  ipcMain.handle(desktopChannels.providerModels, async (event, request: DesktopProviderModelsRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    return (await getProviderController()).discover(workspace, request);
  });
  ipcMain.handle(desktopChannels.providerSelect, async (event, request: DesktopProviderSelectRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    await taskController.assertCanReconfigure(workspace);
    const settings = await (await getProviderController()).select(request);
    return { settings, connection: await taskController.reload(workspace) };
  });
  ipcMain.handle(desktopChannels.providerCredentialSave, async (event, request: DesktopProviderCredentialRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    await taskController.assertCanReconfigure(workspace);
    const settings = await (await getProviderController()).saveCredential(request);
    return { settings, connection: await taskController.reload(workspace) };
  });
  ipcMain.handle(desktopChannels.providerTest, async (event, request: DesktopProviderTestRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    await taskController.assertCanReconfigure(workspace);
    return (await getProviderController()).test(workspace, request);
  });
  ipcMain.handle(desktopChannels.providerUpsert, async (event, request: DesktopProviderUpsertRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    await taskController.assertCanReconfigure(workspace);
    const settings = await (await getProviderController()).upsert(request);
    return { settings, connection: await taskController.reload(workspace) };
  });
  ipcMain.handle(desktopChannels.providerDelete, async (event, request: DesktopProviderDeleteRequest) => {
    assertTrustedSender(event);
    const workspace = controller.trustedWorkspacePath();
    await taskController.assertCanReconfigure(workspace);
    const settings = await (await getProviderController()).delete(request);
    return { settings, connection: await taskController.reload(workspace) };
  });
  ipcMain.handle(desktopChannels.terminalSnapshot, async (event) => {
    assertTrustedSender(event);
    return terminalController.snapshot(controller.trustedWorkspacePath());
  });
  ipcMain.handle(desktopChannels.terminalStart, async (event, request?: DesktopTerminalStartRequest) => {
    assertTrustedSender(event);
    return serializeWriterStart(async () => {
      const workspace = controller.trustedWorkspacePath();
      await taskController.assertCanUseTerminal(workspace);
      return terminalController.start(workspace, request);
    });
  });
  ipcMain.handle(desktopChannels.terminalWrite, async (event, request: DesktopTerminalWriteRequest) => {
    assertTrustedSender(event);
    terminalController.write(controller.trustedWorkspacePath(), request);
  });
  ipcMain.handle(desktopChannels.terminalResize, async (event, request: DesktopTerminalResizeRequest) => {
    assertTrustedSender(event);
    return terminalController.resize(controller.trustedWorkspacePath(), request);
  });
  ipcMain.handle(desktopChannels.terminalStop, async (event, request: DesktopTerminalSessionRequest) => {
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
    backgroundColor: "#f7f9fc",
    title: "Xiu",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: { color: "#fbfcfe", symbolColor: "#65758b", height: 68 },
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
  window.webContents.on("render-process-gone", () => { /* Preserve main-process state; no automatic task replay. */ });
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
    smokeMilestone("app-ready");
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    await registerLocalProtocol();
    mainWindow = createWindow();
    smokeMilestone("window-created");
  }).catch((error) => {
    smokeMilestone(`startup-error ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("before-quit", () => terminalController.stopAll("Xiu 正在退出，终端会话已结束。"));
app.on("window-all-closed", () => app.quit());
