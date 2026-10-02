import { randomUUID } from "node:crypto";
import { redactSecrets } from "../../../src/secret-redaction.js";
import { createWorkspaceAgentHost, type WorkspaceAgentHost } from "../../../src/runtime/workspace-agent-host.js";
import { listReviewFiles, previewReviewFile } from "../../../src/runtime/review.js";
import { captureTaskBaseline, getWorkspaceDiff, inspectTaskChanges, type TaskChangeSnapshot } from "../../../src/task-changes.js";
import { deleteTaskChangeHistory, loadTaskChangeHistory, saveTaskChangeHistory } from "../../../src/task-change-history.js";
import { deleteSession, loadSession } from "../../../src/session.js";
import { recoveryContinuation, TaskRunJournal, type TaskRunOperation } from "../../../src/task-run.js";
import type { DesktopApprovalMode, DesktopApprovalModeRequest, DesktopPlanModeRequest, DesktopChangeView, DesktopCheckpointRestoreRequest, DesktopFilePreviewRequest, DesktopRecoveryAbandonRequest, DesktopRecoveryRequest, DesktopReviewOperation, DesktopReviewSnapshot, DesktopTaskDeleteRequest, DesktopTaskHistoryRequest, DesktopTaskHistorySnapshot, RuntimeApprovalDecisionRequest, DesktopRuntimeConnection } from "../shared/protocol.js";
import type { RuntimeEvent } from "../../../src/runtime/protocol.js";

export type WorkspaceAgentHostFactory = (workspace: string) => Promise<WorkspaceAgentHost>;

export class DesktopTaskController {
  private disposing: Promise<void> = Promise.resolve();
  private mcpBusy = false;
  private workspace?: string;
  private host?: WorkspaceAgentHost;
  private creating?: Promise<WorkspaceAgentHost>;
  private unsubscribe?: () => void;
  private baseline?: TaskChangeSnapshot;
  private readonly taskBaselines = new Map<string, { workspace: string; baseline: TaskChangeSnapshot }>();
  private completedTaskChanges?: { taskId: string; report: Awaited<ReturnType<typeof inspectTaskChanges>> };
  private readonly runtimeEventBuffers = new Map<string, RuntimeEvent[]>();
  private eventPersistence: Promise<void> = Promise.resolve();
  private approvalMode: DesktopApprovalMode = "ask";
  private fullAccessWorkspace?: string;
  private permissionBusy = false;
  private conversationBusy = false;
  private modeContextId = randomUUID();
  private planModeOnCreate?: { workspace: string; enabled: boolean };
  private openingGeneration = 0;

  constructor(
    private readonly emit: (event: RuntimeEvent) => void,
    private readonly factory: WorkspaceAgentHostFactory = createWorkspaceAgentHost,
  ) {}

  async connect(workspace: string, afterSequence?: number): Promise<DesktopRuntimeConnection> {
    const host = await this.ensure(workspace);
    const activeHere = this.active(host);
    const lock = activeHere ? undefined : await host.journal.lockStatus();
    const conversationId = host.agent?.status?.().sessionId;
    return {
      runtime: host.runtime.connect(afterSequence),
      ...(conversationId ? { conversationId } : {}),
      provider: { ...host.provider },
      writer: activeHere ? "active-here" : lock?.active && lock.live ? "active-elsewhere" : "available",
      approvalMode: this.approvalMode,
      modeContextId: this.modeContextId,
    };
  }

  async mcpSnapshot(workspace: string) {
    const host = await this.ensure(workspace);
    if (!host.mcp) throw new Error("当前运行时不支持 MCP。");
    try { return await host.mcp.snapshot(); }
    catch { throw new Error("MCP 配置无法读取，请检查用户或项目 .xiu/mcp.json（错误详情不含凭据）。"); }
  }

  async changeMcp(workspace: string, action: "reload" | "disconnect" | "approve", request?: import("../shared/protocol.js").DesktopMcpApproveRequest) {
    await this.assertCanReconfigure(workspace);
    const host = await this.ensure(workspace);
    if (!host.mcp) throw new Error("当前运行时不支持 MCP。");
    this.mcpBusy = true;
    try {
      if (action === "approve") {
        if (request?.confirmed !== true) throw new Error("confirmation required");
        return await host.mcp.approve(request.name, request.fingerprint);
      }
      if (action === "reload") return await host.mcp.reload();
      await host.mcp.close();
      return await host.mcp.snapshot();
    } catch {
      throw new Error("MCP 操作未完成。请刷新并重新核对权限和配置。未自动重试，工具权限没有降级。");
    } finally { this.mcpBusy = false; }
  }

