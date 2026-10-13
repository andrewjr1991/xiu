import type { RuntimeSubagentCard } from "../../../../src/runtime/protocol.js";

const states = { running: "执行中", completed: "已完成", failed: "失败", interrupted: "已中断" };
/** Read-only metadata. Historical running entries must not animate or imply live execution. */
export function SubagentTools({ agent, live }: { agent: RuntimeSubagentCard; live: boolean }) {
  const entries = agent.activity ?? [];
  if (!entries.length) return <p className="empty-note">暂无工具执行记录；旧任务不补造明细。</p>;
  return <details className="subagent-tools" open={live && agent.status === "running"}>
    <summary>工具执行 · 最近 {entries.length} 次</summary>
    <ol>{entries.map((entry) => {
      const active = live && agent.status === "running" && entry.status === "running";
      const elapsed = entry.durationMs ?? (active ? Math.max(0, Date.now() - Date.parse(entry.startedAt)) : undefined);
      return <li key={entry.id} className={`tool-state-${entry.status}`}>
        <span aria-hidden="true">{active ? "◌" : entry.status === "completed" ? "✓" : entry.status === "failed" ? "!" : "·"}</span>
        <code>{entry.name}</code><small>{entry.status === "running" && !active ? "结束状态未记录" : states[entry.status]}</small>
        {elapsed !== undefined && Number.isFinite(elapsed) && <small>{(elapsed / 1000).toFixed(1)} 秒</small>}
      </li>;
    })}</ol>
    <small>仅展示工具名称、真实状态与耗时，不展示参数或原始输出。</small>
  </details>;
}
