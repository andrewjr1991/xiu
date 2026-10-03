import type { RuntimeEvent } from "../../shared/protocol.js";
import type { RuntimeSubagentCard } from "../../../../src/runtime/protocol.js";

/** Pure task selection must remain usable without desktop/React dependencies. */
export function subagentCards(events: RuntimeEvent[], snapshot: RuntimeSubagentCard[] = []) {
  const cards = new Map<string, RuntimeSubagentCard>();
  for (const event of events) {
    if (event.type === "task.started") cards.clear();
    if (event.type === "subagent.updated") cards.set(event.payload.agent.id, event.payload.agent);
  }
  for (const agent of snapshot) cards.set(agent.id, agent);
  return [...cards.values()];
}

/** Both panes use the same conversation; history must never override an active task. */
export function selectedTaskView<T extends { events: RuntimeEvent[] }>(history: T | undefined, active: boolean, pending: boolean, events: RuntimeEvent[], agents?: RuntimeSubagentCard[]) {
  const selectedHistory = !active && !pending ? history : undefined;
  return { history: selectedHistory, events: selectedHistory?.events ?? events, agents: selectedHistory ? undefined : agents };
}

export const subagentLabels: Record<string, string> = { pending: "已派发，等待中", running: "开始工作", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", blocked: "已阻塞", explorer: "调查", implementer: "实现", reviewer: "审查", tester: "验证" };

/** One chronological entry per observed state change; progress ticks are not new work. */
export function subagentLifecycleEvents(events: RuntimeEvent[]): Set<string> {
  const last = new Map<string, string>();
  const visible = new Set<string>();
  for (const event of events) if (event.type === "subagent.updated") {
    const agent = event.payload.agent;
    if (last.get(agent.id) !== agent.status) visible.add(event.eventId);
    last.set(agent.id, agent.status);
  }
  return visible;
}

export function subagentElapsed(agent: RuntimeSubagentCard, now: number, live: boolean): number | undefined {
  if (agent.durationMs !== undefined && Number.isFinite(agent.durationMs)) return Math.max(0, agent.durationMs);
  const start = Date.parse(agent.startedAt ?? "");
  const end = agent.completedAt ? Date.parse(agent.completedAt) : live && agent.status === "running" ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}
