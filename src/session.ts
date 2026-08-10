import fs from "node:fs/promises";
import path from "node:path";
import type { ConversationMessage } from "./types.js";
import type { TaskPlan } from "./plan.js";
import { restoreTaskDiagnostics, type TaskDiagnosticSnapshot } from "./diagnostics.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";

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
  diagnostics?: TaskDiagnosticSnapshot;
  replay: SessionReplayTurn[];
}

export interface SessionReplayTurn {
  task: string;
  inputKind?: "task" | "answer" | "system";
  supplements: string[];
  response?: string;
  changes: WorkspaceChangeNotice[];
  receipts: string[];
  question?: string;
  completion?: { message: string; success: boolean };
  diagnostics?: TaskDiagnosticSnapshot;
  exact: boolean;
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
  let diagnostics: TaskDiagnosticSnapshot | undefined;
  const replay: SessionReplayTurn[] = [];
  let replayTurn: SessionReplayTurn | undefined;
  const finishReplayTurn = (): void => {
    if (!replayTurn) return;
    if (!replayTurn.response?.trim()) delete replayTurn.response;
    replay.push(replayTurn);
    replayTurn = undefined;
  };
  for (const event of events) {
    if (event.type === "task") {
      finishReplayTurn();
      const task = String(event.task ?? "");
      messages.push({ role: "user", content: String(event.contextualTask ?? task) });
      replayTurn = { task, inputKind: inferInputKind(task), supplements: [], changes: [], receipts: [], exact: false };
    }
    else if (event.type === "assistant") {
      const text = String(event.text ?? "");
      messages.push({
        role: "assistant",
        content: text,
        raw: event.raw,
        toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls as ConversationMessage["toolCalls"] : undefined,
      });
      if (replayTurn && text.trim()) replayTurn.response = text;
    }
    else if (event.type === "tool") messages.push({ role: "tool", content: String(event.contextResult ?? event.result ?? ""), toolCallId: String(event.id ?? ""), toolName: String(event.name ?? "") });
    else if (event.type === "completion_gate") messages.push({ role: "user", content: String(event.message ?? "") });
    else if (event.type === "compact") messages = [{ role: "user", content: String(event.context ?? event.summary ?? "") }];
    else if (event.type === "stats" && event.stats) stats = { ...stats, ...event.stats as Partial<SessionStats> };
    else if (event.type === "model_changed" && typeof event.model === "string") model = event.model;
    else if (event.type === "plan" && event.plan) plan = event.plan as TaskPlan;
    else if (event.type === "plan_mode") planMode = Boolean(event.enabled);
    else if (event.type === "diagnostics") {
      diagnostics = restoreTaskDiagnostics(event.snapshot)?.snapshot();
      if (replayTurn && diagnostics) replayTurn.diagnostics = diagnostics;
    }
    else if (event.type === "steering" && replayTurn && Array.isArray(event.items)) replayTurn.supplements.push(...event.items.map(String));
    else if (event.type === "ui_turn" && event.turn && typeof event.turn === "object") {
      const saved = event.turn as Partial<SessionReplayTurn>;
      replayTurn = {
        task: typeof saved.task === "string" ? saved.task : replayTurn?.task ?? "",
        inputKind: saved.inputKind === "answer" || saved.inputKind === "system" ? saved.inputKind : "task",
        supplements: Array.isArray(saved.supplements) ? saved.supplements.map(String) : replayTurn?.supplements ?? [],
        response: typeof saved.response === "string" ? saved.response : undefined,
        changes: Array.isArray(saved.changes) ? saved.changes as WorkspaceChangeNotice[] : [],
        receipts: Array.isArray(saved.receipts) ? saved.receipts.map(String) : [],
        question: typeof saved.question === "string" ? saved.question : undefined,
        completion: saved.completion && typeof saved.completion.message === "string"
          ? { message: saved.completion.message, success: Boolean(saved.completion.success) }
          : undefined,
        diagnostics: saved.diagnostics,
        exact: true,
      };
    }
  }
  finishReplayTurn();
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
    diagnostics,
    replay,
  };
}

function inferInputKind(task: string): SessionReplayTurn["inputKind"] {
  if (/^(?:Continue the unfinished task|Continue the task that paused for user input|继续此前因等待用户回答|继续未完成任务)/i.test(task.trim())) return "system";
  return "task";
}

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce((sum, message) => {
    const contentTokens = estimateTextTokens(message.content);
    const rawTokens = message.raw === undefined ? 0 : estimateTextTokens(JSON.stringify(message.raw));
    return sum + Math.max(contentTokens, rawTokens) + 4;
  }, 0);
}

export function estimateTextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  let astral = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) ascii++;
    else {
      nonAscii++;
      if (codePoint > 0xffff) astral++;
    }
  }
  return Math.ceil(ascii / 4 + nonAscii + astral);
}

function transcriptText(message: ConversationMessage): string {
  return message.content
    .split(/\n\nAutomatically prepared project context:/, 1)[0]!
    .trim();
}

/** Legacy formatter retained for API compatibility. The CLI uses structured replay. */
export function formatRestoredConversation(messages: ConversationMessage[], language: UiLanguage, maximum = Number.POSITIVE_INFINITY): string[] {
  const visible = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, text: transcriptText(message) }))
    .filter((message) => message.text && !/^Completion gate:/i.test(message.text));
  const selected = visible.slice(-maximum);
  const omitted = visible.length - selected.length;
  const lines = [localize(language, "会话内容：", "Conversation:")];
  if (omitted > 0) lines.push(localize(language, `  … 已省略较早的 ${omitted} 条消息`, `  ... ${omitted} earlier message(s) omitted`));
  for (const message of selected) {
    const label = message.role === "user" ? localize(language, "你", "You") : "Xiu";
    lines.push(`${label}> ${message.text}`);
  }
  return lines;
}