  async manageMcp(workspace: string, request: import("../shared/protocol.js").DesktopMcpManageRequest) {
    const host = await this.ensure(workspace);
    if (!host.mcp || !request || !["save", "delete", "login", "logout", "oauth-decision", "oauth-cancel"].includes(request.action)) throw new Error("无效的 MCP 管理请求。");
    try {
      if (request.action === "oauth-decision") { host.mcp.decideLogin(request.flowId, request.allowed); return await host.mcp.snapshot(); }
      if (request.action === "oauth-cancel") { host.mcp.cancelLogin(request.flowId); return await host.mcp.snapshot(); }
      await this.assertCanReconfigure(workspace);
      this.mcpBusy = true;
      if (request.action === "save") return await host.mcp.save(request.draft);
      if (request.action === "delete") return await host.mcp.remove(request.name, request.fingerprint, request.confirmed === true);
      if (request.action === "logout") return await host.mcp.logout(request.name, request.fingerprint, request.confirmed === true);
      if (request.action === "login") return await host.mcp.startLogin(request.name, request.fingerprint);
      throw new Error("unknown action");
    } catch {
      throw new Error("MCP 管理未完成：请刷新配置，核对字段、权限清单及当前授权状态。含明文凭据或高级配置不可在此编辑；不会覆盖变化的配置或自动重试。");
    } finally { this.mcpBusy = false; }
  }

  async browseMcp(workspace: string, request: import("../shared/protocol.js").DesktopMcpBrowseRequest) {
    await this.assertCanReconfigure(workspace);
    const host = await this.ensure(workspace);
    if (!host.mcp || !request || !/^[A-Za-z0-9_-]{1,64}$/.test(request.name) || !["resources", "read", "prompts", "prompt"].includes(request.action)) throw new Error("无效的 MCP 浏览请求。");
    this.mcpBusy = true;
    try { return await host.mcp.browse(request.name, request.action, request.value, request.args); }
    catch { throw new Error("MCP 内容未读取。请检查连接、权限与输入；不会自动重试或将外部内容执行为指令。"); }
    finally { this.mcpBusy = false; }
  }

  async setPlanMode(workspace: string, request: DesktopPlanModeRequest): Promise<DesktopRuntimeConnection> {
    if (!request || typeof request.enabled !== "boolean" || typeof request.contextId !== "string") throw new Error("Invalid Plan mode request.");
    const host = this.host;
    const assertContext = () => {
      if (!host || this.host !== host || this.workspace !== workspace || this.modeContextId !== request.contextId) {
        throw new Error("Plan 模式上下文已经变化，请刷新后重新选择。");
      }
      if (this.active(host)) throw new Error("任务或配置操作期间不能切换 Plan 模式。请等待结束。");
    };
    assertContext();
    const lock = await host!.journal.lockStatus();
    assertContext();
    if (lock.active && lock.live) throw new Error("此工作区正由另一个 Xiu 进程运行任务，暂不能切换 Plan 模式。");
    this.permissionBusy = true;
    try {
      await host!.runtime.setPlanMode(request.enabled);
      this.modeContextId = randomUUID();
    } finally { this.permissionBusy = false; }
    return this.connect(workspace, 0);
  }

  async setApprovalMode(workspace: string, request: DesktopApprovalModeRequest, confirmFullAccess?: () => Promise<boolean>): Promise<DesktopRuntimeConnection> {
    if (!request || !["ask", "workspace", "full"].includes(request.mode)) throw new Error("Invalid approval mode.");
    const host = await this.ensure(workspace);
    if (this.active(host)) throw new Error("任务运行期间不能切换权限模式。请先停止任务并等待结束。");
    let newlyConfirmed = false;
    if (request.mode === "full" && this.fullAccessWorkspace !== workspace) {
      if (!confirmFullAccess) throw new Error("完全访问需要主进程首次确认。");
      this.permissionBusy = true;
      let confirmed = false;
      try { confirmed = await confirmFullAccess(); }
      finally { this.permissionBusy = false; }
      if (this.host !== host || this.workspace !== workspace || this.active(host)) throw new Error("权限上下文已经变化，请重新选择。");
      if (!confirmed) return this.connect(workspace, 0);
      newlyConfirmed = true;
    }
    if (request.mode === "full" && !host.setApprovalMode) throw new Error("当前运行时不支持完全访问。");
    host.setApprovalMode?.(request.mode);
    this.approvalMode = request.mode;
    if (newlyConfirmed) this.fullAccessWorkspace = workspace;
    return this.connect(workspace, 0);
  }

