import { Select } from "./Select.js";
import { BrowserPane } from "./BrowserPane.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { desktopTerminalVisuals } from "./terminal-visuals.js";
import { McpPanel } from "./McpPanel.js";
import { ChangesPanel } from "./ChangesPanel.js";
import { SubagentCards, TaskDataPanel } from "./TaskDataPanel.js";
import type { WorkspaceMcpSnapshot, DesktopMcpManageRequest, DesktopMcpBrowseRequest } from "../../shared/protocol.js";
import {
  applyRuntimeEvent,
  type DesktopAttachment,
  type DesktopApprovalMode,
  type DesktopChangeView,
  type DesktopAttachmentResult,
  type DesktopProviderProfile,
  type DesktopProviderCapability,
  type DesktopProviderKind,
  type DesktopProviderSnapshot,
  type DesktopProviderUpsertRequest,
  type DesktopReviewSnapshot,
  type DesktopReviewTab,
  type DesktopRuntimeConnection,
  type DesktopTaskHistorySnapshot,
  type DesktopTerminalSnapshot,
  type DesktopWorkspaceSnapshot,
  type ReviewFilePreview,
  type RuntimeEvent,
  type RuntimeTaskState,
  type XiuRuntimeSnapshot,
} from "../../shared/protocol.js";
import { currentRuntimeActivity, groupedTimelineItems, mergeRuntimeEvents, modelProgressSummary } from "./task-presentation.js";

const emptyWorkspace: DesktopWorkspaceSnapshot = { bridgeVersion: 1, trust: "none", recent: [], tasks: [] };

function Logo() {
  return <div className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 7.5c4.5 0 5.4 7 8 8.5 2.8 1.6 3.6 8.5 8 8.5" /><path d="M24 7.5c-4.5 0-5.4 7-8 8.5-2.8 1.6-3.6 8.5-8 8.5" /></svg></div>;
}

function latestPlan(events: RuntimeEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "plan.updated") return event.payload.plan;
  }
  return undefined;
}

const activeStates = new Set(["running", "waiting_approval", "stopping"]);
const stateLabels: Record<string, string> = {
  idle: "就绪", running: "正在运行", waiting_approval: "等待审批", stopping: "正在停止",
  completed: "已完成", unverified: "未验证", failed: "失败", cancelled: "已停止", paused: "已暂停", recoverable: "可恢复",
  abandoned: "已放弃", session: "历史会话",
};

const operationLabels: Record<string, string> = {
  pending: "等待中", running: "运行中", succeeded: "已通过", failed: "失败", unknown: "待核验", cancelled: "已停止",
  read: "只读", write: "写入", execute: "执行", network: "联网", dangerous: "危险操作",
};

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

function reviewWarningLabel(warning: string): string {
  if (warning.startsWith("no-task-baseline:")) return "当前进程没有本任务起点，暂以工作区变化展示；请勿将其全部归因于 Xiu。";
  if (warning.startsWith("non-git:")) return "此目录不是 Git 仓库：忽略规则采用保守策略，无法与 HEAD 比较已有变化。";
  if (warning.startsWith("no-git-baseline:")) return "非 Git 目录没有 HEAD 或暂存区基线；开始任务后可查看本次进程内的任务变化。";
  if (warning.startsWith("git-inventory-unavailable:")) return "Git 文件清单读取失败或超过上限，当前覆盖不完整。";
  if (warning.startsWith("git-head-unavailable:")) return "无法读取 Git HEAD，不能完成文件内容比较。";
  if (warning.startsWith("file-limit:")) return "文件数量超过审查上限，当前仅展示部分结果；未显示不代表没有变化。";
  if (warning.startsWith("detail-omitted:")) return warning.replace(/^detail-omitted:\s*/, "部分文件因二进制、过大、忽略、链接或不可读而省略详情：");
  if (warning.startsWith("history-file-limit:")) return "该任务的文件数超过历史快照上限，只保存了前 500 项。";
  if (warning.startsWith("history-size-limit:")) return "为保证历史快照有界，部分文件的文本预览已省略。";
  return warning;
}

function eventTitle(event: RuntimeEvent): string {
  if (event.type === "task.started") return "你";
  if (event.type === "assistant.message") return event.payload.hasToolCalls ? "Xiu · 进展说明" : "Xiu";
  if (event.type === "model.started") return `模型第 ${event.payload.turn} 轮`;
  if (event.type === "tool.started") return `运行工具 · ${event.payload.name}`;
  if (event.type === "tool.finished") return `工具完成 · ${event.payload.name}`;
  if (event.type === "task.steered") return "你 · 补充要求";
  if (event.type === "workspace.changed") return "工作区发生变更";
  if (event.type === "runtime.notice") return event.payload.kind === "completion-gate" ? "完成门禁" : event.payload.kind === "checkpoint" ? "恢复点" : "运行提示";
  if (event.type === "task.finished") return stateLabels[event.payload.state] ?? event.payload.state;
  return event.type;
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return <>{parts.map((part, index) => part.startsWith("`") && part.endsWith("`")
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part)}</>;
}

function languageFromPath(file: string): string {
  const extension = file.toLowerCase().split(".").pop() ?? "";
  return ({ html: "html", htm: "html", css: "css", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", md: "markdown", ps1: "powershell", sh: "shell" } as Record<string, string>)[extension] ?? "text";
}

function SyntaxCode({ code, language = "text" }: { code: string; language?: string }) {
  const pattern = /(<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*|<\/?[A-Za-z][\w:-]*|\/?>|\b[A-Za-z_:][-A-Za-z0-9_:.]*(?=\s*=)|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|new|throw|try|catch|true|false|null|undefined)\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b)/g;
  const tokens = code.split(pattern).filter((token) => token !== "");
  const tokenClass = (token: string) => {
    if (/^(?:<!--|\/\*|\/\/)/.test(token)) return "syntax-comment";
    if (/^["'`]/.test(token)) return "syntax-string";
    if (/^<\/?[A-Za-z]/.test(token) || /^\/?>$/.test(token)) return "syntax-tag";
    if (/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(token) && language === "html") return "syntax-attribute";
    if (/^\d/.test(token)) return "syntax-number";
    if (/^(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|new|throw|try|catch|true|false|null|undefined)$/.test(token)) return "syntax-keyword";
    return undefined;
  };
  return <code className={`syntax-code language-${language}`}>{tokens.map((token, index) => <span className={tokenClass(token)} key={index}>{token}</span>)}</code>;
}

function FormattedText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let code: string[] | undefined;
  let codeLanguage = "text";
  let list: string[] = [];
  const flushList = () => { if (list.length) { blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}><InlineText text={item} /></li>)}</ul>); list = []; } };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushList();
      if (code) { blocks.push(<pre key={`code-${blocks.length}`}><SyntaxCode code={code.join("\n")} language={codeLanguage} /></pre>); code = undefined; }
      else { code = []; codeLanguage = line.slice(3).trim().toLowerCase() || "text"; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) { list.push(item[1]!); continue; }
    flushList();
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) blocks.push(<h3 key={`heading-${blocks.length}`}><InlineText text={heading[2]!} /></h3>);
    else blocks.push(<p key={`line-${blocks.length}`}><InlineText text={line} /></p>);
  }
  flushList();
  if (code) blocks.push(<pre key={`code-${blocks.length}`}><SyntaxCode code={code.join("\n")} language={codeLanguage} /></pre>);
  return <div className="rich-text">{blocks}</div>;
}

