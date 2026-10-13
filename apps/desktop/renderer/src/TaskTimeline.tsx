import { type ReactNode, useEffect, useState } from "react";
import type { DesktopAttachment, DesktopReviewSnapshot, DesktopTaskHistorySnapshot, RuntimeEvent, RuntimeTaskState } from "../../shared/protocol.js";
import { ComputerAcceptance } from "./ComputerAcceptance.js";
import { SubagentActivity } from "./TaskDataPanel.js";
import { changeStats } from "./change-stats.js";
import { usePreferences } from "./preferences.js";
import { activityRows, currentRuntimeActivity, groupedTimelineItems, modelProgressSummary } from "./task-presentation.js";
import { safeSourceUrl, webEvidenceForDisplay } from "./text-presentation.js";
import { conversationRounds, roundPresentation, turnElapsed } from "./turn-presentation.js";

export function Logo() {
  return <div className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 7.5c4.5 0 5.4 7 8 8.5 2.8 1.6 3.6 8.5 8 8.5" /><path d="M24 7.5c-4.5 0-5.4 7-8 8.5-2.8 1.6-3.6 8.5-8 8.5" /></svg></div>;
}

export const activeStates = new Set(["running", "waiting_approval", "stopping"]);
export const stateLabels: Record<string, string> = {
  waiting_user: "等待回答",
  idle: "就绪", running: "正在运行", waiting_approval: "等待审批", stopping: "正在停止",
  completed: "已完成", unverified: "未验证", failed: "失败", cancelled: "已停止", paused: "已暂停", recoverable: "可恢复",
  abandoned: "已放弃", session: "历史会话",
};

export function reviewWarningLabel(warning: string): string {
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
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https:\/\/[^\s)]+\))/g);
  return <>{parts.map((part, index) => part.startsWith("`") && part.endsWith("`")
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : (() => {
        const link = part.match(/^\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)$/);
        const href = link && safeSourceUrl(link[2]!);
        return href ? <a key={index} href={href} onClick={(event) => { event.preventDefault(); window.dispatchEvent(new CustomEvent("xiu-open-source", { detail: href })); }}>{link![1]}</a> : part;
      })())}</>;
}

export function languageFromPath(file: string): string {
  const extension = file.toLowerCase().split(".").pop() ?? "";
  return ({ html: "html", htm: "html", css: "css", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", md: "markdown", ps1: "powershell", sh: "shell" } as Record<string, string>)[extension] ?? "text";
}

export function SyntaxCode({ code, language = "text" }: { code: string; language?: string }) {
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
    <span><strong>{attachment.name}</strong><small>{attachment.unavailable ? "附件缺失或不可读取" : `${Math.max(1, Math.ceil(attachment.bytes / 1024))} KB`}</small></span>
  </div>)}</div>;
}

export function EditableAttachmentTiles({ attachments, onRemove }: { attachments: DesktopAttachment[]; onRemove: (reference: string) => void }) {
  if (!attachments.length) return null;
  return <div className="attachment-tiles editable">{attachments.map((attachment) => <div className={`attachment-tile ${attachment.kind}`} key={attachment.reference}>
    {attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt={attachment.name} /> : <span className="file-glyph">◫</span>}
    <span><strong>{attachment.name}</strong><small>{Math.max(1, Math.ceil(attachment.bytes / 1024))} KB</small></span>
    <button aria-label={`移除 ${attachment.name}`} onClick={() => onRemove(attachment.reference)}>×</button>
  </div>)}</div>;
}

function eventText(event: RuntimeEvent): string | undefined {
  if (event.type === "task.started") return visibleMessageText(event.payload.taskPreview);
  if (event.type === "task.steered") return visibleMessageText(event.payload.text);
  if (event.type === "assistant.message") return event.payload.text;
  if (event.type === "tool.started") return event.payload.description;
  if (event.type === "tool.progress" || event.type === "runtime.notice") return event.payload.message;
  if (event.type === "tool.finished") return event.payload.summary;
  if (event.type === "task.finished") return event.payload.result ?? event.payload.error;
  if (event.type === "workspace.changed") return `${event.payload.change.files.length} 个文件变更`;
  return undefined;
}

