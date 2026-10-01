import type { DesktopReviewSnapshot, RuntimeEvent } from "../../shared/protocol.js";
import { useEffect, useState } from "react";

const labels: Record<string, string> = { pending: "等待中", planned: "计划中", started: "运行中", succeeded: "已完成", unknown: "待核验", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", blocked: "已阻塞", explorer: "调查", implementer: "实现", reviewer: "审查", tester: "测试" };
export function subagentCards(events: RuntimeEvent[]) {
  const cards = new Map<string, Extract<RuntimeEvent, { type: "subagent.updated" }>["payload"]["agent"]>();
  for (const event of events) if (event.type === "subagent.updated") cards.set(event.payload.agent.id, event.payload.agent);
  return [...cards.values()];
}
export function SubagentCards({ events, compact = false }: { events: RuntimeEvent[]; compact?: boolean }) {
  const cards = subagentCards(events);
  const [, tick] = useState(0);
  const running = cards.some((agent) => agent.status === "running");
  useEffect(() => { if (!running) return; const timer = setInterval(() => tick((value) => value + 1), 1000); return () => clearInterval(timer); }, [running]);
  return <div className="subagent-cards">{cards.length ? cards.map((agent) => <article className="subagent-card" key={agent.id}><header><span className={`agent-status ${agent.status}`} /><strong>{agent.title}</strong><small>{labels[agent.status] ?? agent.status}</small></header><footer>{labels[agent.role] ?? agent.role} · {agent.durationMs !== undefined ? `${(agent.durationMs / 1000).toFixed(1)} 秒` : agent.startedAt ? `${Math.max(0, Math.round(((agent.completedAt ? Date.parse(agent.completedAt) : Date.now()) - Date.parse(agent.startedAt)) / 1000))} 秒` : "尚未开始"}</footer>{agent.progress && <p>{agent.progress}</p>}{!compact && (agent.result || agent.error) && <details><summary>{agent.result ? "查看结果" : "查看失败原因"}</summary><pre>{agent.result ?? agent.error}</pre></details>}</article>) : !compact && <p className="empty-note">该任务尚未启动子智能体。</p>}</div>;
}
function DataRow({ name, status, meta, detail }: { name: string; status?: string; meta?: string; detail?: string }) {
  return <details className="data-row"><summary><span className="data-row-name">{name}</span>{meta && <small>{meta}</small>}{status && <span className={`data-status ${status}`}>{labels[status] ?? status}</span>}</summary>{detail && <pre>{detail}</pre>}</details>;
}
function DataGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <details className="data-group" open={count > 0}><summary>{title}<span>{count}</span></summary>{count ? children : <p className="empty-note">暂无记录</p>}</details>;
}
export function TaskDataPanel({ events, review }: { events: RuntimeEvent[]; review?: DesktopReviewSnapshot }) {
  const sources = events.filter((event) => event.type === "tool.started" && /^(read_file|glob|grep|read_|mcp_.*(?:read|fetch|get))/i.test(event.payload.name));
  const artifacts = review?.artifacts ?? [];
  return <section className="review-pane task-data-panel">
    <DataGroup title="后台进程" count={review?.background?.length ?? 0}>{review?.background?.map((item) => <DataRow key={item.id} name={item.command} status={item.state} meta={`${Math.round(item.elapsedMs / 1000)} 秒`} detail={`输出 ${item.outputBytes} 字节；交互终端不计入任务证据。`} />)}</DataGroup>
    <DataGroup title="工具" count={review?.tools?.length ?? 0}>{review?.tools?.map((tool) => <DataRow key={tool.id} name={tool.name} status={tool.status} meta={tool.durationMs === undefined ? undefined : `${tool.durationMs} ms`} detail={tool.evidence ?? "无保存摘要"} />)}</DataGroup>
    <DataGroup title="产出" count={artifacts.length}>{artifacts.map((entry) => <DataRow key={entry.path} name={entry.path} detail="本次记录的新增或修改文件。" />)}</DataGroup>
    <DataGroup title="来源" count={sources.length}>{sources.map((event) => event.type === "tool.started" && <DataRow key={event.eventId} name={event.payload.name} meta="读取记录" detail={event.payload.description} />)}</DataGroup>
    <DataGroup title="验证证据" count={review?.validations.length ?? 0}>{review?.validations.map((item) => <DataRow key={item.id} name={item.name} status={item.status} detail={item.evidence ?? "无结果摘要"} />)}</DataGroup>
  </section>;
}