  async createTask(workspace: string, text: string): Promise<DesktopRuntimeConnection> {
    if (this.mcpBusy || this.permissionBusy) throw new Error("配置或权限正在确认，请等待完成后再启动任务。");
    const normalized = this.taskText(text);
    const host = await this.ensure(workspace);
    if (host.mcp?.busy) throw new Error("请先完成或取消 MCP 登录，再启动任务。");
    if (this.active(host)) throw new Error("已有任务正在运行，不能重复启动任务。");
    if (host.providerConfigured === false) throw new Error("尚未配置渠道，请先在设置与模型中新增渠道。");
    const lock = await host.journal.lockStatus();
    if (lock.active && lock.live && !this.active(host)) throw new Error("此工作区正由另一个 Xiu 进程写入。请先停止该任务或选择其他工作区。");
    this.completedTaskChanges = undefined;
    this.baseline = await captureTaskBaseline(workspace);
    this.modeContextId = randomUUID();
    void host.runtime.createTask(normalized).catch(() => undefined);
    return this.connect(workspace, 0);
  }

  async continueTask(workspace: string, taskId: string, text: string): Promise<DesktopRuntimeConnection> {
    const normalized = this.taskText(text);
    if (!/^[A-Za-z0-9-]{1,160}$/.test(taskId)) throw new Error("Invalid task history request.");
    const host = await this.ensure(workspace);
    if (host.providerConfigured === false) throw new Error("尚未配置渠道，请先在设置与模型中新增渠道。");
    if (this.active(host)) throw new Error("已有任务正在运行。");
    const lock = await host.journal.lockStatus();
    if (lock.active && lock.live) throw new Error("此工作区正由另一个 Xiu 进程写入。请先停止该任务或选择其他工作区。");
    if (!host.agent) throw new Error("当前运行时不支持继续历史任务。");
    const runs = await host.journal.recent(500);
    const selectedRun = runs.find((run) => run.runId === taskId);
    const restored = await loadSession(workspace, selectedRun?.sessionId ?? taskId);
    host.agent.restoreSession(restored, { preservePlanMode: true });
    this.modeContextId = randomUUID();
    await host.agent.setModel(host.provider.model);
    host.runtime.resetConversation();
    host.checkpointManager?.setSession(restored.id);
    this.completedTaskChanges = undefined;
    this.baseline = await captureTaskBaseline(workspace);
    this.modeContextId = randomUUID();
    void host.runtime.createTask(normalized).catch(() => undefined);
    return this.connect(workspace, 0);
  }

  async newConversation(workspace: string): Promise<DesktopRuntimeConnection> {
    const host = await this.ensure(workspace);
    const contextId = this.modeContextId;
    if (this.active(host)) throw new Error("任务运行期间不能新建对话。请先停止任务并等待结束。");
    const lock = await host.journal.lockStatus();
    this.assertIdleContext(host, workspace, contextId);
    if (lock.active && lock.live) throw new Error("此工作区正由另一个 Xiu 进程写入，暂不能新建对话。");
    host.agent?.clearConversation({ preservePlanMode: true });
    this.modeContextId = randomUUID();
    host.runtime.resetConversation();
    this.baseline = undefined;
    this.completedTaskChanges = undefined;
    this.taskBaselines.clear();
    return this.connect(workspace, 0);
  }

  async steerTask(workspace: string, text: string): Promise<boolean> {
    return (await this.ensure(workspace)).runtime.steerTask(this.taskText(text));
  }

  async stopTask(workspace: string): Promise<boolean> {
    return (await this.ensure(workspace)).runtime.stopTask();
  }

  async decideApproval(workspace: string, request: RuntimeApprovalDecisionRequest): Promise<void> {
    if (!request || typeof request.approvalId !== "string" || request.approvalId.length > 100 || typeof request.allowed !== "boolean") {
      throw new Error("Invalid approval decision.");
    }
    if (request.rememberForSession !== undefined && request.rememberForSession !== true) throw new Error("Invalid session approval decision.");
    (await this.ensure(workspace)).runtime.decideApproval(request.approvalId, request.allowed, request.confirmedRisk, request.rememberForSession);
  }