function activityText(event: RuntimeEvent): string | undefined {
  if (event.type === "model.started") return `第 ${event.payload.turn} 轮模型调用已开始`;
  if (event.type === "model.finished") return event.payload.responseReceived === false ? "模型请求已停止，未收到完整响应" : "模型响应已接收，正在整理下一步";
  if (event.type === "tool.started") return `运行 ${event.payload.name} · ${event.payload.description}`;
  if (event.type === "tool.progress") return `${event.payload.name} · ${event.payload.message}`;
  if (event.type === "tool.finished") return `${event.payload.name} · ${event.payload.summary}`;
  if (event.type === "workspace.changed") return `已编辑 ${event.payload.change.files.length} 个文件`;
  if (event.type === "plan.updated") return "任务计划已更新";
  if (event.type === "runtime.notice") return event.payload.message;
  return undefined;
}

type TimelineProps = { events: RuntimeEvent[]; draft?: string; pendingMessage?: { text: string; timestamp: string; steering: boolean; attachments: DesktopAttachment[] }; state: RuntimeTaskState | "idle"; modelLabel: string; submittedAttachments?: Record<string, DesktopAttachment[]>; expandProcesses?: boolean; taskStartedAt?: string; onAcceptance?: () => void };

export function ActiveTaskStatus({ events, state, modelLabel }: TimelineProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const activity = currentRuntimeActivity(events, undefined, state, modelLabel);
  const lastModel = [...events].reverse().find((event) => event.type === "model.started");
  const waiting = activity?.label.startsWith("正在思考");
  const seconds = lastModel ? Math.max(0, Math.floor((now - Date.parse(lastModel.timestamp)) / 1000)) : 0;
  return <div className="active-task-status" role="status" aria-live="polite"><span className="pulse" /><strong>{waiting ? "正在等待模型响应" : activity?.label ?? "正在处理任务"}</strong><small>{waiting ? `已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒 · 长响应可能需要更久，可随时停止` : activity?.detail}</small></div>;
}

