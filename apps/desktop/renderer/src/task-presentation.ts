import type { RuntimeEvent, RuntimeTaskState } from "../../shared/protocol.js";

const timelineTypes = new Set<RuntimeEvent["type"]>([
  "task.started",
  "task.steered",
  "assistant.message",
  "tool.started",
  "tool.finished",
  "workspace.changed",
  "runtime.notice",
  "task.finished",
  "subagent.updated",
]);

export interface RuntimeActivity {
  label: string;
  detail: string;
}

export interface ModelProgressSummary {
  title: string;
  text: string;
  providerVisible: boolean;
}

export type TimelineItem =
  | { kind: "event"; event: RuntimeEvent }
  | { kind: "activity"; id: string; events: RuntimeEvent[]; active: boolean };

const activityTypes = new Set<RuntimeEvent["type"]>([
  "model.started", "model.finished", "tool.started", "tool.progress", "tool.finished",
  "plan.updated", "workspace.changed", "runtime.notice",
]);

/** Groups auditable runtime activity without exposing hidden model chain-of-thought. */
export function groupedTimelineItems(events: RuntimeEvent[], state: RuntimeTaskState | "idle"): TimelineItem[] {
  const items: TimelineItem[] = [];
  let activity: RuntimeEvent[] = [];
  const flush = () => {
    if (!activity.length) return;
    items.push({ kind: "activity", id: activity[0]!.eventId, events: activity, active: false });
    activity = [];
  };
  let lastAssistant = "";
  for (const event of events) {
    if (activityTypes.has(event.type)) {
      if (event.type === "model.started" && activity.some((item) => item.type === "model.started")) flush();
      activity.push(event);
      continue;
    }
    if (!timelineEventIsVisible(event)) continue;
    if (event.type === "assistant.message") lastAssistant = event.payload.text.trim();
    if (event.type === "task.finished" && event.payload.state === "completed" && event.payload.result?.trim() === lastAssistant && lastAssistant) continue;
    flush();
    items.push({ kind: "event", event });
  }
  flush();
  const last = items.at(-1);
  if (last?.kind === "activity" && ["running", "waiting_approval", "stopping"].includes(state)) last.active = true;
  return items;
}

export function runtimeActivityDetails(events: RuntimeEvent[], draft?: string): string[] {
  const details: string[] = [];
  if (draft?.trim()) details.push(`已安全接收 ${[...draft].length} 个可展示字符`);
  for (const event of [...events].reverse()) {
    let text: string | undefined;
    if (event.type === "model.started") text = `第 ${event.payload.turn} 轮模型调用已开始`;
    else if (event.type === "tool.started") text = `准备运行 ${event.payload.name}：${event.payload.description}`;
    else if (event.type === "tool.progress") text = `${event.payload.name}：${event.payload.message}`;
    else if (event.type === "tool.finished") text = `${event.payload.name} 已完成`;
    else if (event.type === "plan.updated") text = "任务计划已更新";
    else if (event.type === "workspace.changed") text = `检测到 ${event.payload.change.files.length} 个文件变更`;
    else if (event.type === "runtime.notice") text = event.payload.message;
    if (text && !details.includes(text)) details.push(text);
    if (details.length >= 5) break;
  }
  return details;
}