  async openTaskHistory(workspace: string, request: DesktopTaskHistoryRequest): Promise<DesktopTaskHistorySnapshot> {
    if (!request || typeof request.taskId !== "string" || !/^[A-Za-z0-9-]{1,160}$/.test(request.taskId)) throw new Error("Invalid task history request.");
    const host = await this.ensure(workspace);
    await this.eventPersistence;
    const allRuns = await host.journal.recent(500);
    const selectedRun = allRuns.find((run) => run.runId === request.taskId);
    const sessionId = selectedRun?.sessionId ?? request.taskId;
    const runs = allRuns.filter((item) => item.sessionId === sessionId).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const run = runs.at(-1);
    const session = await loadSession(workspace, sessionId);
    const clean = (value: string, maximum = 32_000) => [...redactSecrets(value).trim()].slice(0, maximum).join("");
    const entries: DesktopTaskHistorySnapshot["entries"] = [];
    const push = (kind: DesktopTaskHistorySnapshot["entries"][number]["kind"], title: string, text: string) => {
      const safe = clean(text);
      if (safe) entries.push({ id: `${session.id}-${entries.length + 1}`, kind, title, text: safe });
    };
    for (const turn of session.replay) {
      push("user", turn.inputKind === "system" ? "系统续接" : "你", turn.task);
      for (const supplement of turn.supplements) push("user", "你 · 补充要求", supplement);
      for (const receipt of turn.receipts) push("activity", "运行记录", receipt);
      if (turn.changes.length) push("activity", "工作区变更", `${turn.changes.reduce((sum, change) => sum + change.files.length, 0)} 个文件变更`);
      if (turn.response) push("assistant", "Xiu", turn.response);
      if (turn.question) push("assistant", "Xiu · 等待回答", turn.question);
      if (turn.completion && turn.completion.message !== turn.response) push("completion", turn.completion.success ? "已完成" : "未完成", turn.completion.message);
    }
    if (!entries.length) {
      for (const message of session.messages) {
        if (message.role === "user") push("user", "你", message.content);
        else if (message.role === "assistant") push("assistant", "Xiu", message.content);
      }
    }
    const completeEventHistory = runs.length > 0 && runs.every((item) => (item.runtimeEvents?.length ?? 0) > 0);
    const exactEvents = completeEventHistory ? this.combineHistoryEvents(runs) : [];
    const reconstructed = exactEvents.length ? [] : runs.flatMap((item, index) => this.reconstructHistoryEvents(item, index === runs.length - 1 ? entries : []));
    let changes;
    const changeRounds = await Promise.all(runs.slice(-80).map(async (candidate) => ({ id: candidate.runId, startedAt: candidate.startedAt, report: await loadTaskChangeHistory(workspace, candidate.runId) })));
    for (const candidate of [...runs].reverse()) {
      changes = await loadTaskChangeHistory(workspace, candidate.runId);
      if (changes) break;
    }
    return {
      taskId: session.id,
      title: clean(session.replay[0]?.task ?? run?.taskPreview ?? "历史任务", 160),
      status: run?.status ?? "session",
      updatedAt: run?.updatedAt ?? session.updatedAt,
      ...(run?.providerId ?? session.providerId ? { providerId: run?.providerId ?? session.providerId } : {}),
      ...(run?.model ?? session.model ? { model: run?.model ?? session.model } : {}),
      entries: entries.slice(-200),
      events: exactEvents.length ? exactEvents.slice(-1_000) : reconstructed,
      fidelity: exactEvents.length ? "exact" : "reconstructed",
      changeRounds,
      ...(changes ? { changes } : {}),
      tools: runs.flatMap((item) => item.operations.filter((operation) => operation.kind === "tool").map((operation) => this.operation(operation, "command"))).slice(-80),
      validations: runs.flatMap((item) => item.operations.filter((operation) => operation.kind === "verification").map((operation) => this.operation(operation, "verification"))).slice(-80),
    };
  }

  async deleteTask(workspace: string, request: DesktopTaskDeleteRequest, confirmed: boolean): Promise<void> {
    if (!confirmed || request?.confirmed !== true || typeof request.taskId !== "string" || !/^[A-Za-z0-9-]{1,160}$/.test(request.taskId)) {
      throw new Error("删除任务需要主进程确认。");
    }
    const host = await this.ensure(workspace);
    const contextId = this.modeContextId;
    if (this.active(host)) throw new Error("任务运行期间不能删除任务。请先停止任务并等待结束。");
    const lock = await host.journal.lockStatus();
    this.assertIdleContext(host, workspace, contextId);
    if (lock.active && lock.live) throw new Error("此工作区正由另一个 Xiu 进程运行任务，暂不能删除任务。");
    this.conversationBusy = true;
    try {
      await this.eventPersistence;
      const runs = await host.journal.recent(500);
      const selectedRun = runs.find((run) => run.runId === request.taskId);
      const sessionId = selectedRun?.sessionId ?? request.taskId;
      const relatedRuns = runs.filter((run) => run.sessionId === sessionId);
      const sessionDeleted = await deleteSession(workspace, sessionId);
      if (!selectedRun && !sessionDeleted) throw new Error("任务不存在或已经删除。");
      for (const run of relatedRuns) {
        await deleteTaskChangeHistory(workspace, run.runId);
        await host.journal.delete(run.runId);
      }
      if (host.agent?.status?.().sessionId === sessionId) {
        host.agent.clearConversation({ preservePlanMode: true });
        this.modeContextId = randomUUID();
        host.runtime.resetConversation();
        this.baseline = undefined;
        this.completedTaskChanges = undefined;
        this.taskBaselines.clear();
      }
    } finally { this.conversationBusy = false; }
  }

