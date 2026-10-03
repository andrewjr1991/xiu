import type { DesktopReviewSnapshot, DesktopTaskHistorySnapshot, RuntimeEvent } from "../../shared/protocol.js";

/** Only the selected round contributes activity; workspace metadata is separately labelled. */
export function taskOverview(events: RuntimeEvent[], history?: DesktopTaskHistorySnapshot, review?: DesktopReviewSnapshot, workspace?: string) {
  const lastStart = [...events].reverse().find((event) => event.type === "task.started");
  const start = lastStart ? events.indexOf(lastStart) : -1;
  const round = start < 0 ? events : events.slice(start);
  const taskId = round.at(-1)?.taskId;
  const matched = !history && Boolean(taskId && review?.overview?.taskId === taskId && review.overview.workspace === workspace);
  const currentEnvironment = !history && review?.overview?.workspace === workspace;
  const changes = history?.changes ?? (matched ? review?.overview?.taskChanges : undefined);
  let additions = 0, deletions = 0;
  for (const entry of changes?.changes ?? []) for (const line of entry.preview?.split("\n") ?? []) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  const skills = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const event of round) {
    if (event.type !== "tool.started") continue;
    const { name, description } = event.payload;
    if (name === "read_skill" || name.startsWith("mcp__")) skills.set(name + description, name === "read_skill" ? description.slice(0, 180) : name);
    if (/^(web_search|web_open|read_file|glob|grep|mcp__.*(?:read|fetch|get))/i.test(name)) sources.set(name + description, description.slice(0, 240));
  }
  const goal = round.find((event) => event.type === "task.started");
  const lastReply = [...round].reverse().find((event) => event.type === "assistant.message");
  const finished = [...round].reverse().find((event) => event.type === "task.finished");
  return {
    goal: goal?.type === "task.started" ? goal.payload.taskPreview : history?.title,
    summary: finished?.type === "task.finished" ? finished.payload.error || finished.payload.result : lastReply?.type === "assistant.message" ? lastReply.payload.text : undefined,
    updatedAt: round.at(-1)?.timestamp ?? history?.updatedAt,
    branch: currentEnvironment ? review?.overview?.branch : undefined,
    changes, additions, deletions,
    skills: [...skills.values()].slice(-30), sources: [...sources.values()].slice(-30),
    background: currentEnvironment ? (review?.background ?? []).slice(0, 20) : [],
    artifacts: (changes?.changes ?? []).filter((entry) => ["created", "modified"].includes(entry.kind)).slice(0, 30),
  };
}
