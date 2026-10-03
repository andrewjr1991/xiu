import type { RuntimeEvent } from "../../shared/protocol.js";

export function conversationRounds(events: RuntimeEvent[]) {
  const rounds: { id: string; events: RuntimeEvent[] }[] = [];
  for (const event of events) {
    let round = rounds.at(-1);
    if (!round || event.type === "task.started" || event.taskId !== round.events[0]?.taskId) {
      round = { id: event.taskId, events: [] }; rounds.push(round);
    }
    round.events.push(event);
  }
  return rounds;
}

export function roundPresentation(events: RuntimeEvent[]) {
  const finished = [...events].reverse().find((e) => e.type === "task.finished");
  const replies = events.filter((e) => e.type === "assistant.message" && !e.payload.hasToolCalls && e.payload.text.trim());
  const lastReply = replies.at(-1);
  const answer = finished?.type === "task.finished" && finished.payload.state === "completed" && finished.payload.result?.trim()
    ? finished : lastReply;
  const users = events.filter((e) => e.type === "task.started" || e.type === "task.steered");
  const candidates = events.filter((e) => e.type === "runtime.notice" && e.payload.kind === "failure"
    || e.type === "task.finished" && e.payload.state !== "completed"
    || e.type === "tool.finished" && ["failure", "denied", "cancelled"].includes(e.payload.result?.status ?? ""));
  const failedChildren = new Map<string, RuntimeEvent>();
  for (const event of events) if (event.type === "subagent.updated") {
    if (["failed", "blocked", "interrupted"].includes(event.payload.agent.status)) failedChildren.set(event.payload.agent.id, event);
    else failedChildren.delete(event.payload.agent.id);
  }
  candidates.push(...failedChildren.values());
  const alertText = (e: RuntimeEvent) => e.type === "runtime.notice" ? e.payload.message
    : e.type === "tool.finished" ? e.payload.summary
    : e.type === "task.finished" ? e.payload.error ?? e.payload.result ?? ""
    : e.type === "subagent.updated" ? `${e.payload.agent.title}: ${e.payload.agent.error ?? e.payload.agent.progress ?? e.payload.agent.status}` : "";
  const normalize = (text: string) => text.replace(/^(?:模型请求失败：|Model request failed:\s*|[\w]+:\s*)?(?:Tool error:\s*)?/, "").trim();
  const seen = new Set<string>();
  const alerts = candidates.filter((e) => {
    const text = normalize(alertText(e));
    // Agent emits a short failure notice immediately before the full tool
    // result. Keep the result once, rather than displaying two orange cards.
    if (e.type === "runtime.notice" && candidates.some((other) => other.type === "tool.finished"
      && Math.abs(Date.parse(other.timestamp) - Date.parse(e.timestamp)) <= 2_000
      && normalize(alertText(other).split(/\r?\n/, 1)[0]!) === text)) return false;
    const reply = answer?.type === "assistant.message" ? normalize(answer.payload.text) : "";
    if (text && (seen.has(text) || text === reply)) return false;
    if (text) seen.add(text);
    return true;
  });
  // Duplicate notices remain in storage, but not twice in the conversation.
  const excluded = new Set([...users, ...candidates, ...(answer ? [answer] : [])].map((e) => e.eventId));
  const process = events.filter((e) => !excluded.has(e.eventId) && e.type !== "task.finished"
    && !(e.type === "assistant.message" && answer?.type === "task.finished" && e.payload.text.trim() === answer.payload.result?.trim()));
  const operations = events.filter((e) => e.type === "tool.started").length;
  const agents = new Set(events.filter((e) => e.type === "subagent.updated").map((e) => e.payload.agent.id)).size;
  return { users, process, answer, alerts, finished, operations, agents };
}

export function turnElapsed(start: string | undefined, end: string | undefined): string {
  const elapsed = Date.parse(end ?? "") - Date.parse(start ?? "");
  if (!Number.isFinite(elapsed) || elapsed < 0) return "用时未记录";
  const seconds = Math.floor(elapsed / 1000);
  return `用时 ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ` : ""}${seconds % 60} 秒`;
}