  async reviewSnapshot(workspace: string, changeView: DesktopChangeView = "task"): Promise<DesktopReviewSnapshot> {
    if (!(["task", "workspace", "staged"] as string[]).includes(changeView)) throw new Error("Invalid change view.");
    const host = await this.ensure(workspace);
    await this.eventPersistence;
    const currentTaskId = host.runtime.snapshot().task?.id;
    const completed = this.completedTaskChanges;
    const completedReport = completed && completed.taskId === currentTaskId ? completed.report : undefined;
    const [changes, files, latest, interrupted, checkpoints] = await Promise.all([
      changeView === "task" && this.baseline
        ? inspectTaskChanges(workspace, this.baseline)
        : changeView === "task" && completedReport
          ? Promise.resolve(structuredClone(completedReport))
          : getWorkspaceDiff(workspace, changeView === "staged" ? "staged" : "workspace"),
      listReviewFiles(workspace),
      Promise.resolve(host.journal.currentRun()).then((run) => run ?? host.journal.latest()),
      host.journal.interrupted(),
      host.checkpointManager?.list() ?? Promise.resolve([]),
    ]);
    if (changeView === "task" && !this.baseline && this.completedTaskChanges?.taskId !== currentTaskId) changes.warnings = ["no-task-baseline: no in-memory baseline is available; showing current workspace changes.", ...changes.warnings];
    const operations = latest?.operations ?? [];
    const taskReport = changeView === "task" && (this.baseline || completedReport) ? changes : this.baseline ? await inspectTaskChanges(workspace, this.baseline) : completedReport;
    const commands = operations.filter((operation) => operation.kind === "tool" && ["run_command", "run_process"].includes(operation.name)).map((operation) => this.operation(operation, "command"));
    const validations = operations.filter((operation) => operation.kind === "verification").map((operation) => this.operation(operation, "verification"));
    const related = latest ? (await host.journal.recent(500)).filter((run) => run.sessionId === latest.sessionId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-80) : [];
    const changeRounds = await Promise.all(related.map(async (run) => ({ id: run.runId, startedAt: run.startedAt, report: await loadTaskChangeHistory(workspace, run.runId) })));
    return {
      changeRounds,
      generatedAt: new Date().toISOString(), changeView, changes, files,
      artifacts: (taskReport?.changes ?? []).filter((entry) => ["created", "modified"].includes(entry.kind)).map(({ path, kind }) => ({ path, kind })),
      background: host.background?.().map((item) => ({ ...item, command: redactSecrets(item.command).slice(0, 240) })) ?? [],
      tools: operations.filter((operation) => operation.kind === "tool").slice(-80).reverse().map((operation) => this.operation(operation, "command")),
      commands: commands.slice(-80).reverse(), validations: validations.slice(-80).reverse(),
      checkpoints: checkpoints.slice(0, 80).map((checkpoint) => structuredClone(checkpoint)),
      ...(latest ? { run: { id: latest.runId, status: latest.status, startedAt: latest.startedAt, updatedAt: latest.updatedAt, ...(latest.finishedAt ? { finishedAt: latest.finishedAt } : {}) } } : {}),
      ...(interrupted ? { recovery: {
        runId: interrupted.runId,
        taskPreview: interrupted.taskPreview,
        status: interrupted.status === "paused" ? "paused" : "recoverable",
        recommendation: interrupted.recommendation,
        unknownOperations: interrupted.interruptedOperations.map((operation) => this.operation(operation, operation.kind === "verification" ? "verification" : "command")),
        ...(interrupted.recoveryPoints.at(-1) ? { lastRecoveryPoint: {
          at: interrupted.recoveryPoints.at(-1)!.at,
          kind: interrupted.recoveryPoints.at(-1)!.kind,
          evidence: interrupted.recoveryPoints.at(-1)!.evidence,
        } } : {}),
      } } : {}),
    };
  }

  async previewFile(workspace: string, request: DesktopFilePreviewRequest) {
    if (!request || typeof request.path !== "string") throw new Error("Invalid file preview request.");
    return previewReviewFile(workspace, request.path);
  }