function visibleMessageText(text: string): string {
  return text.replace(/\r/g, "").split("\n").filter((line) => !/^\s*@(?:"[^"]+"|\.xiu\/attachments\/\S+)\s*$/.test(line)).join("\n").trim();
}

function AttachmentTiles({ attachments, compact = false }: { attachments: DesktopAttachment[]; compact?: boolean }) {
  if (!attachments.length) return null;
  return <div className={`attachment-tiles ${compact ? "compact" : ""}`}>{attachments.map((attachment) => <div className={`attachment-tile ${attachment.kind}`} key={attachment.reference}>
    {attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt={attachment.name} /> : <span className="file-glyph">{attachment.kind === "image" ? "▧" : "◫"}</span>}
    <span><strong>{attachment.name}</strong><small>{Math.max(1, Math.ceil(attachment.bytes / 1024))} KB</small></span>
  </div>)}</div>;
}

function EditableAttachmentTiles({ attachments, onRemove }: { attachments: DesktopAttachment[]; onRemove: (reference: string) => void }) {
  if (!attachments.length) return null;
  return <div className="attachment-tiles editable">{attachments.map((attachment) => <div className={`attachment-tile ${attachment.kind}`} key={attachment.reference}>
    {attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt={attachment.name} /> : <span className="file-glyph">◫</span>}
    <span><strong>{attachment.name}</strong><small>{Math.max(1, Math.ceil(attachment.bytes / 1024))} KB</small></span>
    <button aria-label={`移除 ${attachment.name}`} onClick={() => onRemove(attachment.reference)}>×</button>
  </div>)}</div>;
}

function eventText(event: RuntimeEvent): string | undefined {
  if (event.type === "task.started") return visibleMessageText(event.payload.taskPreview);
  if (event.type === "assistant.message" || event.type === "task.steered") return event.payload.text;
  if (event.type === "tool.started") return event.payload.description;
  if (event.type === "tool.progress" || event.type === "runtime.notice") return event.payload.message;
  if (event.type === "tool.finished") return event.payload.summary;
  if (event.type === "task.finished") return event.payload.result ?? event.payload.error;
  if (event.type === "workspace.changed") return `${event.payload.change.files.length} 个文件变更`;
  return undefined;
}

function activityText(event: RuntimeEvent): string | undefined {
  if (event.type === "model.started") return `第 ${event.payload.turn} 轮模型调用已开始`;
  if (event.type === "model.finished") return "模型响应已接收，正在整理下一步";
  if (event.type === "tool.started") return `运行 ${event.payload.name} · ${event.payload.description}`;
  if (event.type === "tool.progress") return `${event.payload.name} · ${event.payload.message}`;
  if (event.type === "tool.finished") return `${event.payload.name} · ${event.payload.summary}`;
  if (event.type === "workspace.changed") return `已编辑 ${event.payload.change.files.length} 个文件`;
  if (event.type === "plan.updated") return "任务计划已更新";
  if (event.type === "runtime.notice") return event.payload.message;
  return undefined;
}

function TaskTimeline({ events, draft, pendingMessage, state, modelLabel, submittedAttachments = [] }: { events: RuntimeEvent[]; draft?: string; pendingMessage?: { text: string; timestamp: string; steering: boolean; attachments: DesktopAttachment[] }; state: RuntimeTaskState | "idle"; modelLabel: string; submittedAttachments?: DesktopAttachment[] }) {
  const items = groupedTimelineItems(events.filter((event) => event.type !== "subagent.updated"), state);
  const activity = currentRuntimeActivity(events, draft, state, modelLabel);
  if (!items.length && !draft && !pendingMessage && !activity) return <div className="task-welcome"><Logo /><h2>告诉 Xiu 你想完成什么</h2><p>Xiu 可以协助开发和本机软件排障；操作将遵循你选择的权限模式。</p></div>;
  return <div className="timeline">
    <SubagentCards events={events} compact />
    {items.map((item) => item.kind === "activity" ? <details className={`process-group ${item.active ? "active" : ""}`} open={item.active} key={item.id}>
      <summary><span className={item.active ? "pulse" : "process-icon"}>{item.active ? "" : "✓"}</span><strong>{item.active ? activity?.label ?? "正在处理" : `已处理 ${item.events.length} 项`}</strong><small>{item.active ? activity?.detail : "命令、工具与文件操作"}</small></summary>
      <div>{(() => { const progress = modelProgressSummary(item.events); return progress && <article className={`model-progress-summary ${progress.providerVisible ? "provider-visible" : "factual"}`}><header><strong>{progress.title}</strong><small>{progress.providerVisible ? "模型公开输出" : "可核验运行事实"}</small></header><p>{progress.text}</p></article>; })()}{item.events.map((event) => activityText(event) && <p className={`process-row process-${event.type.replace(".", "-")}`} key={event.eventId}><span>{event.type === "workspace.changed" ? "✎" : event.type.startsWith("tool.") ? "⌘" : event.type === "plan.updated" ? "☷" : "·"}</span><span>{activityText(event)}</span><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>)}</div>
    </details> : <article className={`event-card event-${item.event.type.replace(".", "-")}`} key={item.event.eventId}>
      {(() => { const event = item.event; return <>
      <header><span>{event.type === "assistant.message" && event.payload.hasToolCalls ? "Xiu · 公开思考摘要" : eventTitle(event)}</span><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
      {eventText(event) && <div className="event-text"><FormattedText text={eventText(event)!} /></div>}
      {event.type === "task.started" && submittedAttachments.length > 0 && <AttachmentTiles attachments={submittedAttachments} compact />}
      </>; })()}
    </article>)}
    {pendingMessage && <article className="event-card event-task-started pending-message"><header><span>{pendingMessage.steering ? "你 · 补充要求" : "你"}</span><time>{new Date(pendingMessage.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>{pendingMessage.text && <div className="event-text">{pendingMessage.text}</div>}<AttachmentTiles attachments={pendingMessage.attachments} compact /></article>}
    {draft && <article className="event-card draft"><header><span>Xiu · 正在生成</span><span className="pulse" /></header><div className="event-text"><FormattedText text={draft} /></div></article>}
    {activity && !items.some((item) => item.kind === "activity" && item.active) && <div className="runtime-activity"><span className="pulse" /><span><strong>{activity.label}</strong><small>{activity.detail}</small></span></div>}
  </div>;
}

type ChangeEntry = DesktopReviewSnapshot["changes"]["changes"][number];

function HistoryTimeline({ history, onClose, onDiff }: { history: DesktopTaskHistorySnapshot; onClose: () => void; onDiff: (change: ChangeEntry) => void }) {
  return <div className="history-view"><header><div><span className="eyebrow">{history.fidelity === "exact" ? "完整运行过程" : "从现有记录重建"}</span><h2>{history.title}</h2><small>{stateLabels[history.status] ?? history.status}{history.providerId || history.model ? ` · ${[history.providerId, history.model].filter(Boolean).join(" / ")}` : ""}</small></div><button onClick={onClose}>退出会话</button></header>{history.events.length ? <TaskTimeline events={history.events} state={history.status === "session" || history.status === "abandoned" ? "idle" : history.status} modelLabel={[history.providerId, history.model].filter(Boolean).join(" · ") || "Xiu"} /> : <div className="timeline">{history.entries.map((entry) => <article className={`event-card history-${entry.kind}`} key={entry.id}><header><span>{entry.title}</span></header><div className="event-text"><FormattedText text={visibleMessageText(entry.text)} /></div></article>)}</div>}<ChangeSummaryCard report={history.changes} legacy onDiff={onDiff} /></div>;
}

function changeStats(change: ChangeEntry): { additions: number; deletions: number; approximate: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of change.preview?.replace(/\r/g, "").split("\n") ?? []) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions, approximate: !change.preview || change.limitations.length > 0 || change.preview.includes("preview truncated") };
}

function ChangeSummaryCard({ report, legacy = false, onDiff }: { report?: DesktopReviewSnapshot["changes"]; legacy?: boolean; onDiff: (change: ChangeEntry) => void }) {
  if (!report) return <section className="change-summary-card unavailable"><div><span className="change-summary-icon">⌁</span><span><strong>没有历史变更快照</strong><small>该任务创建于快照功能启用前；不会用当前工作区变化伪造本任务 Diff。</small></span></div></section>;
  let additions = 0;
  let deletions = 0;
  let approximate = !report.complete || report.warnings.length > 0;
  for (const change of report.changes) {
    const stats = changeStats(change);
    additions += stats.additions; deletions += stats.deletions; approximate ||= stats.approximate;
  }
  const files = report.changes;
  return <details className="change-summary-card">
    <summary><span className="change-summary-icon">±</span><span><strong>已编辑 {files.length} 个文件</strong><small><b className="added">+{additions}</b><b className="removed">-{deletions}</b>{approximate ? " · 基于有界预览，统计可能不完整" : legacy ? " · 已保存历史快照" : " · 本任务最终快照"}</small><em>{files.slice(0, 3).map((file) => file.path).join("、") || "没有检测到文件变化"}</em></span><i>{files.length > 3 ? `再显示 ${files.length - 3} 个文件` : "审查"}</i></summary>
    <div>{files.length === 0 ? <p>任务完成时没有检测到文件变化。</p> : files.map((file) => { const stats = changeStats(file); return <button key={file.path} onClick={() => onDiff(file)}><span className={`change-kind ${file.kind}`}>{file.kind === "created" ? "A" : file.kind === "deleted" ? "D" : file.kind === "unknown" ? "?" : "M"}</span><span>{file.path}</span><small><b className="added">+{stats.additions}</b><b className="removed">-{stats.deletions}</b></small></button>; })}</div>
  </details>;
}

function DiffPreview({ text }: { text: string }) {
  return <pre className="diff-preview">{text.replace(/\r/g, "").split("\n").map((line, index) => {
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : "context";
    return <span className={`diff-line ${kind}`} key={`${index}-${line}`}>{line || " "}</span>;
  })}</pre>;
}

function DiffDialog({ change, onClose }: { change: ChangeEntry; onClose: () => void }) {
  const stats = changeStats(change);
  const text = change.preview ?? (change.limitations.join(" · ") || "该文件没有可展示的文本 Diff。可能是二进制、过大、不可读或快照详情受限。");
  return <div className="dialog-backdrop diff-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="diff-dialog" role="dialog" aria-modal="true" aria-label={`${change.path} Diff`}>
      <header><div><strong>{change.path}</strong><small><b className="added">+{stats.additions}</b><b className="removed">-{stats.deletions}</b>{stats.approximate ? " · 有界预览" : ""}</small></div><button aria-label="关闭 Diff" onClick={onClose}>×</button></header>
      <DiffPreview text={text} />
      {change.limitations.length > 0 && <footer>详情限制：{change.limitations.join(" · ")}</footer>}
    </section>
  </div>;
}

function InteractiveTerminal({ visible, disabled }: { visible: boolean; disabled: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const snapshotRef = useRef<DesktopTerminalSnapshot>({ state: "idle" });
  const lastSequenceRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [snapshot, setSnapshot] = useState<DesktopTerminalSnapshot>({ state: "idle" });
  const [error, setError] = useState<string>();

  const applySnapshot = (next: DesktopTerminalSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      ...desktopTerminalVisuals,
      cursorBlink: true,
      convertEol: false,
      scrollback: 2_000,
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      const current = snapshotRef.current;
      if (current.state !== "running" || !current.sessionId) return;
      const sessionId = current.sessionId;
      writeQueueRef.current = writeQueueRef.current
        .then(() => window.xiuDesktop.writeTerminal({ sessionId, data }))
        .catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)); });
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      const current = snapshotRef.current;
      if (current.state !== "running" || !current.sessionId) return;
      void window.xiuDesktop.resizeTerminal({ sessionId: current.sessionId, cols, rows }).then(applySnapshot).catch(() => undefined);
    });
    const unsubscribe = window.xiuDesktop.onTerminalEvent((event) => {
      if (event.sessionId !== snapshotRef.current.sessionId && event.kind === "state" && event.snapshot.state === "running") lastSequenceRef.current = 0;
      if (event.sequence <= lastSequenceRef.current) return;
      lastSequenceRef.current = event.sequence;
      if (event.kind === "output") {
        if (snapshotRef.current.sessionId === event.sessionId) terminal.write(event.data);
        return;
      }
      if (event.kind === "state") {
        applySnapshot(event.snapshot);
        if (event.snapshot.state === "idle" && event.snapshot.message) terminal.writeln(`\r\n\x1b[90m${event.snapshot.message}\x1b[0m`);
        return;
      }
      applySnapshot({ ...snapshotRef.current, state: "exited", exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) });
      terminal.writeln(`\r\n\x1b[90m[进程已退出，代码 ${event.exitCode}]\x1b[0m`);
    });
    void window.xiuDesktop.terminalSnapshot().then((current) => {
      applySnapshot(current);
      if (current.output) terminal.write(current.output);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { unsubscribe(); input.dispose(); resize.dispose(); terminal.dispose(); terminalRef.current = undefined; fitRef.current = undefined; };
  }, []);

  useEffect(() => {
    if (!visible || !hostRef.current) return;
    const fit = () => {
      try {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        if (terminal) terminal.refresh(0, terminal.rows - 1);
        if (snapshotRef.current.state === "running") terminalRef.current?.focus();
      } catch { /* Hidden or closing terminal. */ }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(hostRef.current);
    requestAnimationFrame(fit);
    return () => observer.disconnect();
  }, [visible]);

  const start = async () => {
    setError(undefined);
    terminalRef.current?.reset();
    try {
      const terminal = terminalRef.current;
      fitRef.current?.fit();
      const next = await window.xiuDesktop.startTerminal({ cols: terminal?.cols, rows: terminal?.rows });
      applySnapshot(next);
      if (next.output) terminal?.write(next.output);
      if (next.state === "running") requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          terminal?.refresh(0, terminal.rows - 1);
          terminal?.focus();
        } catch { /* Terminal may be closing. */ }
      });
      if (next.state === "error") setError(next.message ?? "终端启动失败。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const stop = async () => {
    if (!snapshot.sessionId) return;
    setError(undefined);
    try { applySnapshot(await window.xiuDesktop.stopTerminal({ sessionId: snapshot.sessionId })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <section className={`review-pane terminal-pane ${visible ? "visible" : "hidden"}`} aria-hidden={!visible}>
    <div className="terminal-toolbar"><div><strong>交互终端</strong><small>{snapshot.state === "running" ? `${snapshot.shell ?? "Shell"} · ${snapshot.cols ?? "?"}×${snapshot.rows ?? "?"} · 运行中` : snapshot.state === "exited" ? `已退出${snapshot.exitCode === undefined ? "" : ` · ${snapshot.exitCode}`}` : snapshot.state === "error" ? "启动失败" : "未启动"}</small></div><div><button onClick={() => terminalRef.current?.clear()}>清屏</button>{snapshot.state === "running" ? <button className="terminal-stop" onClick={() => void stop()}>关闭</button> : <button className="terminal-start" disabled={disabled} onClick={() => void start()}>启动终端</button>}</div></div>
    <p className="terminal-notice">点击下方终端后直接输入，按 Enter 执行。固定绑定当前可信工作区；输入不经过 Agent 审批，输出不会写入任务审计，也不会作为 Agent 完成证据。</p>
    {disabled && snapshot.state !== "running" && <p className="terminal-disabled">Agent 任务运行期间不能启动终端。</p>}
    {error && <p className="terminal-error">{error}</p>}
    <div className="terminal-surface" ref={hostRef} onMouseDown={() => terminalRef.current?.focus()} />
  </section>;
}

function ReviewInspector({ review, history, events, tab, changeView, preview, previewMode, active, selectedPath, onTab, onChangeView, onPreview, onDiff, onPreviewMode, onRefresh, onRestore, onRecover, onAbandon }: {
  events: RuntimeEvent[];
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
  const tabs: Array<[DesktopReviewTab, string]> = [["changes", "变更"], ["files", "文件"], ["terminal", "终端"], ["agents", "子智能体"], ["data", "数据"], ["evidence", "证据"], ["web", "网页"]];
  const historicalTask = Boolean(history && changeView === "task");
  const displayedChanges = historicalTask ? history?.changes : review?.changes;
  return <aside className={`inspector review-inspector ${fullView ? "workbench-full" : ""}`}>
    <header className="inspector-tabs" role="tablist" aria-label="工作台标签页">{openedTabs.filter((id) => id !== "home").map((id) => <div className={`workbench-tab ${tab === id ? "selected" : ""}`} key={id}><button role="tab" aria-selected={tab === id} onClick={() => openTab(id)}>{tabs.find(([key]) => key === id)?.[1]}</button><button aria-label={`关闭${tabs.find(([key]) => key === id)?.[1]}`} onClick={() => closeTab(id)}>×</button></div>)}<button aria-label="打开标签页" title="打开标签页" onClick={() => setLauncher(!launcher)}>＋</button><button className="refresh-button" title="刷新" onClick={onRefresh}>↻</button><button aria-label={fullView ? "返回分屏" : "完整视图"} title={fullView ? "返回分屏" : "完整视图"} onClick={() => setFullView(!fullView)}>⛶</button></header>
    {(launcher || tab === "home") && <div className="workbench-launcher"><span className="empty-note">打开工具</span><div>{tabs.map(([id, label]) => <button key={id} onClick={() => openTab(id)}>{label}<span>↗</span></button>)}</div></div>}
    {openedTabs.includes("web") && <BrowserPane visible={tab === "web" && !launcher} />}
    {!review && <p className="muted padded">正在读取审查证据…</p>}
    {tab === "agents" && <section className="review-pane"><SubagentCards events={history?.events ?? events} /></section>}
    {tab === "data" && <TaskDataPanel events={history?.events ?? events} review={history ? { ...review!, changes: history.changes ?? { view: "task", git: false, complete: false, changes: [], warnings: [], preExisting: [] }, artifacts: (history.changes?.changes ?? []).filter((entry) => ["created", "modified"].includes(entry.kind)).map(({ path, kind }) => ({ path, kind })), tools: history.tools ?? [], validations: history.validations ?? [], background: [] } : review} />}
    {tab === "changes" && <section className="review-pane">
      <div className="segmented">{(["task", "workspace", "staged"] as DesktopChangeView[]).map((view) => <button key={view} className={changeView === view ? "selected" : ""} onClick={() => onChangeView(view)}>{view === "task" ? "本任务" : view === "workspace" ? "工作区" : "已暂存"}</button>)}</div>
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
      {review.recovery && <article className="recovery-card"><span className="eyebrow">中断恢复</span><h3>{review.recovery.taskPreview}</h3><p>{review.recovery.recommendation}</p>{review.recovery.lastRecoveryPoint && <p>最后安全点：{review.recovery.lastRecoveryPoint.evidence}</p>}<strong>{review.recovery.unknownOperations.length} 项操作待核验</strong><div><button onClick={() => onAbandon(review.recovery!.runId)}>放弃旧任务</button><button className="primary-button compact" onClick={() => onRecover(review.recovery!.runId)}>确认恢复</button></div></article>}
      <h3>命令证据</h3><p className="pane-intro">这里只展示 Agent 已执行命令的有界、脱敏记录；交互终端输出不会进入这里。</p>{review.commands.length === 0 && <p className="empty-note">暂无命令记录。</p>}{review.commands.map((item) => <article className="operation-card" key={item.id}><header><strong>{item.name}</strong><span className={item.status}>{operationLabels[item.status] ?? item.status}</span></header><p>{item.evidence ?? "没有记录可展示的输出摘要。"}</p><footer>{item.durationMs !== undefined ? `${item.durationMs} ms` : "运行时间未知"} · {operationLabels[item.sideEffect] ?? item.sideEffect}</footer></article>)}
      <h3>验证账本</h3>{review.validations.length === 0 && <p className="empty-note">尚无验证证据。</p>}{review.validations.map((item) => <article className="operation-card" key={item.id}><header><strong>{item.name}</strong><span className={item.status}>{operationLabels[item.status] ?? item.status}</span></header><p>{item.evidence ?? "无结果摘要"}</p></article>)}
      <h3>检查点</h3>{review.checkpoints.length === 0 && <p className="empty-note">尚无检查点。</p>}{review.checkpoints.map((checkpoint) => <article className="checkpoint-card" key={checkpoint.id}><div><strong>{checkpoint.description}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()}</small><p>{checkpoint.files.map((file) => file.path).join("、")}</p></div><button disabled={active} onClick={() => onRestore(checkpoint.id)}>恢复</button></article>)}
    </section>}
  </aside>;
}

function ProviderPicker({ settings, selectedProviderId, busy, disabled, credentialEditing, apiKey, notice, onChooseProvider, onDiscover, onSelect, onEditCredential, onApiKey, onSaveCredential, onCancelCredential, onTest, onUpsert, onDelete, onClose }: {
  settings?: DesktopProviderSnapshot;
  selectedProviderId?: string;
  busy: boolean;
  disabled: boolean;
  credentialEditing?: string;
  apiKey: string;
  notice?: string;
  onChooseProvider: (id: string) => void;
  onDiscover: (id: string) => void;
  onSelect: (providerId: string, model: string, capability?: DesktopProviderCapability) => void;
  onEditCredential: (id: string) => void;
  onApiKey: (value: string) => void;
  onSaveCredential: () => void;
  onCancelCredential: () => void;
  onTest: (providerId: string, model: string) => void;
  onUpsert: (request: DesktopProviderUpsertRequest) => Promise<void>;
  onDelete: (profile: DesktopProviderProfile) => Promise<void>;
  onClose: () => void;
}) {
  const blankProvider = (): DesktopProviderUpsertRequest => ({ id: "", name: "", kind: "openai-compatible", model: "", baseURL: "https://", apiKeyEnv: "", apiKey: "", contextWindow: 128000, capabilityModels: {}, features: { tools: true, vision: false, image: false, video: false, audio: false } });
  const [editing, setEditing] = useState<DesktopProviderUpsertRequest>();
  const [deleting, setDeleting] = useState<DesktopProviderProfile>();
  const selected = settings?.profiles.find((profile) => profile.id === selectedProviderId) ?? settings?.profiles.find((profile) => profile.id === settings.activeProviderId);
  const credentialLabel = (profile: DesktopProviderProfile) => profile.credential.source === "system" ? "系统凭据" : profile.credential.source === "environment" ? "环境变量" : profile.credential.source === "legacy-file" ? "兼容凭据" : profile.credential.source === "not-required" ? "无需 Key" : "未配置";
  const editProfile = (profile: DesktopProviderProfile) => setEditing({ existingId: profile.id, id: profile.id, name: profile.name, kind: profile.kind as DesktopProviderKind, model: profile.selectedModel, baseURL: profile.baseURL ?? "", apiKeyEnv: profile.apiKeyEnv ?? "", apiKey: "", contextWindow: profile.contextWindow, capabilityModels: { ...profile.capabilityModels }, features: { ...profile.features } });
  const updateEditing = <K extends keyof DesktopProviderUpsertRequest>(key: K, value: DesktopProviderUpsertRequest[K]) => setEditing((current) => current ? { ...current, [key]: value } : current);
  const chooseKind = (kind: DesktopProviderKind) => setEditing((current) => {
    if (!current) return current;
    if (current.existingId) return { ...current, kind };
    const template = settings?.templates?.find((item) => item.kind === kind);
    return { ...blankProvider(), ...template, kind, apiKey: current.apiKey, apiKeyEnv: current.apiKeyEnv,
      id: current.id && !settings?.templates?.some((item) => item.id === current.id) ? current.id : template?.id ?? "",
      name: current.name && !settings?.templates?.some((item) => item.name === current.name) ? current.name : template?.name ?? "" };
  });
  const updateCapabilityModel = (capability: "vision" | "image" | "video" | "audio", value: string) => setEditing((current) => current ? { ...current, capabilityModels: { ...current.capabilityModels, [capability]: value } } : current);
  return <div className="provider-popover" role="dialog" aria-label="选择 Provider 和模型">
    <header><div><strong>Provider 与模型</strong><small>选择模型，或管理自定义渠道</small></div><div className="provider-header-actions"><button className="provider-add" disabled={busy || disabled} onClick={() => { setDeleting(undefined); setEditing(blankProvider()); }}>＋ 新增渠道</button><button onClick={onClose} aria-label="关闭">×</button></div></header>
    {!settings && <p className="muted">正在读取 Provider 配置…</p>}
    {settings?.profiles.length === 0 && !editing && <p className="provider-notice">尚未添加渠道。点击“新增渠道”，选择 Agnes、OpenAI、本地模型或兼容服务。模板不会自动添加渠道，环境变量不是必需项。</p>}
    {settings && <div className="provider-grid">
      <nav>{settings.profiles.map((profile) => <div className="provider-nav-row" key={profile.id}><button className={selected?.id === profile.id ? "selected" : ""} onClick={() => { setEditing(undefined); setDeleting(undefined); onChooseProvider(profile.id); }}><span>{profile.name}</span><small>{credentialLabel(profile)}</small></button>{!profile.builtin && <span><button title="编辑渠道" onClick={() => editProfile(profile)}>✎</button><button title="删除渠道" onClick={() => { setEditing(undefined); setDeleting(profile); }}>×</button></span>}</div>)}</nav>
      {editing ? <section className="provider-editor"><header><div><strong>{editing.existingId ? "编辑渠道" : "新增渠道"}</strong><small>凭据只保存在系统凭据库，不写入项目文件</small></div><button onClick={() => setEditing(undefined)}>取消</button></header><div className="provider-form">
        <label>名称<input value={editing.name} onChange={(event) => updateEditing("name", event.target.value)} placeholder="例如：公司网关" /></label>
        <label>{editing.existingId ? "标识（创建后不可修改）" : "标识"}<input value={editing.id} disabled={Boolean(editing.existingId)} title={editing.existingId ? "标识用于关联凭据，创建后不可修改" : undefined} onChange={(event) => updateEditing("id", event.target.value)} placeholder="company-gateway" /></label>
        <label>类型<Select value={editing.kind} onChange={(event) => chooseKind(event.target.value as DesktopProviderKind)}>{(["openai-compatible", "openai", "anthropic", "agnes", "ollama", "lmstudio", "vllm"] as DesktopProviderKind[]).map((kind) => <option key={kind}>{kind}</option>)}</Select></label>
        <label>默认模型<input value={editing.model} onChange={(event) => updateEditing("model", event.target.value)} placeholder="model-id" /></label>
        <label className="wide">Base URL<input value={editing.baseURL ?? ""} onChange={(event) => updateEditing("baseURL", event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label>Key 环境变量<input value={editing.apiKeyEnv ?? ""} onChange={(event) => updateEditing("apiKeyEnv", event.target.value)} placeholder="OPTIONAL_API_KEY" /></label>
        <label>上下文窗口<input type="number" min="1024" value={editing.contextWindow ?? ""} onChange={(event) => updateEditing("contextWindow", event.target.value ? Number(event.target.value) : undefined)} /></label>
        <label className="wide">API Key（可选）<input type="password" autoComplete="off" value={editing.apiKey ?? ""} onChange={(event) => updateEditing("apiKey", event.target.value)} placeholder={editing.existingId ? "留空表示不更改现有凭据" : "保存到系统凭据库"} /></label>
        <fieldset className="wide"><legend>能力</legend>{(["tools", "vision", "image", "video", "audio"] as const).map((feature) => <label key={feature}><input type="checkbox" checked={editing.features[feature]} onChange={(event) => updateEditing("features", { ...editing.features, [feature]: event.target.checked })} />{feature}</label>)}</fieldset>
        {(["vision", "image", "video", "audio"] as const).filter((capability) => editing.features[capability]).map((capability) => {
          const options = settings?.capabilityModelsByProvider?.[editing.existingId ?? editing.id]?.[capability] ?? [];
          const labels = { vision: "视觉模型", image: "生图模型", video: "视频模型", audio: "音频模型" };
          const listId = `provider-${capability}-models`;
          return <label key={capability} className={capability === "vision" ? undefined : "wide"}>{labels[capability]}<input list={listId} value={editing.capabilityModels?.[capability] ?? (capability === "vision" ? editing.model : "")} onChange={(event) => updateCapabilityModel(capability, event.target.value)} placeholder="输入或选择模型 ID" /><datalist id={listId}>{options.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</datalist></label>;
        })}
      </div><footer><button onClick={() => setEditing(undefined)}>取消</button><button className="primary-button compact" disabled={busy || disabled || !editing.id.trim() || !editing.name.trim() || !editing.model.trim()} onClick={() => void onUpsert(editing).then(() => setEditing(undefined))}>{busy ? "保存中…" : "保存渠道"}</button></footer></section>
      : deleting ? <section className="provider-editor provider-delete-confirm"><span className="confirmation-icon danger">⌫</span><h3>删除“{deleting.name}”？</h3><p>将删除此渠道配置和模型缓存。已保存的系统凭据不会在此操作中导出或显示。</p><div><button onClick={() => setDeleting(undefined)}>取消</button><button className="danger-button" disabled={busy || disabled} onClick={() => void onDelete(deleting).then(() => setDeleting(undefined))}>删除渠道</button></div></section>
      : selected && <section className="model-panel">
        <div className="provider-summary"><div><strong>{selected.name}</strong><small>{selected.id} · {selected.kind}</small></div><span className={selected.credential.configured ? "configured" : "missing"}>{credentialLabel(selected)}</span></div>
        <div className="provider-actions"><button disabled={busy || disabled} onClick={() => onDiscover(selected.id)}>刷新模型</button><button disabled={busy || disabled} onClick={() => onTest(selected.id, selected.selectedModel)}>测试连接</button>{selected.credential.editable && <button disabled={busy || disabled} onClick={() => onEditCredential(selected.id)}>配置 Key</button>}{!selected.builtin && <button disabled={busy || disabled} onClick={() => editProfile(selected)}>编辑渠道</button>}</div>
        {settings.discoveryError && settings.modelProviderId === selected.id && <p className="provider-warning">在线发现失败：{settings.discoveryError}</p>}
        {credentialEditing === selected.id && <div className="credential-form"><label htmlFor="provider-api-key">API Key</label><input id="provider-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder="仅发送到主进程并保存至系统凭据库" /><div><button onClick={onCancelCredential}>取消</button><button className="primary-button compact" disabled={busy || !apiKey} onClick={onSaveCredential}>保存</button></div></div>}
        <div className="model-groups">
          <section className="model-group"><h4>对话模型</h4><div className="model-list">{(settings.modelsByProvider[selected.id] ?? []).map((model) => <button key={model.id} disabled={busy || disabled} className={settings.activeProviderId === selected.id && settings.activeModel === model.id ? "selected" : ""} onClick={() => onSelect(selected.id, model.id)}><span><strong>{model.name ?? model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}</span><span>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : model.source === "api" ? "在线" : model.source === "current" ? "当前" : "内置"}</span></button>)}</div></section>
          {(["vision", "image", "video", "audio"] as const).filter((capability) => selected.features[capability]).map((capability) => {
            const labels: Record<DesktopProviderCapability, string> = { vision: "视觉模型", image: "生图模型", video: "视频模型", audio: "音频模型" };
            const models = settings.capabilityModelsByProvider[selected.id]?.[capability] ?? [];
            const activeModel = selected.capabilityModels?.[capability];
            return <section className="model-group capability-model-group" key={capability}><h4>{labels[capability]}<span>{models.length} 个</span></h4>{models.length ? <div className="model-list">{models.map((model) => <button key={model.id} disabled={busy || disabled} className={activeModel === model.id ? "selected" : ""} onClick={() => onSelect(selected.id, model.id, capability)}><span><strong>{model.name ?? model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}</span><span>{activeModel === model.id ? "当前" : model.source === "api" ? "在线" : "内置"}</span></button>)}</div> : <p className="empty-note">刷新模型后选择，或在自定义渠道中手动填写模型 ID。</p>}</section>;
          })}
        </div>
      </section>}
    </div>}
    {notice && <p className="provider-notice">{notice}</p>}
    {disabled && <p className="provider-warning">任务运行或其他 Xiu 进程占用工作区时不能修改 Provider 配置。</p>}
  </div>;
}

export function App() {
  const [mcpOpen, setMcpOpen] = useState(false);
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
  const [submittedAttachments, setSubmittedAttachments] = useState<DesktopAttachment[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const [review, setReview] = useState<DesktopReviewSnapshot>();
  const [taskCompletionChanges, setTaskCompletionChanges] = useState<DesktopReviewSnapshot["changes"]>();
  const [selectedDiff, setSelectedDiff] = useState<ChangeEntry>();
  const openDiff = (entry: ChangeEntry) => { setSelectedDiff(entry); setReviewTab("changes"); };
  const [reviewTab, setReviewTab] = useState<DesktopReviewTab>("changes");
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
  const followOutputRef = useRef(true);

  const refreshRuntime = async (afterSequence = 0) => {
    const next = await window.xiuDesktop.runtimeConnect({ afterSequence });
    setConnection(next);
    setRuntime(next.runtime.snapshot);
    runtimeRef.current = next.runtime.snapshot;
    if (afterSequence === 0 || next.runtime.resyncRequired) setEvents(next.runtime.events.slice(-200));
    else if (next.runtime.events.length) setEvents((old) => mergeRuntimeEvents(old, next.runtime.events));
  };

  const refreshReview = async (view = changeViewRef.current) => {
    const next = await window.xiuDesktop.reviewSnapshot({ changeView: view });
    setReview(next);
  };

  useEffect(() => {
    void window.xiuDesktop.snapshot().then(setWorkspace).catch((reason) => setError(String(reason)));
    const offWorkspace = window.xiuDesktop.onSnapshot(setWorkspace);
    const offRuntime = window.xiuDesktop.onRuntimeEvent((event) => {
      const replacingTask = event.type === "task.started" && runtimeRef.current?.task?.id !== event.taskId;
      if (event.type === "task.started" || event.type === "task.steered") setPendingMessage(undefined);
      if (event.type === "task.started") { setTaskCompletionChanges(undefined); setSelectedDiff(undefined); }
      if (event.type === "assistant.draft") setDraft(event.payload.text);
      if (event.type === "assistant.stream-end" || event.type === "assistant.message" || event.type === "task.finished") setDraft(undefined);
      setEvents((old) => event.type === "assistant.draft" || event.type === "assistant.stream-end" ? old : replacingTask ? [event] : mergeRuntimeEvents(old, [event]));
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
          selectedHistory ? window.xiuDesktop.openTaskHistory({ taskId: selectedHistory.taskId }).then(setHistoryView) : Promise.resolve(),
        ]).catch((reason) => setError(String(reason)));
      }
    });
    return () => { offWorkspace(); offRuntime(); };
  }, []);

  useEffect(() => {
    if (workspace.trust !== "trusted") {
      setConnection(undefined); setRuntime(undefined); runtimeRef.current = undefined; setEvents([]); setDraft(undefined); setPendingMessage(undefined); setHistoryView(undefined); setReview(undefined); setTaskCompletionChanges(undefined); setSelectedDiff(undefined); setFilePreview(undefined); setProviderOpen(false); setProviderSettings(undefined); setCredentialEditing(undefined); setApiKey(""); return;
    }
    void Promise.all([refreshRuntime(0), refreshReview()]).catch((reason) => setError(String(reason)));
  }, [workspace.trust, workspace.workspace?.id]);

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

  useEffect(() => {
    const element = taskScrollRef.current;
    if (!element || !followOutputRef.current) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [events.length, draft, pendingMessage, runtime?.task?.state, runtime?.task?.pendingApproval?.id]);

  const runWorkspace = async (operation: () => Promise<DesktopWorkspaceSnapshot>) => {
    setBusy(true); setError(undefined);
    try { setWorkspace(await operation()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    const visibleText = input.trim();
    if (!visibleText && !attachments.length) return;
    if (!isActive) { setTaskCompletionChanges(undefined); setSelectedDiff(undefined); }
    const text = [visibleText, attachments.map((attachment) => attachment.reference).join("\n")].filter(Boolean).join("\n\n");
    const steering = Boolean(runtime?.task && activeStates.has(runtime.task.state));
    setInput("");
    setPendingMessage({ text: visibleText, timestamp: new Date().toISOString(), steering, attachments });
    setSubmittedAttachments(attachments);
    setAttachments([]);
    followOutputRef.current = true;
    setBusy(true); setError(undefined);
    try {
      if (steering) {
        if (!await window.xiuDesktop.steerTask({ text })) throw new Error("当前任务暂时无法接收补充要求。");
      } else {
        const next = historyView
          ? await window.xiuDesktop.continueTask({ taskId: historyView.taskId, text })
          : await window.xiuDesktop.createTask({ text });
        setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot; setEvents(next.runtime.events.slice(-200));
      }
      setPendingMessage(undefined);
    } catch (reason) { setPendingMessage(undefined); setSubmittedAttachments([]); setInput((current) => current || visibleText); setAttachments((current) => current.length ? current : attachments); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const newConversation = async () => {
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.newConversation();
      setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot;
      setEvents([]); setDraft(undefined); setPendingMessage(undefined); setHistoryView(undefined); setTaskCompletionChanges(undefined); setSelectedDiff(undefined); setInput(""); setAttachments([]); setSubmittedAttachments([]);
      followOutputRef.current = true;
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
      setHistoryView(await window.xiuDesktop.openTaskHistory({ taskId }));
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

  const setApprovalMode = async (mode: DesktopApprovalMode) => {
    setBusy(true); setError(undefined);
    try {
      const next = await window.xiuDesktop.setApprovalMode({ mode });
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
      setConnection(next); setRuntime(next.runtime.snapshot); runtimeRef.current = next.runtime.snapshot; setEvents(next.runtime.events.slice(-200));
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
    runtimeRef.current = next.connection.runtime.snapshot; setEvents(next.connection.runtime.events.slice(-200));
  };

  const selectProvider = async (providerId: string, model: string, capability?: DesktopProviderCapability) => {
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try {
      applyProviderMutation(await window.xiuDesktop.selectProvider({ providerId, model, ...(capability ? { capability } : {}) }));
      setProviderNotice(capability ? `已将 ${providerId} 的${capability}模型切换为 ${model}` : `已切换为 ${providerId} / ${model}`);
      if (!capability) setProviderOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const saveProviderCredential = async () => {
    if (!credentialEditing || !apiKey) return;
    const providerId = credentialEditing;
    setBusy(true); setProviderNotice(undefined); setError(undefined);
    try {
      applyProviderMutation(await window.xiuDesktop.saveProviderCredential({ providerId, apiKey }));
      setCredentialEditing(undefined); setApiKey(""); setProviderNotice("凭据已保存到 Windows Credential Manager。");
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
  const isActive = Boolean(runtime?.task && activeStates.has(runtime.task.state));
  const status = runtime?.task?.state ?? "idle";
  const modelLabel = connection ? `${connection.provider.label} · ${connection.provider.model}` : "正在准备运行时";
  const approvalMode = connection?.approvalMode ?? "ask";
  const currentTaskEvents = useMemo(() => events.filter((event) => !runtime?.task || event.taskId === runtime.task.id), [events, runtime?.task?.id]);
  const historyPlan = useMemo(() => latestPlan(historyView?.events ?? []), [historyView]);
  const eventPlan = useMemo(() => latestPlan(currentTaskEvents), [currentTaskEvents]);
  const plan = historyView && !isActive ? historyPlan : runtime?.task?.plan ?? eventPlan;
  const planDone = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const planCurrentTitle = plan?.steps.find((step) => step.status === "in_progress")?.title ?? (plan && planDone === plan.steps.length ? "全部步骤完成" : "等待下一步");
  const timelineEvents = pendingMessage && !pendingMessage.steering ? [] : currentTaskEvents;
  const activeConversationId = historyView?.taskId ?? connection?.conversationId;
  const providerPicker = providerOpen ? <ProviderPicker settings={providerSettings} selectedProviderId={selectedProviderId} busy={busy} disabled={isActive || connection?.writer === "active-elsewhere"} credentialEditing={credentialEditing} apiKey={apiKey} notice={providerNotice} onChooseProvider={(id) => { setSelectedProviderId(id); setCredentialEditing(undefined); setApiKey(""); setProviderNotice(undefined); }} onDiscover={(id) => void discoverProviderModels(id)} onSelect={(providerId, model, capability) => void selectProvider(providerId, model, capability)} onEditCredential={(id) => { setCredentialEditing(id); setApiKey(""); }} onApiKey={setApiKey} onSaveCredential={() => void saveProviderCredential()} onCancelCredential={() => { setCredentialEditing(undefined); setApiKey(""); }} onTest={(providerId, model) => void testProvider(providerId, model)} onUpsert={upsertProvider} onDelete={deleteProviderProfile} onClose={closeProviderPicker} /> : null;

  return <main className="app-shell">
    <header className="titlebar"><div className="brand"><Logo /><span>Xiu</span></div><div className="titlebar-context">{workspace.workspace?.name ?? "本地优先桌面工作台"}</div><div className="preview-badge">v0.20 · 预览</div></header>
    <aside className="sidebar">
      <button className="primary-button new-task-button" disabled={busy || isActive || workspace.trust !== "trusted"} onClick={() => void newConversation()}>＋ 新建任务</button>
      <button className="workspace-picker" disabled={busy || isActive} onClick={() => void runWorkspace(() => window.xiuDesktop.chooseWorkspace())}>⌁ 打开工作区</button>
      <section><h2>最近项目</h2>{workspace.recent.length === 0 ? <p className="muted">尚无可信工作区</p> : workspace.recent.map((item) => <div className="sidebar-item" key={item.id}><button className={`workspace-row ${workspace.workspace?.id === item.id ? "selected" : ""}`} disabled={busy || isActive} onClick={() => void runWorkspace(() => window.xiuDesktop.openRecentWorkspace({ workspaceId: item.id }))}><span className="folder-icon">⌁</span><span>{item.name}</span><small>{item.trusted ? "可信" : "需确认"}</small></button><button className="sidebar-delete" disabled={busy || isActive} title={`从最近项目移除 ${item.name}`} aria-label={`从最近项目移除 ${item.name}`} onClick={() => setConfirmation({ kind: "workspace", id: item.id, name: item.name })}>×</button></div>)}</section>
      {workspace.trust === "trusted" && <section className="history"><h2>最近任务</h2>{workspace.tasks.slice(0, 7).map((task) => <div className="sidebar-item" key={task.id}><button className={`history-row ${activeConversationId === task.id ? "selected" : ""}`} disabled={busy || isActive} title={task.title} onClick={() => void openTaskHistory(task.id)}><span className={`task-dot ${task.status}`} /><span>{task.title}</span></button><button className="sidebar-delete" disabled={busy || isActive} title={`删除任务 ${task.title}`} aria-label={`删除任务 ${task.title}`} onClick={() => setConfirmation({ kind: "task", id: task.id, name: task.title })}>×</button></div>)}</section>}
      <button className="sidebar-mcp" disabled={busy || workspace.trust !== "trusted"} onClick={() => { setMcpOpen(true); void refreshMcp(); }}>MCP 连接与权限</button>
      <button className="sidebar-footer" disabled={busy || workspace.trust !== "trusted"} onClick={() => void openProviderPicker("settings")}>⚙ 设置与模型</button>
    </aside>
    <section className="workspace-main">
      <header className="workspace-header"><div><h1>{workspace.workspace?.name ?? "欢迎使用 Xiu"}</h1><p>{workspace.workspace?.path ?? (workspace.trust === "required" ? "确认信任前不会读取项目内容" : "选择一个本地项目开始")}</p></div>{workspace.workspace && <span className={`status-chip ${workspace.trust}`}>{workspace.trust === "trusted" ? stateLabels[status] : "需要信任"}</span>}</header>
      <div className="content-area">
        {(workspace.error || error) && <div className="error-banner">{error ?? workspace.error}</div>}
        {workspace.trust === "none" && <div className="empty-state"><Logo /><h2>打开你的第一个工作区</h2><p>项目内容保留在本机。Xiu 只会在获得信任后读取项目指令、任务历史或文件。</p><button className="primary-button compact" onClick={() => void runWorkspace(() => window.xiuDesktop.chooseWorkspace())}>选择文件夹</button></div>}
        {workspace.trust === "required" && workspace.workspace && <div className="trust-panel"><div className="trust-icon">✓</div><div><span className="eyebrow">工作区信任</span><h2>你信任“{workspace.workspace.name}”中的内容吗？</h2><p>信任后，Xiu 才能读取项目文件与指令、发现项目 Skill、建立索引并运行命令。请只信任你了解来源的项目。</p><div className="trust-actions"><button className="secondary-button" onClick={() => void runWorkspace(() => window.xiuDesktop.closeWorkspace())}>暂不打开</button><button className="primary-button compact" onClick={() => void runWorkspace(() => window.xiuDesktop.trustWorkspace({ workspaceId: workspace.workspace!.id, acknowledged: true }))}>信任并打开</button></div></div></div>}
        {workspace.trust === "trusted" && <div className={`task-layout ${reviewTab === "terminal" ? "terminal-expanded" : reviewTab === "changes" ? "diff-expanded" : ""}`}>
          <section className="task-console">
            <div className="task-scroll" ref={taskScrollRef} onScroll={(event) => { const element = event.currentTarget; followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; }}>{historyView && <HistoryTimeline history={historyView} onClose={() => setHistoryView(undefined)} onDiff={openDiff} />}{(!historyView || isActive || pendingMessage || draft || timelineEvents.length > 0) && <TaskTimeline events={timelineEvents} draft={draft} pendingMessage={pendingMessage} state={status} modelLabel={modelLabel} submittedAttachments={submittedAttachments} />}
              {!historyView && !isActive && taskCompletionChanges && <ChangeSummaryCard report={taskCompletionChanges} onDiff={openDiff} />}
              {approval && <section className={`approval-card risk-${approval.risk}`}><header><div><span className="eyebrow">需要你的批准</span><h2>{approval.description}</h2></div><span className="risk-chip">{approval.risk}</span></header>{approval.preview && <pre>{approval.preview}</pre>}<dl><div><dt>权限范围</dt><dd>{approval.sessionScope && approval.risk !== "dangerous" ? "可仅允许一次，或记住这一类操作直至退出 Xiu" : "仅本次操作"}</dd></div><div><dt>可能影响</dt><dd>{approval.effects.join("；")}</dd></div><div><dt>恢复方式</dt><dd>{approval.recovery}</dd></div></dl>{approval.risk === "dangerous" && <label className="danger-check"><input type="checkbox" checked={dangerConfirmed} onChange={(event) => setDangerConfirmed(event.target.checked)} />我理解该操作可能不可逆，并确认继续</label>}<footer><button className="secondary-button" disabled={busy} onClick={() => void decide(false)}>拒绝</button><button className="secondary-button" disabled={busy || approval.risk === "dangerous" && !dangerConfirmed} onClick={() => void decide(true)}>仅本次允许</button>{approval.sessionScope && approval.risk !== "dangerous" && <button className="primary-button compact" disabled={busy} onClick={() => void decide(true, true)}>本次会话始终允许</button>}</footer></section>}
            </div>
            <div className="composer-area">{connection?.writer === "active-elsewhere" && <div className="writer-warning">另一个进程或窗口正在写入此工作区。请先在原任务中停止，随后重新打开工作区。</div>}{historyView && !isActive && <div className="history-resume-note">已载入历史上下文，可直接继续此任务。</div>}{plan && <details className="plan-strip" open={planOpen} onToggle={(event) => setPlanOpen(event.currentTarget.open)}><summary><span>{planDone} / {plan.steps.length} 步</span><div><i style={{ width: `${plan.steps.length ? planDone / plan.steps.length * 100: 0}%` }} /></div><span>{planCurrentTitle}</span><b>{planOpen ? "收起" : "展开"}</b></summary><div className="plan-details"><strong>{plan.goal}</strong><ol>{plan.steps.map((step) => <li className={step.status} key={step.id}><span>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"}</span>{step.title}</li>)}</ol></div></details>}<div className="composer" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); void importFiles([...event.dataTransfer.files]); }}>{attachments.length > 0 && <EditableAttachmentTiles attachments={attachments} onRemove={removeAttachment} />}<textarea value={input} disabled={status === "waiting_approval" || status === "stopping" || connection?.writer === "active-elsewhere"} onChange={(event) => setInput(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void importFiles(files); } }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={historyView && !isActive ? "继续这个任务…" : isActive ? "补充要求或调整方向…" : "描述你想完成的任务…"} /><div className="composer-footer"><div className="composer-tools"><button className="attach-button" title="添加文件或图片" disabled={busy} onClick={() => void addAttachments("choose")}>＋</button><button className={`permission-selector mode-${approvalMode}`} disabled={!connection || isActive} title={approvalModeDetails[approvalMode].description} onClick={() => { setProviderOpen(false); setPermissionOpen((open) => !open); }}><span>{approvalModeDetails[approvalMode].icon}</span><strong>{approvalModeDetails[approvalMode].label}</strong><i>⌄</i></button><button className="model-selector" title={modelLabel} disabled={!connection} onClick={() => { setPermissionOpen(false); if (providerOpen) closeProviderPicker(); else void openProviderPicker("composer"); }}>{connection ? <><span className="model-provider">{connection.provider.label}</span><span className="model-divider">·</span><strong className="model-name">{connection.provider.model}</strong></> : <strong className="model-name">正在准备运行时</strong>}<span className="model-chevron">⌄</span></button></div><div>{isActive && <button className="stop-button" onClick={() => void stop()}>停止</button>}<button className="send-button" disabled={busy || (!input.trim() && !attachments.length) || status === "waiting_approval" || status === "stopping" || connection?.writer === "active-elsewhere"} onClick={() => void submit()}>↑</button></div></div>{permissionOpen && <div className="permission-popover" role="menu" aria-label="权限模式"><header><strong>权限模式</strong><small>按所选模式执行；完全访问含危险操作</small></header>{(Object.keys(approvalModeDetails) as DesktopApprovalMode[]).map((mode) => <button key={mode} className={approvalMode === mode ? "selected" : ""} disabled={busy || isActive} onClick={() => void setApprovalMode(mode)}><span className={`permission-icon mode-${mode}`}>{approvalModeDetails[mode].icon}</span><span><strong>{approvalModeDetails[mode].label}</strong><small>{approvalModeDetails[mode].description}</small></span><i>{approvalMode === mode ? "✓" : ""}</i></button>)}</div>}{providerOpen && providerPlacement === "composer" && providerPicker}</div></div>
          </section>
          <ReviewInspector review={review} events={timelineEvents} selectedPath={selectedDiff?.path} history={isActive ? undefined : historyView} tab={reviewTab} changeView={changeView} preview={filePreview} previewMode={previewMode} active={isActive || busy} onTab={setReviewTab} onChangeView={(view) => void selectChangeView(view)} onPreview={(file) => void openPreview(file)} onDiff={openDiff} onPreviewMode={setPreviewMode} onRefresh={() => void refreshReview().catch((reason) => setError(String(reason)))} onRestore={(id) => void restoreCheckpoint(id)} onRecover={(id) => void recoverTask(id)} onAbandon={(id) => void abandonRecovery(id)} />
        </div>}
      </div>
    </section>
    {confirmation && <ConfirmationDialog kind={confirmation.kind} name={confirmation.name} busy={busy} onCancel={() => setConfirmation(undefined)} onConfirm={() => void confirmDestructiveAction()} />}
    {mcpOpen && <McpPanel snapshot={mcpSnapshot} busy={busy} error={error} disabled={isActive || connection?.writer === "active-elsewhere"} onRefresh={() => void refreshMcp()} onReload={() => void changeMcp("reload")} onDisconnect={() => void changeMcp("disconnect")} onApprove={(name, fingerprint) => void changeMcp("approve", name, fingerprint)} onManage={manageMcp} onBrowse={browseMcp} onClose={() => void closeMcp()} />}
    {providerOpen && providerPlacement === "settings" && <div className="dialog-backdrop settings-provider-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProviderPicker(); }}><div className="settings-provider-dialog" onMouseDown={(event) => event.stopPropagation()}>{providerPicker}</div></div>}
  </main>;
}
