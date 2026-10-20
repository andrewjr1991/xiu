import { useEffect, useMemo, useRef, useState } from "react";
import { defaultPreferences, type DesktopPreferences } from "../../shared/preferences.js";
import { applyRuntimeEvent, type DesktopApprovalMode, type DesktopAttachment, type DesktopAttachmentResult, type DesktopChangeView, type DesktopMcpBrowseRequest, type DesktopMcpManageRequest, type DesktopProviderCapability, type DesktopProviderProfile, type DesktopProviderSnapshot, type DesktopProviderUpsertRequest, type DesktopReviewSnapshot, type DesktopReviewTab, type DesktopRuntimeConnection, type DesktopTaskHistorySnapshot, type DesktopWorkspaceSnapshot, type ReviewFilePreview, type RuntimeEvent, type WorkspaceMcpSnapshot, type XiuRuntimeSnapshot } from "../../shared/protocol.js";
import type { DesktopProviderRecoveryRequest, DesktopProviderRecoverySnapshot } from "../../shared/provider-recovery.js";
import { ManagementPanel } from "./ManagementPanel.js";
import { McpPanel } from "./McpPanel.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import { ResizableTaskLayout } from "./ResizableTaskLayout.js";
import { ReviewInspector } from "./ReviewInspector.js";
import { SettingsPage } from "./SettingsPage.js";
import { TimelineNavigator } from "./TimelineNavigator.js";
import { activeStates, ActiveTaskStatus, type ChangeEntry, ChangeSummaryCard, EditableAttachmentTiles, HistoryTimeline, Logo, stateLabels, TaskTimeline } from "./TaskTimeline.js";
import { UserQuestion } from "./UserQuestion.js";
import { WorkspaceToolbar } from "./WorkspaceToolbar.js";
import { createComposerEnterGuard } from "./composer-enter-guard.js";
import { applyAppearance, PreferencesContext } from "./preferences.js";
import { selectedTaskView } from "./subagent-presentation.js";
import { mergeRuntimeEvents } from "./task-presentation.js";
import { safeSourceUrl } from "./text-presentation.js";
import { useOutputFollow } from "./use-output-follow.js";

const emptyWorkspace: DesktopWorkspaceSnapshot = { bridgeVersion: 1, trust: "none", recent: [], tasks: [] };

function latestPlan(events: RuntimeEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "plan.updated") return event.payload.plan;
  }
  return undefined;
}

const approvalModeDetails: Record<DesktopApprovalMode, { label: string; description: string; icon: string }> = {
  ask: { label: "请求批准", description: "写入、执行和联网操作前请求批准", icon: "♙" },
  workspace: { label: "帮我批准", description: "自动批准非危险操作；检测到危险时询问", icon: "◇" },
  full: { label: "完全访问权限", description: "访问本机文件和网络；危险操作也自动执行", icon: "◈" },
};