function ConversationRound({ events, state, modelLabel, submittedAttachments, taskStartedAt, onAcceptance }: TimelineProps) {
  const preferences = usePreferences();
  const round = roundPresentation(events);
  const computerResult = events.some(event => (event.type === "tool.started" || event.type === "tool.finished") && event.payload.name === "computer_input");
  const active = !round.finished && ["running", "waiting_approval", "stopping"].includes(state);
  const [expanded, setExpanded] = useState(active && preferences.processExpanded);
  const [alertsExpanded, setAlertsExpanded] = useState(preferences.alertsExpanded);
  useEffect(() => setAlertsExpanded(preferences.alertsExpanded), [preferences.alertsExpanded]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setExpanded(active && preferences.processExpanded); if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active, preferences.processExpanded]);
  const activity = currentRuntimeActivity(events, undefined, active ? state : "idle", modelLabel);
  const label = activity?.label.includes("wait_agents") ? "等待子智能体完成" : activity?.label.includes("web_search") ? "正在搜索网页" : activity?.label.includes("web_open") ? "正在读取网页" : activity?.label;
  const start = events.find((e) => e.type === "task.started")?.timestamp ?? taskStartedAt;
  return <section className="conversation-round">
    {round.users.length > 0 && <DetailedTaskTimeline events={round.users} state="idle" modelLabel={modelLabel} submittedAttachments={submittedAttachments} />}
    {(round.process.length > 0 || active) && <details className={`turn-process ${active ? "active" : ""}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><span className={active ? "pulse" : "turn-chevron"}>{active ? "" : "›"}</span><span>{active ? `${label ?? "正在处理"} · ` : ""}{turnElapsed(start, active ? new Date(now).toISOString() : round.finished?.timestamp ?? events.at(-1)?.timestamp)}</span><small>{round.operations} 次操作{round.agents > 0 ? ` · ${round.agents} 个子任务` : ""}</small></summary>
      {round.process.length > 0 && <DetailedTaskTimeline events={round.process} state="idle" modelLabel={modelLabel} expandProcesses />}
    </details>}
    {round.alerts.length > 0 && <details className="turn-alerts" open={alertsExpanded} onToggle={(event) => setAlertsExpanded(event.currentTarget.open)}>
      <summary><span>运行提醒 · {round.alerts.length} 项</span><small>展开查看，不影响继续跟踪进展</small></summary>
      {round.alerts.map((event) => {
        const text = event.type === "task.finished" ? event.payload.error ?? event.payload.result ?? stateLabels[event.payload.state] : event.type === "subagent.updated" ? `${event.payload.agent.title}：${event.payload.agent.error ?? event.payload.agent.progress ?? event.payload.agent.status}` : eventText(event) ?? "操作未完成，请查看过程详情。";
        return <details className="turn-alert" key={event.eventId}>
          <summary title={text.split(/\r?\n/, 1)[0]}>{text.split(/\r?\n/, 1)[0]}</summary>
          <pre className="turn-alert-detail">{text}</pre>
        </details>;
      })}
    </details>}
    {round.finished?.type === "task.finished" && !["completed", "waiting_user"].includes(round.finished.payload.state) && !(computerResult && round.finished.payload.state === "unverified") && <div className="review-warning" role="status">程序验收：{stateLabels[round.finished.payload.state]}。{round.finished.payload.error?.split("\n")[0] ?? "请查看运行提醒和证据。"}{round.answer ? " 以下是模型回复，不代表程序验收通过。" : ""}{round.finished.payload.error?.includes("\n") && <details><summary>查看未通过校验</summary><pre className="turn-alert-detail">{round.finished.payload.error.split("\n").slice(1).join("\n")}</pre></details>}</div>}
    {computerResult && round.finished?.type === "task.finished" && ["completed", "failed", "unverified"].includes(round.finished.payload.state) && <ComputerAcceptance taskId={round.finished.taskId} programState={round.finished.payload.state} disabled={activeStates.has(state)} onChange={onAcceptance} />}
    {round.answer && <DetailedTaskTimeline events={[round.answer]} state="idle" modelLabel={modelLabel} />}
  </section>;
}

export function TaskTimeline(props: TimelineProps) {
  const rounds = conversationRounds(props.events);
  if (!rounds.length) return <DetailedTaskTimeline {...props} />;
  return <div className="timeline conversation-timeline">{rounds.map((round, index) => <ConversationRound onAcceptance={props.onAcceptance} taskStartedAt={index === rounds.length - 1 ? props.taskStartedAt : undefined} key={round.id} events={round.events} state={index === rounds.length - 1 ? props.state : "idle"} modelLabel={props.modelLabel} submittedAttachments={props.submittedAttachments} />)}{(props.pendingMessage || props.draft) && <DetailedTaskTimeline {...props} events={[]} state="idle" />}</div>;
}

function DetailedTaskTimeline({ events, draft, pendingMessage, state, modelLabel, submittedAttachments = {}, expandProcesses = false }: TimelineProps) {
  const items = groupedTimelineItems(events, state);
  const activity = currentRuntimeActivity(events, draft, state, modelLabel);
  if (!items.length && !draft && !pendingMessage && !activity) return <div className="task-welcome"><Logo /><h2>告诉 Xiu 你想完成什么</h2><p>Xiu 可以协助开发和本机软件排障；操作将遵循你选择的权限模式。</p></div>;
  return <div className="timeline">
    {items.map((item) => item.kind === "activity" ? <details className={`process-group ${item.active ? "active" : ""}`} open={item.active || expandProcesses} key={item.id}>
      <summary><span aria-hidden="true" className={item.active ? "pulse" : "process-icon"}>{item.active ? "" : "›"}</span><strong>{item.active ? activity?.label ?? "正在处理" : "运行记录"}</strong><small>{item.active ? activity?.detail : `${item.events.length} 条事件`}</small></summary>
      <div>{(() => { const progress = modelProgressSummary(item.events); return progress && <article className={`model-progress-summary ${progress.providerVisible ? "provider-visible" : "factual"}`}><header><strong>{progress.title}</strong><small>{progress.providerVisible ? "模型公开输出" : "可核验运行事实"}</small></header><p>{progress.text}</p></article>; })()}{activityRows(item.events).map(({ event, webText, evidence }) => (webText || activityText(event)) && <div key={event.eventId}><p className={`process-row process-${event.type.replace(".", "-")}`}><span>{event.type === "workspace.changed" ? "✎" : event.type.startsWith("tool.") ? "⌘" : event.type === "plan.updated" ? "☷" : "·"}</span><span>{webText ?? activityText(event)}</span><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>{evidence && <details className="web-result-details"><summary>查看检索结果详情</summary><FormattedText text={webEvidenceForDisplay(evidence)} /></details>}</div>)}</div>
    </details> : item.event.type === "subagent.updated" ? <SubagentActivity key={item.event.eventId} agent={item.event.payload.agent} /> : <article className={`event-card event-${item.event.type.replace(".", "-")}`} key={item.event.eventId}>
      {(() => { const event = item.event; return <>
      <header><span>{event.type === "assistant.message" && event.payload.hasToolCalls ? "Xiu · 公开思考摘要" : eventTitle(event)}</span><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
      {eventText(event) && <div className="event-text"><FormattedText text={eventText(event)!} /></div>}
      {(event.type === "task.started" || event.type === "task.steered") && submittedAttachments[event.eventId]?.length > 0 && <AttachmentTiles attachments={submittedAttachments[event.eventId]} compact />}
      </>; })()}
    </article>)}
    {pendingMessage && <article className="event-card event-task-started pending-message"><header><span>{pendingMessage.steering ? "你 · 补充要求" : "你"}</span><time>{new Date(pendingMessage.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>{pendingMessage.text && <div className="event-text">{pendingMessage.text}</div>}<AttachmentTiles attachments={pendingMessage.attachments} compact /></article>}
    {draft && <article className="event-card draft"><header><span>Xiu · 正在生成</span><span className="pulse" /></header><div className="event-text"><FormattedText text={draft} /></div></article>}
    {activity && !items.some((item) => item.kind === "activity" && item.active) && <div className="runtime-activity"><span className="pulse" /><span><strong>{activity.label}</strong><small>{activity.detail}</small></span></div>}
  </div>;
}

export type ChangeEntry = DesktopReviewSnapshot["changes"]["changes"][number];

export function HistoryTimeline({ history, submittedAttachments, onClose, onDiff, onAcceptance }: { history: DesktopTaskHistorySnapshot; submittedAttachments?: Record<string, DesktopAttachment[]>; onClose: () => void; onDiff: (change: ChangeEntry) => void; onAcceptance?: () => void }) {
  submittedAttachments = { ...submittedAttachments, ...history.attachments };
  return <div className="history-view"><header><div><span className="eyebrow">{history.fidelity === "exact" ? "完整运行过程" : "从现有记录重建"}</span><h2>{history.title}</h2><small>{history.manualAcceptance?.decision === "passed" ? "人工验收通过 · 程序状态：" : ""}{stateLabels[history.status] ?? history.status}{history.providerId || history.model ? ` · ${[history.providerId, history.model].filter(Boolean).join(" / ")}` : ""}</small></div><button onClick={onClose}>退出会话</button></header>{history.events.length ? <TaskTimeline onAcceptance={onAcceptance} events={history.events} submittedAttachments={submittedAttachments} state="idle" modelLabel={[history.providerId, history.model].filter(Boolean).join(" · ") || "Xiu"} /> : <div className="timeline">{history.entries.map((entry) => <article className={`event-card history-${entry.kind}`} key={entry.id}><header><span>{entry.title}</span></header><div className="event-text"><FormattedText text={visibleMessageText(entry.text)} /></div></article>)}</div>}<ChangeSummaryCard report={history.changes} legacy onDiff={onDiff} /></div>;
}

export function ChangeSummaryCard({ report, legacy = false, onDiff }: { report?: DesktopReviewSnapshot["changes"]; legacy?: boolean; onDiff: (change: ChangeEntry) => void }) {
  if (!report) return <section className="change-summary-card unavailable"><div><span className="change-summary-icon">⌁</span><span><strong>没有历史变更快照</strong><small>该任务创建于快照功能启用前；不会用当前工作区变化伪造本任务 Diff。</small></span></div></section>;
  let additions = 0;
  let deletions = 0;
  let approximate = !report.complete || report.warnings.length > 0;
  for (const change of report.changes) {
    const stats = changeStats(change);
    additions += stats.additions; deletions += stats.deletions; approximate ||= stats.approximate;
  }
  const files = report.changes;
  if (!files.length) return null;
  return <details className="change-summary-card">
    <summary><span className="change-summary-icon">±</span><span><strong>已编辑 {files.length} 个文件</strong><small>{approximate && <span>范围估算：</span>}<b className="added">+{additions}</b><b className="removed">-{deletions}</b>{approximate ? " · 非精确增删统计" : legacy ? " · 已保存历史快照" : " · 本任务最终快照"}</small><em>{files.slice(0, 3).map((file) => file.path).join("、") || "没有检测到文件变化"}</em></span><i>{files.length > 3 ? `再显示 ${files.length - 3} 个文件` : "审查"}</i></summary>
    <div>{files.length === 0 ? <p>任务完成时没有检测到文件变化。</p> : files.map((file) => { const stats = changeStats(file); return <button key={file.path} onClick={() => onDiff(file)}><span className={`change-kind ${file.kind}`}>{file.kind === "created" ? "A" : file.kind === "deleted" ? "D" : file.kind === "unknown" ? "?" : "M"}</span><span>{file.path}</span><small><b className="added">+{stats.additions}</b><b className="removed">-{stats.deletions}</b></small></button>; })}</div>
  </details>;
}
