import type { DesktopReviewSnapshot, DesktopTaskHistorySnapshot, RuntimeEvent } from "../../shared/protocol.js";
import type { RuntimeTaskSnapshot } from "../../../../src/runtime/protocol.js";
import { changeStats } from "./change-stats.js";

const excerpt = (text: string, limit: number) => {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
};

/** Stage snapshots, not a second copy of the request or every token/tool event. */
export function stageSummary(round: RuntimeEvent[], snapshot?: RuntimeTaskSnapshot) {
  const started = round.find(event => event.type === "task.started");
  const request = started?.type === "task.started" ? started.payload.taskPreview : snapshot?.taskPreview;
  const planEvent = [...round].reverse().find(event => event.type === "plan.updated");
  const plan = planEvent?.type === "plan.updated" ? planEvent.payload.plan : snapshot?.plan;
  const finished = [...round].reverse().find(event => event.type === "task.finished");
  const reply = [...round].reverse().find(event => event.type === "assistant.message" && event.payload.text.trim() && event.payload.text.trim() !== request?.trim());
  const terminal = snapshot && ["completed", "failed", "cancelled", "unverified", "paused"].includes(snapshot.state) ? snapshot : undefined;
  const state = finished?.type === "task.finished" ? finished.payload.state : terminal?.state;
  const goal = plan?.goal && plan.goal.trim() !== request?.trim() ? excerpt(plan.goal, 120) : undefined;
  if (state) {
    const labels: Record<string, string> = { completed: "已完成", failed: "未完成", cancelled: "已取消", unverified: "待验证", paused: "已暂停" };
    const result = finished?.type === "task.finished" ? finished.payload.error || finished.payload.result : terminal?.error || terminal?.result;
    return { goal, phase: "结果摘要", summary: `${labels[state] ?? state}${result ? `：${excerpt(result, 300)}` : "，详情见任务记录。"}`, updatedAt: finished?.timestamp ?? terminal?.updatedAt };
  }
  if (plan) {
    const completed = plan.steps.filter(step => step.status === "completed").length;
    const current = plan.steps.find(step => step.status === "in_progress");
    const note = reply?.type === "assistant.message" && (!planEvent || reply.timestamp >= planEvent.timestamp) ? excerpt(reply.payload.text, 120) : undefined;
    const summary = `计划 ${completed}/${plan.steps.length} 步已完成${current ? `；当前：${excerpt(current.title, 140)}` : "；等待下一阶段"}。${note ? `进展：${note}` : ""}`;
    return { goal, phase: "阶段摘要", summary, updatedAt: note ? reply?.timestamp : planEvent?.timestamp ?? snapshot?.updatedAt };
  }
  if (reply?.type === "assistant.message") return { goal: undefined, phase: "阶段摘要", summary: excerpt(reply.payload.text, 240), updatedAt: reply.timestamp };
  return { goal: undefined, phase: undefined, summary: undefined, updatedAt: undefined };
}

/** Only the selected round contributes activity; workspace metadata is separately labelled. */
export function taskOverview(events: RuntimeEvent[], history?: DesktopTaskHistorySnapshot, review?: DesktopReviewSnapshot, workspace?: string, snapshot?: RuntimeTaskSnapshot) {
  const lastStart = [...events].reverse().find((event) => event.type === "task.started");
  const start = lastStart ? events.indexOf(lastStart) : -1;
  const round = start < 0 ? events : events.slice(start);
  const taskId = round.at(-1)?.taskId;
  const matched = !history && Boolean(taskId && review?.overview?.taskId === taskId && review.overview.workspace === workspace);
  const currentEnvironment = !history && review?.overview?.workspace === workspace;
  const changes = history?.changes ?? (matched ? review?.overview?.taskChanges : undefined);
  let additions = 0, deletions = 0;
  for (const entry of changes?.changes ?? []) {
    const stats = changeStats(entry);
    additions += stats.additions; deletions += stats.deletions;
  }
  const skills = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const event of round) {
    if (event.type !== "tool.started") continue;
    const { name, description } = event.payload;
    if (name === "read_skill" || name.startsWith("mcp__")) skills.set(name + description, name === "read_skill" ? description.slice(0, 180) : name);
    if (/^(web_search|web_open|read_file|glob|grep|mcp__.*(?:read|fetch|get))/i.test(name)) sources.set(name + description, description.slice(0, 240));
  }
  const summary = stageSummary(round, !history && (!taskId || taskId === snapshot?.id) ? snapshot : undefined);
  return {
    ...summary,
    branch: currentEnvironment ? review?.overview?.branch : undefined,
    changes, additions, deletions, approximateCounts: changes ? !changes.complete || changes.changes.some(entry => changeStats(entry).approximate) : false,
    skills: [...skills.values()].slice(-30), sources: [...sources.values()].slice(-30),
    background: currentEnvironment ? (review?.background ?? []).slice(0, 20) : [],
    artifacts: (changes?.changes ?? []).filter((entry) => ["created", "modified"].includes(entry.kind)).slice(0, 30),
  };
}