  async restoreCheckpoint(workspace: string, request: DesktopCheckpointRestoreRequest, confirmed: boolean): Promise<DesktopReviewSnapshot> {
    if (!confirmed || !request || typeof request.checkpointId !== "string" || request.checkpointId.length > 160) throw new Error("恢复检查点需要主进程确认。");
    const host = await this.ensure(workspace);
    if (this.active(host)) throw new Error("任务运行期间不能恢复检查点。请先停止任务并等待结束。");
    const manager = host.checkpointManager;
    if (!manager) throw new Error("当前运行时不支持检查点恢复。");
    const selected = (await manager.list()).find((checkpoint) => checkpoint.id === request.checkpointId);
    if (!selected) throw new Error("检查点不存在或已过期。");
    for (const file of selected.files) await manager.capture("write_file", { path: file.path }, `恢复 ${selected.id} 前的安全检查点`);
    await manager.restore(selected.id);
    return this.reviewSnapshot(workspace, "workspace");
  }

  async recoverTask(workspace: string, request: DesktopRecoveryRequest, unknownSideEffectsConfirmed: boolean): Promise<DesktopRuntimeConnection> {
    if (!request || typeof request.runId !== "string" || request.runId.length > 100) throw new Error("Invalid recovery request.");
    const host = await this.ensure(workspace);
    if (host.providerConfigured === false) throw new Error("尚未配置渠道，请先在设置与模型中新增渠道。");
    if (this.active(host)) throw new Error("已有任务正在运行。");
    const interrupted = await host.journal.interrupted();
    if (!interrupted || interrupted.runId !== request.runId) throw new Error("恢复记录不存在、仍由其他进程持有或已经变化。");
    host.runtime.assertRecoveryConfirmed(request.runId, unknownSideEffectsConfirmed);
    if (!host.agent) throw new Error("当前运行时不支持任务恢复。");
    const restored = await loadSession(workspace, interrupted.sessionId);
    host.agent.restoreSession(restored, { preservePlanMode: true });
    this.modeContextId = randomUUID();
    host.agent.setRecoverySource(interrupted);
    host.checkpointManager?.setSession(interrupted.sessionId);
    this.baseline = await captureTaskBaseline(workspace);
    this.completedTaskChanges = undefined;
    void host.runtime.createTask(recoveryContinuation(interrupted, "zh-CN")).catch(() => undefined);
    return this.connect(workspace, 0);
  }

  async abandonRecovery(workspace: string, request: DesktopRecoveryAbandonRequest, confirmed: boolean): Promise<DesktopReviewSnapshot> {
    if (!confirmed || !request || typeof request.runId !== "string") throw new Error("放弃恢复需要主进程确认。");
    const host = await this.ensure(workspace);
    if (this.active(host)) throw new Error("已有任务正在运行。");
    const interrupted = await host.journal.interrupted();
    if (!interrupted || interrupted.runId !== request.runId) throw new Error("恢复记录不存在或已经变化。");
    await host.journal.abandon(request.runId, "abandoned by desktop user");
    host.runtime.abandonRecovery(request.runId);
    return this.reviewSnapshot(workspace, "workspace");
  }

  /** Read-only identity for native recovery previews, including failed host startup. */
  recoveryContextId(): string { return this.modeContextId; }

  canChangeWorkspace(): boolean {
    return !this.creating && !this.mcpBusy && !this.permissionBusy && (!this.host || !this.active(this.host));
  }

  async assertCanReconfigure(workspace: string): Promise<void> {
    const host = await this.ensure(workspace);
    const contextId = this.modeContextId;
    if (this.active(host)) throw new Error("任务运行期间不能切换 Provider、模型或凭据。请先停止任务并等待结束。");
    const lock = await host.journal.lockStatus();
    this.assertIdleContext(host, workspace, contextId);
    if (lock.active && lock.live) throw new Error("此工作区正由另一个 Xiu 进程运行任务，暂不能更改 Provider 配置。");
  }

  async assertCanUseTerminal(workspace: string): Promise<void> {
    if (this.workspace && this.workspace !== workspace && !this.canChangeWorkspace()) throw new Error("任务运行期间不能启动交互终端。请先停止任务并等待结束。");
    const host = this.workspace === workspace ? this.host ?? await this.creating : undefined;
    if (host && this.active(host)) throw new Error("任务运行期间不能启动交互终端。请先停止任务并等待结束。");
    const lock = await (host?.journal ?? new TaskRunJournal(workspace)).lockStatus();
    if (lock.active && lock.live) throw new Error("此工作区正由另一个 Xiu 进程运行任务，暂不能启动交互终端。");
  }

