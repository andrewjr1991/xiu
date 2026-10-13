import { useEffect, useState } from "react";
import type { DesktopChangeView, DesktopReviewSnapshot, DesktopReviewTab, DesktopTaskHistorySnapshot, ReviewFilePreview, RuntimeEvent } from "../../shared/protocol.js";
import { BrowserPane } from "./BrowserPane.js";
import { ChangesPanel } from "./ChangesPanel.js";
import { ComputerUsePanel } from "./ComputerUsePanel.js";
import { InteractiveTerminal } from "./InteractiveTerminal.js";
import { SubagentCards, TaskDataPanel } from "./TaskDataPanel.js";
import { TaskOverview } from "./TaskOverview.js";
import { type ChangeEntry, languageFromPath, reviewWarningLabel, SyntaxCode } from "./TaskTimeline.js";
import { recoveryRecommendation } from "./text-presentation.js";

const operationLabels: Record<string, string> = {
  pending: "等待中", running: "运行中", succeeded: "已通过", failed: "失败", unknown: "待核验", cancelled: "已停止",
  read: "只读", write: "写入", execute: "执行", network: "联网", dangerous: "危险操作",
};

export function ReviewInspector({ onComputerTask, onComputerEnable, computerAutomatic, computerDisabled, overviewHidden, task, workspace, review, history, events, agents, tab, changeView, preview, previewMode, active, selectedPath, collapsed, setCollapsed, onTab, onChangeView, onPreview, onDiff, onPreviewMode, onRefresh, onRestore, onRecover, onAbandon }: {
  onComputerTask: (goal: string) => void;
  onComputerEnable: () => void;
  computerAutomatic: boolean;
  computerDisabled: boolean;
  workspace?: { name: string; path?: string };
  overviewHidden: boolean;
  task?: import("../../../../src/runtime/protocol.js").RuntimeTaskSnapshot;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  events: RuntimeEvent[];
  agents?: import("../../../../src/runtime/protocol.js").RuntimeSubagentCard[];
  selectedPath?: string;
  review?: DesktopReviewSnapshot;
  history?: DesktopTaskHistorySnapshot;
  tab: DesktopReviewTab;
  changeView: DesktopChangeView;
  preview?: ReviewFilePreview;
  previewMode: "source" | "preview";
  active: boolean;
  onTab: (tab: DesktopReviewTab) => void;
  onChangeView: (view: DesktopChangeView) => void;
  onPreview: (path: string) => void;
  onDiff: (change: ChangeEntry) => void;
  onPreviewMode: (mode: "source" | "preview") => void;
  onRefresh: () => void;
  onRestore: (checkpointId: string) => void;
  onRecover: (runId: string) => void;
  onAbandon: (runId: string) => void;
}) {
  const [terminalMounted, setTerminalMounted] = useState(tab === "terminal");
  const [openedTabs, setOpenedTabs] = useState<DesktopReviewTab[]>([tab]);
  const [launcher, setLauncher] = useState(false);
  const [fullView, setFullView] = useState(false);
  useEffect(() => { if (collapsed) setFullView(false); }, [collapsed]);
  useEffect(() => { if (tab !== "home") setOpenedTabs((opened) => opened.includes(tab) ? opened : [...opened, tab]); }, [tab]);
  const openTab = (id: DesktopReviewTab) => { setLauncher(false); onTab(id); };
  const closeTab = (id: DesktopReviewTab) => {
    const remaining = openedTabs.filter((item) => item !== id);
    setOpenedTabs(remaining);
    if (id === "web") void window.xiuDesktop.browser({ action: "close" });
    if (id === "terminal") { setTerminalMounted(false); void window.xiuDesktop.terminalSnapshot().then((snapshot) => { if (snapshot.sessionId) return window.xiuDesktop.stopTerminal({ sessionId: snapshot.sessionId }); }).catch(() => undefined); }
    if (tab === id) onTab(remaining.at(-1) ?? "home");
  };
  if (history && review) review = { ...review, commands: (history.tools ?? []).filter((tool) => ["run_command", "run_process"].includes(tool.name)), validations: history.validations ?? [], checkpoints: [], recovery: undefined };
  useEffect(() => { if (tab === "terminal") setTerminalMounted(true); }, [tab]);
  const tabs: Array<[DesktopReviewTab, string]> = [["changes", "变更"], ["files", "文件"], ["terminal", "终端"], ["agents", "子智能体"], ["data", "数据"], ["evidence", "证据"], ["web", "网页"], ["computer", "电脑操作"]];
  const historicalTask = Boolean(history && changeView === "task");
  const displayedChanges = historicalTask ? history?.changes : review?.changes;
  return <aside className={`inspector review-inspector ${fullView ? "workbench-full" : ""} ${collapsed ? "workbench-collapsed" : ""}`}>
    <TaskOverview hidden={overviewHidden} task={task} workspace={workspace} events={events} history={history} review={review} agents={agents} live={active} collapsed={collapsed} onOpen={(id) => { setCollapsed(false); openTab(id); }} />
    <header className="inspector-tabs"><div className="workbench-tab-strip" role="tablist" aria-label="工作台标签页">{openedTabs.filter((id) => id !== "home").map((id) => <div className={`workbench-tab ${tab === id ? "selected" : ""}`} key={id}><button role="tab" aria-selected={tab === id} onClick={() => openTab(id)}>{tabs.find(([key]) => key === id)?.[1]}</button><button aria-label={`关闭${tabs.find(([key]) => key === id)?.[1]}`} onClick={() => closeTab(id)}>×</button></div>)}</div><div className="workbench-actions"><button aria-label="打开标签页" title="打开标签页" onClick={() => setLauncher(!launcher)}>＋</button><button className="refresh-button" title="刷新" onClick={onRefresh}>↻</button><button aria-label={fullView ? "返回分屏" : "完整视图"} title={fullView ? "返回分屏" : "完整视图"} onClick={() => setFullView(!fullView)}>⛶</button></div></header>
    {(launcher || tab === "home") && <div className="workbench-launcher"><span className="empty-note">打开工具</span><div>{tabs.map(([id, label]) => <button key={id} onClick={() => openTab(id)}>{label}<span>↗</span></button>)}</div></div>}
    {openedTabs.includes("web") && <BrowserPane visible={tab === "web" && !launcher && !collapsed} />}
    {!review && <p className="muted padded">正在读取审查证据…</p>}
    {tab === "agents" && <section className="review-pane"><SubagentCards events={history?.events ?? events} snapshot={history ? undefined : agents} live={!history && active} onCancel={async (agent) => { const connection = await window.xiuDesktop.runtimeConnect(); await window.xiuDesktop.cancelSubagent({ runId: agent.runId, taskId: agent.taskId!, parentTaskId: connection.runtime.snapshot.task?.id ?? "" }); }} /></section>}
    {tab === "computer" && !collapsed && <ComputerUsePanel onStart={onComputerTask} onEnable={onComputerEnable} automatic={computerAutomatic} disabled={computerDisabled} />}
    {tab === "data" && <TaskDataPanel events={history?.events ?? events} review={history ? { ...review!, changes: history.changes ?? { view: "task", git: false, complete: false, changes: [], warnings: [], preExisting: [] }, artifacts: (history.changes?.changes ?? []).filter((entry) => ["created", "modified"].includes(entry.kind)).map(({ path, kind }) => ({ path, kind })), tools: history.tools ?? [], validations: history.validations ?? [], background: [] } : review} />}
    {tab === "changes" && <section className="review-pane">
      <div className="segmented">{(["task", "workspace", "staged"] as DesktopChangeView[]).map((view) => <button key={view} disabled={view !== "task" && review?.changes.git === false} title={view !== "task" && review?.changes.git === false ? "此目录不是 Git 仓库，请使用本任务比较" : undefined} className={changeView === view ? "selected" : ""} onClick={() => onChangeView(view)}>{view === "task" ? "本任务" : view === "workspace" ? "工作区" : "已暂存"}</button>)}</div>
      {review?.changes.git === false && <p className="empty-note">此目录不是 Git 仓库。“本任务”比较任务起点与当前文件；“工作区 / 已暂存”需要 Git，不适用于此目录。</p>}
      {!displayedChanges && historicalTask && <p className="history-change-missing">该历史任务没有保存变更快照。为避免误导，这里不会显示当前工作区 Diff。</p>}
      {!displayedChanges && !historicalTask && <p className="muted padded">正在读取变更…</p>}
      <ChangesPanel report={displayedChanges} rounds={changeView === "task" ? history?.changeRounds ?? review?.changeRounds : []} selectedPath={selectedPath} onSelect={onDiff} warningLabel={reviewWarningLabel} />
    </section>}
    {review && tab === "files" && <section className="review-pane file-pane">
      {!preview && <div className="file-list">{review.files.map((file) => <button key={file.path} onClick={() => onPreview(file.path)}><span>{file.kind === "image" ? "▧" : file.kind === "markdown" || file.kind === "html" ? "◫" : "◻"}</span><span>{file.path}</span><small>{Math.ceil(file.bytes / 1024)} KB</small></button>)}</div>}
      {preview && <div className="file-preview"><header><button onClick={() => onPreview("")}>‹ 文件</button><strong>{preview.path}</strong>{preview.safeHtml && <div className="preview-toggle"><button className={previewMode === "source" ? "selected" : ""} onClick={() => onPreviewMode("source")}>源码</button><button className={previewMode === "preview" ? "selected" : ""} onClick={() => onPreviewMode("preview")}>预览</button></div>}</header>{preview.warning && <p className="review-warning">{preview.warning}</p>}{preview.kind === "image" && preview.dataUrl && <img src={preview.dataUrl} alt={preview.path} />}{preview.kind === "audio" && preview.dataUrl && <audio controls src={preview.dataUrl} />}{preview.kind === "video" && preview.dataUrl && <video controls src={preview.dataUrl} />}{previewMode === "preview" && preview.safeHtml ? <iframe title={`${preview.path} 安全预览`} sandbox="" referrerPolicy="no-referrer" srcDoc={preview.safeHtml} /> : preview.source !== undefined && <pre><SyntaxCode code={`${preview.source}${preview.truncated ? "\n…预览已截断" : ""}`} language={languageFromPath(preview.path)} /></pre>}</div>}
    </section>}
    {review && terminalMounted && <InteractiveTerminal visible={tab === "terminal"} disabled={active} />}
    {review && tab === "evidence" && <section className="review-pane evidence-pane">
      {!active && review.recovery && <article className="recovery-card"><span className="eyebrow">中断恢复</span><h3>{review.recovery.taskPreview}</h3><p>{recoveryRecommendation(review.recovery.recommendation)}</p>{review.recovery.lastRecoveryPoint && <p>最后安全点：{review.recovery.lastRecoveryPoint.evidence}</p>}<strong>{review.recovery.unknownOperations.length} 项操作待核验</strong><div><button onClick={() => onAbandon(review.recovery!.runId)}>放弃旧任务</button><button className="primary-button compact" onClick={() => onRecover(review.recovery!.runId)}>确认恢复</button></div></article>}
      <h3>命令证据</h3><p className="pane-intro">这里只展示 Agent 已执行命令的有界、脱敏记录；交互终端输出不会进入这里。</p>{review.commands.length === 0 && <p className="empty-note">暂无命令记录。</p>}{review.commands.map((item) => <article className="operation-card" key={item.id}><header><strong>{item.name}</strong><span className={item.status}>{operationLabels[item.status] ?? item.status}</span></header><p>{item.evidence ?? "没有记录可展示的输出摘要。"}</p><footer>{item.durationMs !== undefined ? `${item.durationMs} ms` : "运行时间未知"} · {operationLabels[item.sideEffect] ?? item.sideEffect}</footer></article>)}
      <h3>验证账本</h3>{review.validations.length === 0 && <p className="empty-note">尚无验证证据。</p>}{review.validations.map((item) => <article className="operation-card" key={item.id}><header><strong>{item.name}</strong><span className={item.status}>{operationLabels[item.status] ?? item.status}</span></header><p>{item.evidence ?? "无结果摘要"}</p></article>)}
      <h3>检查点</h3>{review.checkpoints.length === 0 && <p className="empty-note">尚无检查点。</p>}{review.checkpoints.map((checkpoint) => <article className="checkpoint-card" key={checkpoint.id}><div><strong>{checkpoint.description}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()}</small><p>{checkpoint.files.map((file) => file.path).join("、")}</p></div><button disabled={active} onClick={() => onRestore(checkpoint.id)}>恢复</button></article>)}
    </section>}
  </aside>;
}
