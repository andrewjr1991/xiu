import type { ReactNode } from "react";
import type { DesktopReviewSnapshot, DesktopTaskHistorySnapshot, DesktopReviewTab, RuntimeEvent } from "../../shared/protocol.js";
import type { RuntimeSubagentCard } from "../../../../src/runtime/protocol.js";
import { SubagentSummary } from "./TaskDataPanel.js";
import { taskOverview } from "./task-overview.js";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <details className="overview-group" open><summary>{title}</summary>{children}</details>;
}
export function TaskOverview({ hidden, task, events, history, review, workspace, agents, live, collapsed, onOpen }: {
  hidden: boolean;
  task?: import("../../../../src/runtime/protocol.js").RuntimeTaskSnapshot;
  events: RuntimeEvent[]; history?: DesktopTaskHistorySnapshot; review?: DesktopReviewSnapshot;
  workspace?: { name: string; path?: string }; agents?: RuntimeSubagentCard[];
  live: boolean; collapsed: boolean; onOpen: (tab: DesktopReviewTab) => void;
}) {
  const data = taskOverview(history?.events ?? events, history, review, workspace?.path);
  const goal = data.goal ?? (!history ? task?.taskPreview : undefined);
  const summary = data.summary ?? (!history ? task?.result : undefined);
  if (hidden) return null;
  const row = (text: string, tab: DesktopReviewTab, meta?: string) => <button className="overview-row" key={text} title={text} onClick={() => onOpen(tab)}><span>{text}</span>{meta && <small>{meta}</small>}</button>;
  return <section className="task-overview" aria-label="任务概览">
    <header><strong>{history ? "历史任务概览" : "任务概览"}</strong></header>
    {!hidden && <details className="overview-content" open={collapsed}><summary>查看环境与任务活动</summary><div>
      {goal && <Group title="任务摘要"><p className="overview-goal">{goal}</p>{summary && <p className="overview-excerpt" title={summary.slice(0, 1200)}>{summary.slice(0, 300)}</p>}{data.updatedAt && <small>更新于 {new Date(data.updatedAt).toLocaleTimeString()}</small>}</Group>}
      <Group title={history ? "已保存环境" : "当前环境"}>
        <p>{history ? "历史快照 · 不混入实时工作区状态" : `${workspace?.name ?? "本地工作区"} · 本地执行`}</p>
        {!history && <p title={workspace?.path}>{workspace?.path}</p>}
        {data.branch && <p title={data.branch}>分支：{data.branch}</p>}
        {data.changes ? row(`${data.changes.changes.length} 个变更文件 · +${data.additions} −${data.deletions}`, "changes", "本任务有界预览，行数可能不完整") : <small>本轮变更快照尚未记录</small>}
      </Group>
      <SubagentSummary events={history?.events ?? events} snapshot={history ? undefined : agents} live={!history && live} onOpen={() => onOpen("agents")} />
      {data.skills.length > 0 && <Group title="技能与 MCP · 本轮调用">{data.skills.map((text) => row(text, "data"))}</Group>}
      {data.background.length > 0 && <Group title="后台进程 · 当前工作区">{data.background.map((item) => row(item.command, "data", `${item.running ? "运行中" : "已结束"} · ${Math.floor(item.elapsedMs / 1000)} 秒`))}</Group>}
      {data.artifacts.length > 0 && <Group title="产出 · 本轮文件">{data.artifacts.map((item) => row(item.path, "changes"))}</Group>}
      {data.sources.length > 0 && <Group title="来源 · 本轮检索与读取">{data.sources.map((text) => row(text, "data"))}<small>调用记录不代表来源已核验；详情见任务证据。</small></Group>}
    </div></details>}
  </section>;
}