/** Builds a factual per-turn progress note; it never invents private model reasoning. */
export function modelProgressSummary(events: RuntimeEvent[]): ModelProgressSummary | undefined {
  const started = events.find((event) => event.type === "model.started");
  if (!started || started.type !== "model.started") return undefined;
  const visible = events.find((event) => event.type === "assistant.message" && event.payload.text.trim());
  if (visible?.type === "assistant.message") {
    return { title: `公开思考摘要 · 第 ${started.payload.turn} 轮`, text: visible.payload.text.trim(), providerVisible: true };
  }
  const details: string[] = [];
  const plan = [...events].reverse().find((event) => event.type === "plan.updated");
  if (plan?.type === "plan.updated") {
    const current = plan.payload.plan.steps.find((step) => step.status === "in_progress")?.title;
    details.push(current ? `当前计划：${current}` : `计划目标：${plan.payload.plan.goal}`);
  }
  const tools = events.filter((event): event is Extract<RuntimeEvent, { type: "tool.started" }> => event.type === "tool.started");
  if (tools.length) details.push(`本轮选择执行：${tools.slice(0, 3).map((event) => event.payload.description || event.payload.name).join("；")}${tools.length > 3 ? `；另 ${tools.length - 3} 项` : ""}`);
  const changed = events.filter((event): event is Extract<RuntimeEvent, { type: "workspace.changed" }> => event.type === "workspace.changed")
    .reduce((sum, event) => sum + event.payload.change.files.length, 0);
  if (changed) details.push(`已检测到 ${changed} 个文件变更`);
  const verified = events.filter((event) => event.type === "tool.finished" && event.payload.verification).length;
  if (verified) details.push(`已完成 ${verified} 项验证`);
  return {
    title: `模型进展 · 第 ${started.payload.turn} 轮`,
    text: details.join("。") || "模型响应已接收；该轮没有返回可展示的文字说明，以下只呈现程序可核验的运行事实。",
    providerVisible: false,
  };
}

export function timelineEventIsVisible(event: RuntimeEvent): boolean {
  if (!timelineTypes.has(event.type)) return false;
  if (event.type === "assistant.message") return event.payload.text.trim().length > 0;
  return true;
}

export function visibleTimelineEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  let lastAssistant = "";
  const visible: RuntimeEvent[] = [];
  for (const event of events) {
    if (!timelineEventIsVisible(event)) continue;
    if (event.type === "assistant.message") lastAssistant = event.payload.text.trim();
    if (event.type === "task.finished" && event.payload.state === "completed" && event.payload.result?.trim() === lastAssistant && lastAssistant) continue;
    visible.push(event);
  }
  return visible;
}

export function mergeRuntimeEvents(current: RuntimeEvent[], incoming: RuntimeEvent[]): RuntimeEvent[] {
  const merged = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) merged.set(event.eventId, event);
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence).slice(-200);
}

export function currentRuntimeActivity(
  events: RuntimeEvent[],
  draft: string | undefined,
  state: RuntimeTaskState | "idle",
  modelLabel: string,
): RuntimeActivity | undefined {
  if (state === "waiting_approval") return { label: "等待你的批准", detail: "确认后 Xiu 会从当前步骤继续" };
  if (state === "stopping") return { label: "正在安全停止", detail: "等待当前操作到达可中断边界" };
  if (state !== "running") return undefined;
  if (draft?.trim()) return { label: "正在生成回复", detail: modelLabel };

  const event = [...events].reverse().find((candidate) => [
    "task.started", "model.started", "model.finished", "assistant.message", "tool.started", "tool.progress",
    "tool.finished", "plan.updated", "workspace.changed", "approval.decided", "runtime.notice",
  ].includes(candidate.type));
  if (!event || event.type === "task.started") return { label: "正在读取项目并准备上下文", detail: modelLabel };
  if (event.type === "model.started") return { label: `正在思考 · 第 ${event.payload.turn} 轮`, detail: modelLabel };
  if (event.type === "model.finished") return { label: "正在整理模型响应", detail: modelLabel };
  if (event.type === "tool.started") return { label: `正在运行 ${event.payload.name}`, detail: event.payload.description };
  if (event.type === "tool.progress") return { label: `正在运行 ${event.payload.name}`, detail: event.payload.message };
  if (event.type === "tool.finished") return { label: "正在读取工具结果", detail: event.payload.name };
  if (event.type === "plan.updated") return { label: "正在更新任务计划", detail: modelLabel };
  if (event.type === "workspace.changed") return { label: "正在检查工作区变化", detail: modelLabel };
  if (event.type === "approval.decided") return { label: "审批已处理，正在继续", detail: modelLabel };
  if (event.type === "runtime.notice") return { label: "正在完成验证门禁", detail: event.payload.message };
  return { label: "正在准备下一步", detail: modelLabel };
}