function ConfirmationDialog({ kind, name, busy, onCancel, onConfirm }: { kind: "task" | "workspace"; name: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const deletingTask = kind === "task";
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-detail">
      <div className={`confirmation-icon ${deletingTask ? "danger" : "neutral"}`}>{deletingTask ? "⌫" : "−"}</div>
      <div className="confirmation-copy"><span className="eyebrow">{deletingTask ? "删除任务" : "移出最近项目"}</span><h2 id="confirmation-title">{deletingTask ? "确定删除这项任务？" : "确定移出这个工作区？"}</h2><p className="confirmation-name">{name}</p><p id="confirmation-detail">{deletingTask ? "会话和运行记录将被永久删除；项目文件与恢复点不会受到影响。" : "只会从最近项目中移除，磁盘目录和项目文件不会被删除。"}</p></div>
      <footer><button className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className={deletingTask ? "danger-button" : "primary-button compact"} disabled={busy} onClick={onConfirm}>{busy ? "正在处理…" : deletingTask ? "删除任务" : "确认移除"}</button></footer>
    </section>
  </div>;
}

export function App({ initialPreferences = defaultPreferences }: { initialPreferences?: DesktopPreferences }) {
  const [preferences, setPreferences] = useState<DesktopPreferences>(initialPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    applyAppearance(preferences);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyAppearance(preferences);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preferences]);
  const [providerRecoveryOpen, setProviderRecoveryOpen] = useState(false);
  const [providerRecovery, setProviderRecovery] = useState<DesktopProviderRecoverySnapshot>();
  const [providerRecoveryError, setProviderRecoveryError] = useState<string>();
  const providerRestartRequired = providerRecovery?.restartRequired === true;
  const [mcpOpen, setMcpOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [mcpSnapshot, setMcpSnapshot] = useState<WorkspaceMcpSnapshot>();
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [connection, setConnection] = useState<DesktopRuntimeConnection>();
  const [runtime, setRuntime] = useState<XiuRuntimeSnapshot>();
  const runtimeRef = useRef<XiuRuntimeSnapshot | undefined>(undefined);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [draft, setDraft] = useState<string>();
  const [pendingMessage, setPendingMessage] = useState<{ text: string; timestamp: string; steering: boolean; attachments: DesktopAttachment[] }>();
  const [historyView, setHistoryView] = useState<DesktopTaskHistorySnapshot>();
  const historyViewRef = useRef<DesktopTaskHistorySnapshot | undefined>(undefined);
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [submittedAttachments, setSubmittedAttachments] = useState<Record<string, DesktopAttachment[]>>({});
  const pendingAttachmentsRef = useRef<DesktopAttachment[] | undefined>(undefined);
  const [input, setInput] = useState("");
  const [composerEnterGuard] = useState(() => createComposerEnterGuard());
  const [busy, setBusy] = useState(false);
  const submitPendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const [review, setReview] = useState<DesktopReviewSnapshot>();
  const [taskCompletionChanges, setTaskCompletionChanges] = useState<DesktopReviewSnapshot["changes"]>();
  const [selectedDiff, setSelectedDiff] = useState<ChangeEntry>();
  const openDiff = (entry: ChangeEntry) => { setSelectedDiff(entry); setReviewTab("changes"); };
  const [reviewTab, setReviewTab] = useState<DesktopReviewTab>("changes");
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(false);
  const [overviewHidden, setOverviewHidden] = useState(false);
  useEffect(() => {
    const openSource = (event: Event) => {
      const href = safeSourceUrl(String((event as CustomEvent).detail ?? ""));
      if (!href) return;
      setWorkbenchCollapsed(false); setReviewTab("web");
      void window.xiuDesktop.browser({ action: "navigate", url: href }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    };
    window.addEventListener("xiu-open-source", openSource);
    const inspectAgents = () => { setWorkbenchCollapsed(false); setReviewTab("agents"); };
    window.addEventListener("xiu-inspect-agents", inspectAgents);
    return () => { window.removeEventListener("xiu-open-source", openSource); window.removeEventListener("xiu-inspect-agents", inspectAgents); };
  }, []);
  const [changeView, setChangeView] = useState<DesktopChangeView>("task");
  const changeViewRef = useRef<DesktopChangeView>("task");
  const [filePreview, setFilePreview] = useState<ReviewFilePreview>();
  const [previewMode, setPreviewMode] = useState<"source" | "preview">("source");
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerPlacement, setProviderPlacement] = useState<"composer" | "settings">("composer");
  const [providerSettings, setProviderSettings] = useState<DesktopProviderSnapshot>();
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [credentialEditing, setCredentialEditing] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [providerNotice, setProviderNotice] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: "task" | "workspace"; id: string; name: string }>();
  const taskScrollRef = useRef<HTMLDivElement>(null);
  const outputFollow = useOutputFollow(taskScrollRef, workspace.trust, preferences.autoFollow);

  const refreshRuntime = async (afterSequence = 0) => {
    const next = await window.xiuDesktop.runtimeConnect({ afterSequence });
    setConnection(next);
    setRuntime(next.runtime.snapshot);
    runtimeRef.current = next.runtime.snapshot;
    if (afterSequence === 0 || next.runtime.resyncRequired) setEvents(next.runtime.events.slice(-1_000));
    else if (next.runtime.events.length) setEvents((old) => mergeRuntimeEvents(old, next.runtime.events));
  };

  const refreshReview = async (view = changeViewRef.current) => {
    const next = await window.xiuDesktop.reviewSnapshot({ changeView: view });
    setReview(next);
  };
  const refreshAcceptance = () => {
    void window.xiuDesktop.snapshot().then(setWorkspace).catch(reason => setError(String(reason)));
    void refreshReview().catch(reason => setError(String(reason)));
    const history = historyViewRef.current;
    if (history) void window.xiuDesktop.openTaskHistory({ taskId: history.taskId }).then(value => { if (historyViewRef.current === history) setHistoryView(value); }).catch(reason => setError(String(reason)));
  };

  useEffect(() => {
    void window.xiuDesktop.snapshot().then(setWorkspace).catch((reason) => setError(String(reason)));
    const offWorkspace = window.xiuDesktop.onSnapshot(setWorkspace);
    const offRuntime = window.xiuDesktop.onRuntimeEvent((event) => {
      if ((event.type === "task.started" || event.type === "task.steered") && pendingAttachmentsRef.current) {
        const owned = pendingAttachmentsRef.current;
        setSubmittedAttachments(old => ({ ...old, [event.eventId]: owned }));
        pendingAttachmentsRef.current = undefined;
      }
      if (event.type === "task.started" || event.type === "task.steered") setPendingMessage(undefined);
      if (event.type === "task.started") { setTaskCompletionChanges(undefined); setSelectedDiff(undefined); }
      if (event.type === "assistant.draft") setDraft(event.payload.text);
      if (event.type === "assistant.stream-end" || event.type === "assistant.message" || event.type === "task.finished") setDraft(undefined);
      setEvents((old) => event.type === "assistant.draft" || event.type === "assistant.stream-end" ? old : mergeRuntimeEvents(old, [event]));
      try {
        if (!runtimeRef.current) throw new Error("runtime unavailable");
        const next = applyRuntimeEvent(runtimeRef.current, event);
        runtimeRef.current = next;
        setRuntime(next);
      } catch {
        void refreshRuntime(0).catch((reason) => setError(String(reason)));
      }
      if (["tool.finished", "workspace.changed", "task.finished", "plan.updated", "recovery.detected"].includes(event.type)) {
        void refreshReview().catch((reason) => setError(String(reason)));
      }
      if (event.type === "task.finished") {
        const selectedHistory = historyViewRef.current;
        void Promise.all([
          window.xiuDesktop.snapshot().then(setWorkspace), refreshRuntime(0),
          window.xiuDesktop.reviewSnapshot({ changeView: "task" }).then((snapshot) => {
            setTaskCompletionChanges(snapshot.changes);
            if (changeViewRef.current === "task") setReview(snapshot);
          }),
          selectedHistory ? window.xiuDesktop.openTaskHistory({ taskId: selectedHistory.taskId }).then((next) => {
            if (historyViewRef.current === selectedHistory) setHistoryView(next);
          }) : Promise.resolve(),
        ]).catch((reason) => setError(String(reason)));
      }
    });
    return () => { offWorkspace(); offRuntime(); };
  }, []);

  useEffect(() => {
    setManagementOpen(false);
    if (workspace.trust !== "trusted") {
      setConnection(undefined); setRuntime(undefined); runtimeRef.current = undefined; setEvents([]); setDraft(undefined); setPendingMessage(undefined); setHistoryView(undefined); setReview(undefined); setTaskCompletionChanges(undefined); setSelectedDiff(undefined); setFilePreview(undefined); setProviderOpen(false); setProviderSettings(undefined); setCredentialEditing(undefined); setApiKey(""); return;
    }
    void Promise.all([refreshRuntime(0), refreshReview()]).catch((reason) => setError(String(reason)));
  }, [workspace.trust, workspace.workspace?.id]);

  useEffect(() => {
    // Losing native focus can cancel an IME without a final compositionend.
    window.addEventListener("blur", composerEnterGuard.reset);
    return () => { window.removeEventListener("blur", composerEnterGuard.reset); composerEnterGuard.reset(); };
  }, [composerEnterGuard]);
  useEffect(() => { composerEnterGuard.reset(); }, [composerEnterGuard, workspace.trust, workspace.workspace?.id]);

  useEffect(() => { changeViewRef.current = changeView; }, [changeView]);
  useEffect(() => { historyViewRef.current = historyView; }, [historyView]);

  useEffect(() => {
    if (historyView || review?.changeView !== "task" || !runtime?.task) return;
    if (["completed", "failed", "cancelled", "unverified", "abandoned"].includes(runtime.task.state)) {
      setTaskCompletionChanges(review.changes);
    }
  }, [historyView, review, runtime?.task?.id, runtime?.task?.state]);

  useEffect(() => setDangerConfirmed(false), [runtime?.task?.pendingApproval?.id]);

  useEffect(() => {
    if (!confirmation) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setConfirmation(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [confirmation, busy]);

  useEffect(() => {
    if (!selectedDiff) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedDiff(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedDiff]);

  const runWorkspace = async (operation: () => Promise<DesktopWorkspaceSnapshot>) => {
    setBusy(true); setError(undefined);
    try { setWorkspace(await operation()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const submit = async (answer?: string) => {
    if (providerRestartRequired || busy || submitPendingRef.current || status === "waiting_approval" || status === "stopping" || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")) return;
    if (!isActive && review?.recovery) { setWorkbenchCollapsed(false); setReviewTab("evidence"); setError("请先确认恢复或放弃旧任务，再开始新任务。"); return; }
    const visibleText = (answer ?? input).trim();
    if (!visibleText && !attachments.length) return;
    submitPendingRef.current = true;
    const continuedHistory = !isActive ? historyView : undefined;
    const previousTaskId = runtimeRef.current?.task?.id;
    if (continuedHistory) { historyViewRef.current = undefined; setHistoryView(undefined); }
    if (!isActive) { setTaskCompletionChanges(undefined); setSelectedDiff(undefined); }
    const text = [visibleText, attachments.map((attachment) => attachment.reference).join("\n")].filter(Boolean).join("\n\n");
    const steering = Boolean(runtime?.task && activeStates.has(runtime.task.state));
    setInput("");
    setPendingMessage({ text: visibleText, timestamp: new Date().toISOString(), steering, attachments });
    pendingAttachmentsRef.current = attachments;
    setAttachments([]);
    outputFollow.resume();
    setBusy(true); setError(undefined);
    try {
      if (steering) {
        if (!await window.xiuDesktop.steerTask({ text })) throw new Error("当前任务暂时无法接收补充要求。");
      } else {
        const next = continuedHistory
          ? await window.xiuDesktop.continueTask({ taskId: continuedHistory.taskId, text })
          : await window.xiuDesktop.createTask({ text, ...(runtime?.task?.pendingQuestion ? { answerTo: { taskId: runtime.task.id, questionId: runtime.task.pendingQuestion.id } } : {}) });
        setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot; setEvents(next.runtime.events.slice(-1_000));
        const started = [...next.runtime.events].reverse().find(event => event.type === "task.started" && event.taskId === next.runtime.snapshot.task?.id);
        if (started && pendingAttachmentsRef.current) {
          const owned = pendingAttachmentsRef.current;
          setSubmittedAttachments(old => ({ ...old, [started.eventId]: owned }));
          pendingAttachmentsRef.current = undefined;
        }
      }
      setPendingMessage(undefined);
    } catch (reason) {
      if (continuedHistory && runtimeRef.current?.task?.id === previousTaskId) { historyViewRef.current = continuedHistory; setHistoryView(continuedHistory); }
      setPendingMessage(undefined); setInput((current) => current || visibleText); setAttachments((current) => current.length ? current : attachments); setError(reason instanceof Error ? reason.message : String(reason));
    }
    finally { pendingAttachmentsRef.current = undefined; submitPendingRef.current = false; setBusy(false); }
  };

  const newConversation = async () => {
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.newConversation();
      setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot;
      setEvents([]); setDraft(undefined); setPendingMessage(undefined); setHistoryView(undefined); setTaskCompletionChanges(undefined); setSelectedDiff(undefined); setInput(""); setAttachments([]); setSubmittedAttachments({});
      outputFollow.resume();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const applyAttachments = (result: DesktopAttachmentResult) => {
    if (result.insertText && !result.attachments.length) setInput((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}${result.insertText}`);
    if (result.attachments.length) setAttachments((current) => {
      const merged = new Map(current.map((item) => [item.reference, item]));
      for (const item of result.attachments) merged.set(item.reference, item);
      return [...merged.values()];
    });
  };

  const addAttachments = async (source: "choose" | "paste") => {
    setBusy(true); setError(undefined);
    try { applyAttachments(source === "choose" ? await window.xiuDesktop.chooseAttachments() : await window.xiuDesktop.pasteAttachments()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true); setError(undefined);
    try {
      const payload = await Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
      applyAttachments(await window.xiuDesktop.importAttachments({ files: payload }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const removeAttachment = (reference: string) => setAttachments((current) => current.filter((item) => item.reference !== reference));

  const decide = async (allowed: boolean, rememberForSession = false) => {
    if (!approval) return;
    setBusy(true); setError(undefined);
    try {
      await window.xiuDesktop.decideApproval({ approvalId: approval.id, allowed, ...(rememberForSession ? { rememberForSession: true as const } : {}), ...(allowed && approval.risk === "dangerous" ? { confirmedRisk: "dangerous" as const } : {}) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setError(undefined);
    try { if (!await window.xiuDesktop.stopTask()) throw new Error("当前任务无法停止，可能已经结束。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const openTaskHistory = async (taskId: string) => {
    setBusy(true); setError(undefined);
    try {
      const history = await window.xiuDesktop.openTaskHistory({ taskId });
      setHistoryView(history);
      setSubmittedAttachments(current => ({ ...current, ...history.attachments }));
      setReviewTab("changes"); setChangeView("task"); changeViewRef.current = "task"; setFilePreview(undefined); setSelectedDiff(undefined);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const deleteTask = async (taskId: string) => {
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.deleteTask({ taskId, confirmed: true });
      setWorkspace(next);
      await refreshRuntime(0);
      if (historyView?.taskId === taskId && !next.tasks.some((task) => task.id === taskId)) setHistoryView(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const removeRecentWorkspace = async (workspaceId: string) => {
    setBusy(true); setError(undefined);
    try {
      const removingCurrent = workspace.workspace?.id === workspaceId;
      const next = await window.xiuDesktop.removeRecentWorkspace({ workspaceId, confirmed: true });
      setWorkspace(next);
      if (removingCurrent && !next.recent.some((item) => item.id === workspaceId)) {
        setConnection(undefined); setRuntime(undefined); runtimeRef.current = undefined;
        setEvents([]); setDraft(undefined); setHistoryView(undefined); setReview(undefined); setFilePreview(undefined);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const confirmDestructiveAction = async () => {
    if (!confirmation) return;
    const current = confirmation;
    if (current.kind === "task") await deleteTask(current.id);
    else await removeRecentWorkspace(current.id);
    setConfirmation(undefined);
  };

  const setPlanMode = async (enabled: boolean) => {
    if (providerRestartRequired || !connection?.modeContextId || busy || isActive) return;
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.setPlanMode({ enabled, contextId: connection.modeContextId });
      setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const setApprovalMode = async (mode: DesktopApprovalMode) => {
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.setApprovalMode({ mode, contextId: connection?.modeContextId ?? "" });
      setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot;
      setPermissionOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const selectChangeView = async (view: DesktopChangeView) => {
    setChangeView(view); changeViewRef.current = view; setError(undefined);
    if (historyView && view === "task") { setFilePreview(undefined); return; }
    try { await refreshReview(view); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const openPreview = async (file: string) => {
    if (!file) { setFilePreview(undefined); return; }
    setReviewTab("files"); setPreviewMode("source"); setError(undefined);
    try { setFilePreview(await window.xiuDesktop.previewFile({ path: file })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const restoreCheckpoint = async (checkpointId: string) => {
    setBusy(true); setError(undefined);
    try { setReview(await window.xiuDesktop.restoreCheckpoint({ checkpointId })); setChangeView("workspace"); changeViewRef.current = "workspace"; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const recoverTask = async (runId: string) => {
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.recoverTask({ runId });
      setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot; setEvents(next.runtime.events.slice(-1_000));
      await refreshReview();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const abandonRecovery = async (runId: string) => {
    setBusy(true); setError(undefined);
    try { setReview(await window.xiuDesktop.abandonRecovery({ runId })); await refreshRuntime(0); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const manageProviderRecovery = async (request: DesktopProviderRecoveryRequest) => {
    setBusy(true); setProviderRecoveryError(undefined);
    try {
      const next = await window.xiuDesktop.providerRecovery(request);
      setProviderRecovery(next);
      if (next.restartRequired) {
        setConnection(undefined); setRuntime(undefined); runtimeRef.current = undefined;
        setProviderSettings(undefined); setProviderOpen(false); setPermissionOpen(false);
        setError(undefined);
      }
    } catch (reason) { setProviderRecoveryError(reason instanceof Error ? reason.message : "配置恢复未完成，请刷新诊断。"); }
    finally { setBusy(false); }
  };
  const openProviderRecovery = () => {
    setProviderOpen(false); setPermissionOpen(false); setProviderRecoveryOpen(true);
    void manageProviderRecovery({ action: "snapshot" });
  };
  const closeProviderRecovery = async () => {
    if (busy) return;
    if (providerRecovery?.preview) await manageProviderRecovery({ action: "cancel", contextId: providerRecovery.contextId, token: providerRecovery.preview.token });
    setProviderRecoveryOpen(false);
  };

  const openProviderPicker = async (placement: "composer" | "settings" = "composer") => {
    setProviderPlacement(placement); setProviderOpen(true); setProviderNotice(undefined); setError(undefined);
    try {
      const next = await window.xiuDesktop.providerSnapshot();
      setProviderSettings(next); setSelectedProviderId(next.activeProviderId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const refreshMcp = async () => {
    setError(undefined); setMcpSnapshot(undefined);
    try { setMcpSnapshot(await window.xiuDesktop.mcpSnapshot()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => {
    if (busy || !mcpOpen || !["starting", "confirmation", "waiting"].includes(mcpSnapshot?.oauthFlow?.state ?? "")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await window.xiuDesktop.mcpSnapshot(); if (!cancelled) setMcpSnapshot(next); }
      catch { if (!cancelled) setError("OAuth 状态暂时无法读取，请刷新或取消登录。"); }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [busy, mcpOpen, mcpSnapshot?.oauthFlow?.id, mcpSnapshot?.oauthFlow?.state]);
  const manageMcp = async (request: DesktopMcpManageRequest): Promise<boolean> => {
    setBusy(true); setError(undefined);
    try { setMcpSnapshot(await window.xiuDesktop.manageMcp(request)); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { setBusy(false); }
  };
  const browseMcp = async (request: DesktopMcpBrowseRequest): Promise<unknown> => {
    setBusy(true); setError(undefined);
    try { return await window.xiuDesktop.browseMcp(request); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
    finally { setBusy(false); }
  };
  const closeMcp = async () => {
    const flow = mcpSnapshot?.oauthFlow;
    if (flow && ["starting", "confirmation", "waiting"].includes(flow.state) && !await manageMcp({ action: "oauth-cancel", flowId: flow.id })) return;
    setMcpOpen(false); setMcpSnapshot(undefined);
  };
  const changeMcp = async (action: "reload" | "disconnect" | "approve", name?: string, fingerprint?: string) => {
    setBusy(true); setError(undefined);
    try {
      setMcpSnapshot(action === "reload" ? await window.xiuDesktop.reloadMcp() : action === "disconnect" ? await window.xiuDesktop.disconnectMcp() : await window.xiuDesktop.approveMcp({ name: name!, fingerprint: fingerprint!, confirmed: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setMcpSnapshot(undefined);
    } finally { setBusy(false); }
  };

  const closeProviderPicker = () => {
    setProviderOpen(false);
    setCredentialEditing(undefined);
    setApiKey("");
  };

  const discoverProviderModels = async (providerId: string) => {
    setBusy(true); setProviderNotice(undefined); setError(undefined); setSelectedProviderId(providerId);
    try { setProviderSettings(await window.xiuDesktop.discoverProviderModels({ providerId })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const applyProviderMutation = (next: Awaited<ReturnType<typeof window.xiuDesktop.selectProvider>>) => {
    setProviderSettings(next.settings); setConnection(next.connection); setRuntime(next.connection.runtime.snapshot);
    runtimeRef.current = next.connection.runtime.snapshot; setEvents(next.connection.runtime.events.slice(-1_000));
  };

  const selectProvider = async (providerId: string, model: string, capability?: DesktopProviderCapability) => {
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try {
      applyProviderMutation(await window.xiuDesktop.selectProvider({ providerId, model, ...(capability ? { capability } : {}) }));
      setProviderNotice(capability ? `已将 ${providerId} 的${capability}模型切换为 ${model}` : `已切换为 ${providerId} / ${model}`);
      if (!capability && providerPlacement === "composer") closeProviderPicker();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const saveProviderCredential = async () => {
    if (!credentialEditing || !apiKey) return;
    const providerId = credentialEditing;
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try {
      applyProviderMutation(await window.xiuDesktop.saveProviderCredential({ providerId, apiKey }));
      setCredentialEditing(undefined); setApiKey(""); setProviderNotice("凭据已保存到系统凭据库。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApiKey(""); setBusy(false); }
  };

  const testProvider = async (providerId: string, model: string) => {
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try { setProviderNotice((await window.xiuDesktop.testProvider({ providerId, model })).message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const upsertProvider = async (request: DesktopProviderUpsertRequest) => {
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try {
      const next = await window.xiuDesktop.upsertProvider(request);
      applyProviderMutation(next);
      setSelectedProviderId(request.id.trim());
      setProviderNotice(request.existingId ? "渠道配置已更新。" : "渠道已新增。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally { setBusy(false); }
  };

  const deleteProviderProfile = async (profile: DesktopProviderProfile) => {
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try {
      const next = await window.xiuDesktop.deleteProvider({ providerId: profile.id, confirmed: true });
      applyProviderMutation(next);
      setSelectedProviderId(next.settings.activeProviderId);
      setProviderNotice(`已删除渠道 ${profile.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally { setBusy(false); }
  };

  const approval = runtime?.task?.pendingApproval;
  const historyFinished = historyView?.events.filter(event => event.type === "task.finished").at(-1);
  const question = historyView ? historyFinished?.type === "task.finished" ? historyFinished.payload.pendingQuestion : undefined : runtime?.task?.pendingQuestion;
  const isActive = Boolean(runtime?.task && activeStates.has(runtime.task.state));
  const status = runtime?.task?.state ?? "idle";
  const modelLabel = connection ? `${connection.provider.label} · ${connection.provider.model}` : "正在准备运行时";
  const approvalMode = connection?.approvalMode ?? "ask";
  const planMode = runtime?.planMode ?? false;
  const currentTaskEvents = useMemo(() => events.filter((event) => !runtime?.task || event.taskId === runtime.task.id), [events, runtime?.task?.id]);
  const historyPlan = useMemo(() => latestPlan(historyView?.events ?? []), [historyView]);
  const eventPlan = useMemo(() => latestPlan(currentTaskEvents), [currentTaskEvents]);
  const plan = historyView && !isActive ? historyPlan : runtime?.task?.plan ?? eventPlan;
  // Change the default only at round boundaries, not on each progress update.
  // A user's manual collapse remains in effect for the current running round.
  useEffect(() => { setPlanOpen(isActive); }, [isActive, runtime?.task?.id]);
  const planDone = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const planState = historyView && !isActive ? historyView.status : status;
  const planCurrentTitle = question ? "等待你的回答" : plan?.steps.find((step) => step.status === "in_progress")?.title ?? (plan && planDone === plan.steps.length ? planState === "failed" || planState === "unverified" ? "计划步骤已完成 · 验收未通过" : "全部步骤完成" : "等待下一步");
  // The conversation spans rounds; only task-scoped inspector facts are
  // filtered to the current execution. Never replace the transcript on follow-up.
  const timelineEvents = events;
  const taskView = selectedTaskView(historyView, isActive, Boolean(pendingMessage || draft), pendingMessage && !pendingMessage.steering ? [] : currentTaskEvents, runtime?.task?.subagents);
  const activeConversationId = historyView?.taskId ?? connection?.conversationId;
  const providerPicker = providerOpen ? <ProviderPicker key={providerPlacement} management={providerPlacement === "settings"} settings={providerSettings} selectedProviderId={selectedProviderId} busy={busy} disabled={isActive || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")} credentialEditing={credentialEditing} apiKey={apiKey} notice={providerNotice} onChooseProvider={(id) => { setSelectedProviderId(id); setCredentialEditing(undefined); setApiKey(""); setProviderNotice(undefined); }} onDiscover={(id) => void discoverProviderModels(id)} onSelect={(providerId, model, capability) => void selectProvider(providerId, model, capability)} onEditCredential={(id) => { setCredentialEditing(id); setApiKey(""); }} onApiKey={setApiKey} onSaveCredential={() => void saveProviderCredential()} onCancelCredential={() => { setCredentialEditing(undefined); setApiKey(""); }} onTest={(providerId, model) => void testProvider(providerId, model)} onUpsert={upsertProvider} onDelete={deleteProviderProfile} onClose={closeProviderPicker} /> : null;

  return <PreferencesContext.Provider value={preferences}><main className="app-shell">
    {managementOpen && <ManagementPanel disabled={isActive || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")} onClose={() => setManagementOpen(false)} onConnection={(next) => { setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot; setEvents(next.runtime.events.slice(-1_000)); setDraft(undefined); }} />}
    <header className="titlebar"><div className="brand"><Logo /><span>Xiu</span></div><div className="titlebar-context">{workspace.workspace?.name ?? "本地优先桌面工作台"}</div><div className="preview-badge">v0.20 · 预览</div></header>
    <aside className="sidebar">
      <button className="primary-button new-task-button" disabled={busy || isActive || workspace.trust !== "trusted"} onClick={() => void newConversation()}>＋ 新建任务</button>
      <button className="workspace-picker" disabled={busy || isActive} onClick={() => void runWorkspace(() => window.xiuDesktop.chooseWorkspace())}>⌁ 打开工作区</button>
      <section><h2>最近项目</h2>{workspace.recent.length === 0 ? <p className="muted">尚无可信工作区</p> : workspace.recent.map((item) => <div className="sidebar-item" key={item.id}><button className={`workspace-row ${workspace.workspace?.id === item.id ? "selected" : ""}`} disabled={busy || isActive} onClick={() => void runWorkspace(() => window.xiuDesktop.openRecentWorkspace({ workspaceId: item.id }))}><span className="folder-icon">⌁</span><span>{item.name}</span><small>{item.trusted ? "可信" : "需确认"}</small></button><button className="sidebar-delete" disabled={busy || isActive} title={`从最近项目移除 ${item.name}`} aria-label={`从最近项目移除 ${item.name}`} onClick={() => setConfirmation({ kind: "workspace", id: item.id, name: item.name })}>×</button></div>)}</section>
      {workspace.trust === "trusted" && <section className="history"><h2>最近任务</h2>{workspace.tasks.slice(0, 7).map((task) => <div className="sidebar-item" key={task.id}><button className={`history-row ${activeConversationId === task.id ? "selected" : ""}`} disabled={busy || isActive} title={task.title} onClick={() => void openTaskHistory(task.id)}><span className={`task-dot ${task.status}`} /><span>{task.title}</span></button><button className="sidebar-delete" disabled={busy || isActive} title={`删除任务 ${task.title}`} aria-label={`删除任务 ${task.title}`} onClick={() => setConfirmation({ kind: "task", id: task.id, name: task.title })}>×</button></div>)}</section>}
      <div className="sidebar-utilities"><button className="sidebar-mcp" disabled={busy || workspace.trust !== "trusted"} onClick={() => { setMcpOpen(true); void refreshMcp(); }}>MCP 连接与权限</button>
      <button className="sidebar-mcp" disabled={busy} onClick={openProviderRecovery}>Provider 配置诊断与恢复</button>
      <button className="sidebar-footer" onClick={() => { closeProviderPicker(); setSettingsOpen(true); }}>⚙ 设置</button></div>
    </aside>
    <section className="workspace-main">
      <header className="workspace-header"><div><h1>{workspace.workspace?.name ?? "欢迎使用 Xiu"}</h1><p>{workspace.workspace?.path ?? (workspace.trust === "required" ? "确认信任前不会读取项目内容" : "选择一个本地项目开始")}</p></div><div className="workspace-header-actions">{workspace.workspace && <span className={`status-chip ${workspace.trust}`}>{workspace.trust === "trusted" ? stateLabels[status] : "需要信任"}</span>}{workspace.trust === "trusted" && <WorkspaceToolbar overviewVisible={!overviewHidden} collapsed={workbenchCollapsed} terminalVisible={!workbenchCollapsed && reviewTab === "terminal"} disabled={busy} onSettings={() => setManagementOpen(true)} onOverview={() => setOverviewHidden((value) => !value)} onTerminal={() => { setWorkbenchCollapsed(false); setReviewTab("terminal"); }} onSidebar={() => setWorkbenchCollapsed((value) => !value)} />}</div></header>
      <div className="content-area">
        {providerRestartRequired && <div className="writer-warning" role="status">{providerRecovery?.completedAction === "keep-current" ? "中断写锁已清理，当前 Provider 配置未改变。" : "Provider 配置已恢复。"}请退出并重新打开 Xiu 后继续；CLI 与桌面需使用匹配版本。</div>}
        {(workspace.error || error) && <div className="error-banner">{error ?? workspace.error}</div>}
        {workspace.trust === "none" && <div className="empty-state"><Logo /><h2>打开你的第一个工作区</h2><p>项目内容保留在本机。Xiu 只会在获得信任后读取项目指令、任务历史或文件。</p><button className="primary-button compact" onClick={() => void runWorkspace(() => window.xiuDesktop.chooseWorkspace())}>选择文件夹</button></div>}
        {workspace.trust === "required" && workspace.workspace && <div className="trust-panel"><div className="trust-icon">✓</div><div><span className="eyebrow">工作区信任</span><h2>你信任“{workspace.workspace.name}”中的内容吗？</h2><p>信任后，Xiu 才能读取项目文件与指令、发现项目 Skill、建立索引并运行命令。请只信任你了解来源的项目。</p><div className="trust-actions"><button className="secondary-button" onClick={() => void runWorkspace(() => window.xiuDesktop.closeWorkspace())}>暂不打开</button><button className="primary-button compact" onClick={() => void runWorkspace(() => window.xiuDesktop.trustWorkspace({ workspaceId: workspace.workspace!.id, acknowledged: true }))}>信任并打开</button></div></div></div>}
        {workspace.trust === "trusted" && <ResizableTaskLayout>
          <section className="task-console">
             <div className="task-scroll-shell"><div className="task-scroll" ref={taskScrollRef}><div className="task-scroll-content">{taskView.history && <HistoryTimeline onAcceptance={refreshAcceptance} history={taskView.history} submittedAttachments={submittedAttachments} onClose={() => setHistoryView(undefined)} onDiff={openDiff} />}{!taskView.history && <TaskTimeline onAcceptance={refreshAcceptance} taskStartedAt={runtime?.task?.startedAt} events={timelineEvents} draft={draft} pendingMessage={pendingMessage} state={status} modelLabel={modelLabel} submittedAttachments={submittedAttachments} />}
              {!historyView && !isActive && taskCompletionChanges && <ChangeSummaryCard report={taskCompletionChanges} onDiff={openDiff} />}
              {approval && <section className={`approval-card risk-${approval.risk}`}><header><div><span className="eyebrow">需要你的批准</span><h2>{approval.description}</h2></div><span className="risk-chip">{approval.risk}</span></header>{approval.preview && <pre>{approval.preview}</pre>}<dl><div><dt>权限范围</dt><dd>{approval.sessionScope && approval.risk !== "dangerous" ? "可仅允许一次，或记住这一类操作直至退出 Xiu" : "仅本次操作"}</dd></div><div><dt>可能影响</dt><dd>{approval.effects.join("；")}</dd></div><div><dt>恢复方式</dt><dd>{approval.recovery}</dd></div></dl>{approval.risk === "dangerous" && <label className="danger-check"><input type="checkbox" checked={dangerConfirmed} onChange={(event) => setDangerConfirmed(event.target.checked)} />我理解该操作可能不可逆，并确认继续</label>}<footer><button className="secondary-button" disabled={busy} onClick={() => void decide(false)}>拒绝</button><button className="secondary-button" disabled={busy || approval.risk === "dangerous" && !dangerConfirmed} onClick={() => void decide(true)}>仅本次允许</button>{approval.sessionScope && approval.risk !== "dangerous" && <button className="primary-button compact" disabled={busy} onClick={() => void decide(true, true)}>本次会话始终允许</button>}</footer></section>}
             </div></div><TimelineNavigator scrollRef={taskScrollRef} contextKey={activeConversationId} onJump={outputFollow.pause} /></div>
            {outputFollow.paused && <button className="return-to-latest" onClick={outputFollow.resume}>↓ 回到最新进展</button>}
            {isActive && <ActiveTaskStatus events={currentTaskEvents} state={status} modelLabel={modelLabel} />}
            <div className="composer-area">{question && <UserQuestion key={question.id} question={question.question} busy={busy} onAnswer={submit} />}{!isActive && review?.recovery && <div className="writer-warning">有中断任务尚未处理。<button onClick={() => { setWorkbenchCollapsed(false); setReviewTab("evidence"); }}>查看并选择恢复或放弃</button></div>}{["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "") && <div className="writer-warning">{connection?.journalWarning ?? "另一个进程或窗口正在写入此工作区。请先在原任务中停止，随后重新打开工作区。"}</div>}{historyView && !isActive && <div className="history-resume-note">已载入历史上下文，可直接继续此任务。</div>}{planMode && <div className="plan-mode-note" role="status">Plan 只读：仅分析与规划，不执行写入或命令；完全访问也不例外。</div>}{plan && <details className="plan-strip" open={planOpen} onToggle={(event) => setPlanOpen(event.currentTarget.open)}><summary><span>{planDone} / {plan.steps.length} 步</span><div><i style={{ width: `${plan.steps.length ? planDone / plan.steps.length * 100: 0}%` }} /></div><span>{planCurrentTitle}</span><b>{planOpen ? "收起" : "展开"}</b></summary><div className="plan-details"><strong>{plan.goal}</strong><ol>{plan.steps.map((step) => <li className={step.status} key={step.id}><span>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"}</span>{step.title}</li>)}</ol></div></details>}<div className="composer" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); void importFiles([...event.dataTransfer.files]); }}>{attachments.length > 0 && <EditableAttachmentTiles attachments={attachments} onRemove={removeAttachment} />}<textarea value={input} disabled={providerRestartRequired || status === "waiting_approval" || status === "stopping" || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")} onChange={(event) => setInput(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void importFiles(files); } }} onCompositionStart={() => composerEnterGuard.compositionStart()} onCompositionEnd={() => composerEnterGuard.compositionEnd()} onBlur={() => composerEnterGuard.reset()} onKeyUp={() => composerEnterGuard.keyUp()} onKeyDown={(event) => { if (composerEnterGuard.shouldSubmit(event.nativeEvent) && (preferences.sendKey === "enter" || event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} placeholder={historyView && !isActive ? "继续这个任务…" : isActive ? "补充要求或调整方向…" : "描述你想完成的任务…"} /><div className="composer-footer"><div className="composer-tools"><button className={`plan-mode-selector${planMode ? " selected" : ""}`} aria-pressed={planMode} aria-label="Plan 只读模式" disabled={providerRestartRequired || busy || !connection?.modeContextId || isActive || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")} title={planMode ? "Plan 只读：仅分析与规划，完全访问也不能写入或执行；空闲时可切换" : "执行模式：按权限设置执行任务；点击切换为 Plan 只读"} onClick={() => void setPlanMode(!planMode)}>{planMode ? "Plan · 只读" : "执行"}</button><button className="attach-button" title="添加文件或图片" disabled={busy} onClick={() => void addAttachments("choose")}>＋</button><button className={`permission-selector mode-${approvalMode}`} disabled={!connection || isActive} title={approvalModeDetails[approvalMode].description} onClick={() => { setProviderOpen(false); setPermissionOpen((open) => !open); }}><span>{approvalModeDetails[approvalMode].icon}</span><strong>{approvalModeDetails[approvalMode].label}</strong><i>⌄</i></button><button className="model-selector" title={modelLabel} disabled={!connection} onClick={() => { setPermissionOpen(false); if (providerOpen) closeProviderPicker(); else void openProviderPicker("composer"); }}>{connection ? <><span className="model-provider">{connection.provider.label}</span><span className="model-divider">·</span><strong className="model-name">{connection.provider.model}</strong></> : <strong className="model-name">正在准备运行时</strong>}<span className="model-chevron">⌄</span></button></div><div>{isActive && <button className="stop-button" onClick={() => void stop()}>停止</button>}<button className="send-button" disabled={providerRestartRequired || busy || (!input.trim() && !attachments.length) || status === "waiting_approval" || status === "stopping" || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")} onClick={() => void submit()}>↑</button></div></div>{permissionOpen && <div className="permission-popover" role="menu" aria-label="权限模式"><header><strong>权限模式</strong><small>按所选模式执行；完全访问含危险操作</small></header>{(Object.keys(approvalModeDetails) as DesktopApprovalMode[]).map((mode) => <button key={mode} className={approvalMode === mode ? "selected" : ""} disabled={busy || isActive} onClick={() => void setApprovalMode(mode)}><span className={`permission-icon mode-${mode}`}>{approvalModeDetails[mode].icon}</span><span><strong>{approvalModeDetails[mode].label}</strong><small>{approvalModeDetails[mode].description}</small></span><i>{approvalMode === mode ? "✓" : ""}</i></button>)}</div>}{providerOpen && providerPlacement === "composer" && providerPicker}</div></div>
          </section>
<ReviewInspector onComputerTask={(goal) => void submit("使用电脑操作工具完成目标：" + goal + "。先 computer_windows 查找目标，computer_select 请求授权；随后观察、操作并验证。优先控件 ID，输入后验证实际结果并更新计划。不操作密码、支付、删除或发布，遇阻碍请求用户回应。")} onComputerEnable={() => void setApprovalMode("full")} computerAutomatic={approvalMode === "full"} computerDisabled={isActive || busy || planMode || !connection || providerRestartRequired} overviewHidden={overviewHidden} task={runtime?.task} workspace={workspace.workspace} collapsed={workbenchCollapsed} setCollapsed={setWorkbenchCollapsed} review={review} events={taskView.events} agents={taskView.agents} selectedPath={selectedDiff?.path} history={taskView.history} tab={reviewTab} changeView={changeView} preview={filePreview} previewMode={previewMode} active={isActive || busy} onTab={setReviewTab} onChangeView={(view) => void selectChangeView(view)} onPreview={(file) => void openPreview(file)} onDiff={openDiff} onPreviewMode={setPreviewMode} onRefresh={() => void refreshReview().catch((reason) => setError(String(reason)))} onRestore={(id) => void restoreCheckpoint(id)} onRecover={(id) => void recoverTask(id)} onAbandon={(id) => void abandonRecovery(id)} />
        </ResizableTaskLayout>}
      </div>
    </section>
    {providerRecoveryOpen && <RecoveryPanel snapshot={providerRecovery} busy={busy} error={providerRecoveryError}
      onRefresh={() => void manageProviderRecovery({ action: "snapshot" })}
      onPreview={(backupId) => { if (providerRecovery) void manageProviderRecovery({ action: "preview", contextId: providerRecovery.contextId, backupId }); }}
      onRecover={() => { if (providerRecovery?.preview) void manageProviderRecovery({ action: "recover", contextId: providerRecovery.contextId, token: providerRecovery.preview.token }); }}
      onCancel={() => { if (providerRecovery?.preview) void manageProviderRecovery({ action: "cancel", contextId: providerRecovery.contextId, token: providerRecovery.preview.token }); }}
      onClose={() => void closeProviderRecovery()} />}
    {confirmation && <ConfirmationDialog kind={confirmation.kind} name={confirmation.name} busy={busy} onCancel={() => setConfirmation(undefined)} onConfirm={() => void confirmDestructiveAction()} />}
    {mcpOpen && <McpPanel snapshot={mcpSnapshot} busy={busy} error={error} disabled={isActive || ["active-elsewhere", "recovery-required"].includes(connection?.writer ?? "")} onRefresh={() => void refreshMcp()} onReload={() => void changeMcp("reload")} onDisconnect={() => void changeMcp("disconnect")} onApprove={(name, fingerprint) => void changeMcp("approve", name, fingerprint)} onManage={manageMcp} onBrowse={browseMcp} onClose={() => void closeMcp()} />}
    {settingsOpen && <SettingsPage value={preferences} modelDisabled={busy || isActive || workspace.trust !== "trusted"} models={providerPlacement === "settings" ? providerPicker : null} onClose={() => { closeProviderPicker(); setSettingsOpen(false); }} onModels={() => void openProviderPicker("settings")} onModelsClose={closeProviderPicker} toolsDisabled={busy || workspace.trust !== "trusted"} onTools={() => { closeProviderPicker(); setSettingsOpen(false); setManagementOpen(true); }} onSave={async (next) => { const saved = await window.xiuDesktop.savePreferences(next); setPreferences(saved); applyAppearance(saved); }} />}
  </main></PreferencesContext.Provider>;
}