  async reload(workspace: string): Promise<DesktopRuntimeConnection> {
    const host = await this.ensure(workspace);
    const contextId = this.modeContextId;
    await this.assertCanReconfigure(workspace);
    this.assertIdleContext(host, workspace, contextId);
    const planMode = host.runtime.snapshot().planMode === true;
    this.detach(); // Always discard Full Access and the old host/context.
    // Reconfiguring the same open workspace must not silently leave read-only
    // mode. Apply it before the replacement host is visible to any caller.
    this.planModeOnCreate = { workspace, enabled: planMode };
    return this.connect(workspace, 0);
  }

  detach(): void {
    if (!this.canChangeWorkspace()) throw new Error("任务仍在运行，请先停止并等待任务结束。");
    const previous = this.host;
    this.disposing = this.disposing.then(async () => { await previous?.close?.(); });
    void this.disposing.catch(() => undefined); // Preserve failure for ensure(), avoid unhandled rejection on close.
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.workspace = undefined;
    this.host = undefined;
    this.approvalMode = "ask";
    this.planModeOnCreate = undefined;
    this.openingGeneration++;
    this.modeContextId = randomUUID();
    this.fullAccessWorkspace = undefined;
    this.creating = undefined;
    this.baseline = undefined;
    this.completedTaskChanges = undefined;
    this.taskBaselines.clear();
  }

  private async ensure(workspace: string): Promise<WorkspaceAgentHost> {
    if (this.workspace && this.workspace !== workspace) this.detach();
    const generation = this.openingGeneration;
    await this.disposing;
    if (generation !== this.openingGeneration || (this.workspace && this.workspace !== workspace)) {
      throw new Error("运行时工作区上下文已经变化，请重新连接。");
    }
    if (this.host) return this.host;
    if (!this.creating) {
      this.workspace = workspace;
      this.creating = this.factory(workspace).then(async (host) => {
        try {
          if (this.planModeOnCreate?.workspace === workspace && this.planModeOnCreate.enabled) await host.runtime.setPlanMode(true);
        } catch (error) {
          await host.close?.();
          throw error; // Fail closed rather than expose an executable replacement.
        }
        this.host = host;
        host.setApprovalMode?.(this.approvalMode);
        this.unsubscribe = host.runtime.subscribe((event) => {
          this.captureRuntimeEvent(host, event);
          this.emit(event);
        });
        return host;
      }).finally(() => { this.creating = undefined; });
    }
    return this.creating;
  }

  private assertIdleContext(host: WorkspaceAgentHost, workspace: string, contextId: string): void {
    if (this.host !== host || this.workspace !== workspace || this.modeContextId !== contextId) {
      throw new Error("对话上下文已经变化，请刷新后重试。");
    }
    if (this.active(host)) throw new Error("任务或配置操作期间不能修改对话。请等待结束。");
  }

  private active(host: WorkspaceAgentHost): boolean {
    return this.mcpBusy || this.permissionBusy || this.conversationBusy || Boolean(host.mcp?.busy) || ["running", "waiting_approval", "stopping"].includes(host.runtime.snapshot().task?.state ?? "");
  }

  async shutdown(): Promise<void> {
    const host = this.host ?? await this.creating;
    await host?.close?.();
    await this.disposing;
  }

  private taskText(text: string): string {
    if (typeof text !== "string") throw new Error("Task text must be a string.");
    const normalized = text.trim();
    if (!normalized || [...normalized].length > 20_000) throw new Error("Task text must contain 1-20000 characters.");
    return redactSecrets(normalized);
  }

  private operation(operation: TaskRunOperation, kind: DesktopReviewOperation["kind"]): DesktopReviewOperation {
    const started = Date.parse(operation.startedAt);
    const finished = operation.finishedAt ? Date.parse(operation.finishedAt) : Number.NaN;
    return {
      id: operation.id, kind, name: operation.name, status: operation.status, sideEffect: operation.sideEffect,
      ...(operation.risk ? { risk: operation.risk } : {}), startedAt: operation.startedAt,
      ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
      ...(Number.isFinite(started) && Number.isFinite(finished) ? { durationMs: Math.max(0, finished - started) } : {}),
      ...(operation.evidence ? { evidence: redactSecrets(operation.evidence).slice(0, 2_000) } : {}),
    };
  }

