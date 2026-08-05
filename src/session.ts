import fs from "node:fs/promises";
import path from "node:path";
import type { ConversationMessage } from "./types.js";
import type { TaskPlan } from "./plan.js";

export interface SessionStats {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  compactions: number;
  activeMs: number;
}

export interface RestoredSession {
  id: string;
  file: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  messages: ConversationMessage[];
  stats: SessionStats;
  plan?: TaskPlan;
  planMode?: boolean;
}

export interface SessionListItem {
  id: string;
  file: string;
  createdAt: string;
  updatedAt: string;
  firstTask: string;
  model?: string;
  size: number;
}

export const emptySessionStats = (): SessionStats => ({
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedTokens: 0,
  compactions: 0,
  activeMs: 0,
});

function sessionDirectory(cwd: string): string {
  return path.join(cwd, ".xiu", "sessions");
}

function sessionId(file: string): string {
  return path.basename(file, ".jsonl");
}

async function readEvents(file: string): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(file, "utf8");
  return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; }
    catch { return []; }
  });
}

export async function listSessions(cwd: string): Promise<SessionListItem[]> {
  const items: SessionListItem[] = [];
  const directories = [sessionDirectory(cwd), path.join(cwd, ".forge", "sessions"), path.join(cwd, ".forge_sessions")];
  for (const directory of directories) {
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    for (const name of files.filter((file) => file.endsWith(".jsonl"))) {
      const file = path.join(directory, name);
      const [stat, events] = await Promise.all([fs.stat(file), readEvents(file)]);
      const firstTask = events.find((event) => event.type === "task");
      const lastModel = [...events].reverse().find((event) => event.type === "model_changed" || event.type === "task");
      items.push({
        id: sessionId(file),
        file,
        createdAt: String(events[0]?.timestamp ?? stat.birthtime.toISOString()),
        updatedAt: String(events.at(-1)?.timestamp ?? stat.mtime.toISOString()),
        firstTask: String(firstTask?.task ?? "Untitled session"),
        model: typeof lastModel?.model === "string"
          ? lastModel.model
          : typeof (lastModel?.config as Record<string, unknown> | undefined)?.model === "string"
            ? String((lastModel?.config as Record<string, unknown>).model)
            : undefined,
        size: stat.size,
      });
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadSession(cwd: string, requested?: string): Promise<RestoredSession> {
  const sessions = await listSessions(cwd);
  if (!sessions.length) throw new Error("No Xiu sessions exist in this workspace.");
  const selected = requested
    ? sessions.find((item) => item.id === requested || item.id.startsWith(requested))
    : sessions[0];
  if (!selected) throw new Error(`Session not found in this workspace: ${requested}`);
  if (requested && sessions.filter((item) => item.id.startsWith(requested)).length > 1 && !sessions.some((item) => item.id === requested)) {
    throw new Error(`Session id prefix is ambiguous: ${requested}`);
  }
  const file = selected.file;
  const events = await readEvents(file);
  let messages: ConversationMessage[] = [];
  let stats = emptySessionStats();
  let model = selected.model;
  let plan: TaskPlan | undefined;
  let planMode = false;
  for (const event of events) {
    if (event.type === "task") messages.push({ role: "user", content: String(event.contextualTask ?? event.task ?? "") });
    else if (event.type === "assistant") messages.push({
      role: "assistant",
      content: String(event.text ?? ""),
      raw: event.raw,
      toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls as ConversationMessage["toolCalls"] : undefined,
    });
    else if (event.type === "tool") messages.push({ role: "tool", content: String(event.result ?? ""), toolCallId: String(event.id ?? ""), toolName: String(event.name ?? "") });
    else if (event.type === "completion_gate") messages.push({ role: "user", content: String(event.message ?? "") });
    else if (event.type === "compact") messages = [{ role: "user", content: String(event.context ?? event.summary ?? "") }];
    else if (event.type === "stats" && event.stats) stats = { ...stats, ...event.stats as Partial<SessionStats> };
    else if (event.type === "model_changed" && typeof event.model === "string") model = event.model;
    else if (event.type === "plan" && event.plan) plan = event.plan as TaskPlan;
    else if (event.type === "plan_mode") planMode = Boolean(event.enabled);
  }
  stats.estimatedTokens = estimateConversationTokens(messages);
  return {
    id: selected.id,
    file,
    createdAt: selected.createdAt,
    updatedAt: selected.updatedAt,
    model,
    messages,
    stats,
    plan,
    planMode,
  };
}

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return Math.ceil(messages.reduce((sum, message) => sum + message.content.length + JSON.stringify(message.raw ?? "").length, 0) / 4);
}
