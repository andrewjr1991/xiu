import type { DesktopReviewSnapshot, RuntimeEvent } from "../../shared/protocol.js";
import { useEffect, useState } from "react";
import { AgentAvatar } from "./AgentAvatar.js";
import { subagentCards, subagentElapsed, subagentLabels } from "./subagent-presentation.js";
export { subagentCards } from "./subagent-presentation.js";
import type { RuntimeSubagentCard } from "../../../../src/runtime/protocol.js";

export function SubagentActivity({ agent }: { agent: RuntimeSubagentCard }) {
  return <div className={`subagent-activity status-${agent.status}`}><AgentAvatar agent={agent} /><button onClick={() => window.dispatchEvent(new Event("xiu-inspect-agents"))}>{agent.title} · {subagentLabels[agent.status] ?? agent.status}</button><small>{subagentLabels[agent.role] ?? agent.role}</small>{(agent.result || agent.error) && <details><summary>{agent.error ? "查看失败原因" : "查看结果"}</summary><pre>{agent.error ?? agent.result}</pre></details>}</div>;
}

const labels: Record<string, string> = { pending: "等待中", planned: "计划中", started: "运行中", succeeded: "已完成", unknown: "待核验", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", blocked: "已阻塞", explorer: "调查", implementer: "实现", reviewer: "审查", tester: "测试" };
export function SubagentSummary({ events, snapshot, live, onOpen }: { events: RuntimeEvent[]; snapshot?: RuntimeSubagentCard[]; live: boolean; onOpen: () => void }) {
  const cards = subagentCards(events, snapshot).map((agent) => ({ ...agent, progress: /^(completed|succeeded|running|pending|cancelled|failed)[.!]?$/i.test(agent.progress?.trim() ?? "") ? undefined : agent.progress }));
  const [, tick] = useState(0);
  const running = live && cards.some((agent) => agent.status === "running");
  useEffect(() => { if (!running) return; const timer = setInterval(() => tick((value) => value + 1), 1000); return () => clearInterval(timer); }, [running]);
  if (!cards.length) return null;
  return <section className="subagent-summary" aria-label="本轮子智能体摘要"><header><strong>子智能体 · {cards.length}</strong><button onClick={onOpen}>查看详情 ↗</button></header><div>{cards.map((agent) => {
    const elapsed = subagentElapsed(agent, Date.now(), live);
    return <button className="subagent-summary-row" key={agent.id} onClick={onOpen} title={agent.title}><AgentAvatar agent={agent} /><span><strong>{agent.title}</strong><small>{labels[agent.role] ?? agent.role} · {labels[agent.status] ?? agent.status}{elapsed !== undefined && ` · ${Math.floor(elapsed / 1000)} 秒`}</small>{(agent.progress || agent.error) && <small className="subagent-summary-progress">{agent.error ?? agent.progress}</small>}</span></button>;
  })}</div></section>;
}
export function SubagentCards({ events, snapshot, compact = false, live = false, onCancel }: { events: RuntimeEvent[]; snapshot?: RuntimeSubagentCard[]; compact?: boolean; live?: boolean; onCancel?: (agent: RuntimeSubagentCard) => Promise<void> }) {
  const cards = subagentCards(events, snapshot);
  const [, tick] = useState(0);
  const [cancelling, setCancelling] = useState<string>();
  const [error, setError] = useState<string>();
  const running = live && cards.some((agent) => agent.status === "running");
  useEffect(() => { if (!running) return; const timer = setInterval(() => tick((value) => value + 1), 1000); return () => clearInterval(timer); }, [running]);
  return <div className="subagent-cards">{error && <p role="alert">{error}</p>}{cards.length ? cards.map((agent) => {
    const elapsed = subagentElapsed(agent, Date.now(), live);
    return <article className="subagent-card" key={agent.id}><header><AgentAvatar agent={agent} /><strong>{agent.title}</strong><small>{labels[agent.status] ?? agent.status}</small></header><footer>{labels[agent.role] ?? agent.role} · {elapsed === undefined ? agent.status === "pending" ? "等待调度或依赖完成" : "耗时未记录" : `${(elapsed / 1000).toFixed(1)} 秒`}{agent.mode && ` · ${agent.mode === "worktree" ? "隔离 Worktree" : "共享只读"}`}</footer>{agent.dependencies?.length ? <p>依赖任务：{agent.dependencies.join("、")}</p> : null}{agent.progress && <p>{agent.progress}</p>}{!compact && (agent.result || agent.error) && <details><summary>{agent.error ? "查看失败原因" : "查看结果"}</summary><pre>{agent.error ?? agent.result}</pre></details>}{live && onCancel && agent.taskId && ["pending", "running"].includes(agent.status) && <button className="secondary-button" disabled={Boolean(cancelling)} onClick={() => { setCancelling(agent.id); setError(undefined); void onCancel(agent).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setCancelling(undefined)); }}>{cancelling === agent.id ? "正在处理…" : "取消子任务"}</button>}</article>;
  }) : !compact && <p className="empty-note">该任务尚未启动子智能体。</p>}</div>;
}
function DataRow({ name, status, meta, detail }: { name: string; status?: string; meta?: string; detail?: string }) {
  return <details className="data-row"><summary><span className="data-row-name">{name}</span>{meta && <small>{meta}</small>}{status && <span className={`data-status ${status}`}>{labels[status] ?? status}</span>}</summary>{detail && <pre>{detail}</pre>}</details>;
}
function DataGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <details className="data-group" open={count > 0}><summary>{title}<span>{count}</span></summary>{count ? children : <p className="empty-note">暂无记录</p>}</details>;
}
export function TaskDataPanel({ events, review }: { events: RuntimeEvent[]; review?: DesktopReviewSnapshot }) {
  const sources = events.filter((event) => event.type === "tool.started" && /^(web_search|web_open|read_file|glob|grep|read_|mcp_.*(?:read|fetch|get))/i.test(event.payload.name));
  const artifacts = review?.artifacts ?? [];
  return <section className="review-pane task-data-panel">
    <DataGroup title="后台进程" count={review?.background?.length ?? 0}>{review?.background?.map((item) => <DataRow key={item.id} name={item.command} status={item.state} meta={`${Math.round(item.elapsedMs / 1000)} 秒`} detail={`输出 ${item.outputBytes} 字节；交互终端不计入任务证据。`} />)}</DataGroup>
    <DataGroup title="工具" count={review?.tools?.length ?? 0}>{review?.tools?.map((tool) => <DataRow key={tool.id} name={tool.name} status={tool.status} meta={tool.durationMs === undefined ? undefined : `${tool.durationMs} ms`} detail={tool.evidence ?? "无保存摘要"} />)}</DataGroup>
    <DataGroup title="产出" count={artifacts.length}>{artifacts.map((entry) => <DataRow key={entry.path} name={entry.path} detail="本次记录的新增或修改文件。" />)}</DataGroup>
    <DataGroup title="来源" count={sources.length}>{sources.map((event) => event.type === "tool.started" && <DataRow key={event.eventId} name={event.payload.name} meta="读取记录" detail={event.payload.description} />)}</DataGroup>
    <DataGroup title="验证证据" count={review?.validations.length ?? 0}>{review?.validations.map((item) => <DataRow key={item.id} name={item.name} status={item.status} detail={item.evidence ?? "无结果摘要"} />)}</DataGroup>
  </section>;
}