  private captureRuntimeEvent(host: WorkspaceAgentHost, event: RuntimeEvent): void {
    const events = this.runtimeEventBuffers.get(event.taskId) ?? [];
    events.push(structuredClone(event));
    if (events.length > 1_000) events.splice(0, events.length - 1_000);
    this.runtimeEventBuffers.set(event.taskId, events);
    if (event.type === "task.started" && this.workspace && this.baseline) {
      this.taskBaselines.set(event.taskId, { workspace: this.workspace, baseline: this.baseline });
      return;
    }
    if (event.type !== "task.finished") return;
    const owned = this.taskBaselines.get(event.taskId);
    const baseline = owned?.baseline ?? this.baseline;
    const workspace = owned?.workspace ?? this.workspace;
    const sessionId = host.agent?.status?.().sessionId;
    this.eventPersistence = this.eventPersistence.then(async () => {
      try {
        const runs = await host.journal.recent(500);
        const run = runs.find((candidate) => candidate.status !== "running"
          && (!sessionId || candidate.sessionId === sessionId)
          && (!candidate.finishedAt || candidate.finishedAt <= event.timestamp));
        if (run) {
          await host.journal.saveRuntimeEvents(run.runId, events).catch(() => undefined);
          if (workspace && baseline) {
            const report = await inspectTaskChanges(workspace, baseline);
            await saveTaskChangeHistory(workspace, run.runId, report);
            if (this.workspace === workspace && host.runtime.snapshot().task?.id === event.taskId) {
              this.completedTaskChanges = { taskId: event.taskId, report };
            }
          }
        }
      } finally {
        this.runtimeEventBuffers.delete(event.taskId);
        this.taskBaselines.delete(event.taskId);
        if (this.baseline === baseline) this.baseline = undefined;
      }
    }).catch(() => undefined);
  }

  private combineHistoryEvents(runs: Array<NonNullable<Awaited<ReturnType<WorkspaceAgentHost["journal"]["read"]>>>>): RuntimeEvent[] {
    let sequence = 0;
    return runs.flatMap((run) => (run.runtimeEvents ?? [])
      .filter((event) => event && event.schemaVersion === 1)
      .map((event) => ({
        ...structuredClone(event),
        taskId: run.sessionId,
        sequence: ++sequence,
      } as RuntimeEvent))).slice(-1_000);
  }

  private reconstructHistoryEvents(run: Awaited<ReturnType<WorkspaceAgentHost["journal"]["read"]>>, entries: DesktopTaskHistorySnapshot["entries"]): RuntimeEvent[] {
    if (!run) return [];
    const events: RuntimeEvent[] = [];
    let sequence = 0;
    let cursor = Date.parse(run.startedAt);
    const timestamp = () => new Date(Number.isFinite(cursor) ? cursor++ : Date.now()).toISOString();
    const push = <K extends RuntimeEvent["type"]>(type: K, payload: Extract<RuntimeEvent, { type: K }>["payload"], at?: string) => {
      sequence++;
      events.push({ schemaVersion: 1, eventId: `history-${run.runId}-${sequence}`, taskId: run.runId, sequence, timestamp: at ?? timestamp(), type, payload } as RuntimeEvent);
    };
    push("task.started", { taskPreview: run.taskPreview }, run.startedAt);
    let modelTurn = 0;
    for (const operation of run.operations) {
      if (operation.kind === "model") {
        modelTurn++;
        push("model.started", { turn: modelTurn }, operation.startedAt);
        push("model.finished", {}, operation.finishedAt);
      } else if (operation.kind === "checkpoint") {
        push("runtime.notice", { kind: "checkpoint", message: operation.evidence ?? operation.name }, operation.finishedAt ?? operation.startedAt);
      } else if (operation.kind === "steering") {
        push("runtime.notice", { kind: "checkpoint", message: operation.evidence ?? "补充要求已记录" }, operation.finishedAt ?? operation.startedAt);
      } else {
        const verification = operation.kind === "verification";
        push("tool.started", { name: operation.name, description: operation.evidence ?? operation.name, changesWorkspace: operation.sideEffect === "workspace", verification, risk: operation.risk ?? "read" }, operation.startedAt);
        if (operation.finishedAt) push("tool.finished", { name: operation.name, summary: operation.evidence ?? operation.status, verification }, operation.finishedAt);
      }
    }
    for (const entry of entries) {
      if (entry.kind === "assistant") push("assistant.message", { text: entry.text, hasToolCalls: false });
      else if (entry.kind === "user" && entry.title.includes("补充")) push("task.steered", { text: entry.text });
    }
    const state = run.status === "abandoned" ? "cancelled" : run.status;
    const completion = [...entries].reverse().find((entry) => entry.kind === "completion")?.text;
    if (state !== "running") push("task.finished", { state, ...(completion ? { result: completion } : {}) }, run.finishedAt ?? run.updatedAt);
    return events;
  }
}
