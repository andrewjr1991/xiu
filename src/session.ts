import fs from "node:fs/promises";
import { IMAGE_TOKEN_ESTIMATE } from "./tool-images.js";
import path from "node:path";
import type { ConversationMessage, ThinkingReplayBlock } from "./types.js";
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
  providerId?: string;
  lastResponseProtocolIssue?: "missing_finish_reason" | "unsupported_finish_reason";
  lastStreamTimedOut?: boolean;
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
  providerId?: string;
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

export interface SessionListing {
  /** Newest first, as `listSessions` returns them. */
  sessions: SessionListItem[];
  /** Session logs skipped because they could not be read, by id, with the system error code and never a path. */
  unreadable: Array<{ id: string; reason: string }>;
}

/**
 * Lists the workspace's saved sessions. A log that cannot be read (a directory in its place, no
 * permission, an I/O error) is skipped and named in `unreadable`, so one bad file does not hide
 * every other session from `/resume`, `/history sessions`, the desktop task list or the report.
 * Malformed lines inside a readable log are still skipped line by line.
 */
export async function listSessions(cwd: string): Promise<SessionListItem[]> {
  return (await listSessionsWithIssues(cwd)).sessions;
}

export async function listSessionsWithIssues(cwd: string): Promise<SessionListing> {
  const items: SessionListItem[] = [];
  const unreadable: SessionListing["unreadable"] = [];
  const directories = [sessionDirectory(cwd), path.join(cwd, ".forge", "sessions"), path.join(cwd, ".forge_sessions")];
  for (const directory of directories) {
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    for (const name of files.filter((file) => file.endsWith(".jsonl"))) {
      const file = path.join(directory, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      let events: Array<Record<string, unknown>>;
      try { [stat, events] = await Promise.all([fs.stat(file), readEvents(file)]); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        unreadable.push({ id: sessionId(file), reason: typeof code === "string" && code ? code : "unreadable" });
        continue;
      }
      const firstTask = events.find((event) => event.type === "task");
      // A task that failed before its `task` event was logged still names itself in the turn record
      // and the diagnostics snapshot; a log with none of those is listed with an empty title.
      const firstTurn = events.find((event) => event.type === "ui_turn");
      const firstDiagnostics = events.find((event) => event.type === "diagnostics");
      const title = [
        firstTask?.task,
        (firstTurn?.turn as Record<string, unknown> | undefined)?.task,
        (firstDiagnostics?.snapshot as Record<string, unknown> | undefined)?.task,
      ].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
      const lastModel = [...events].reverse().find((event) => event.type === "model_changed" || event.type === "provider_changed" || event.type === "task");
      const lastProvider = [...events].reverse().find((event) => event.type === "provider_changed" || event.type === "task");
      items.push({
        id: sessionId(file),
        file,
        createdAt: String(events[0]?.timestamp ?? stat.birthtime.toISOString()),
        updatedAt: String(events.at(-1)?.timestamp ?? stat.mtime.toISOString()),
        firstTask: title,
        model: typeof lastModel?.model === "string"
          ? lastModel.model
          : typeof (lastModel?.config as Record<string, unknown> | undefined)?.model === "string"
            ? String((lastModel?.config as Record<string, unknown>).model)
            : undefined,
        providerId: typeof lastProvider?.providerId === "string"
          ? lastProvider.providerId
          : typeof (lastProvider?.config as Record<string, unknown> | undefined)?.providerId === "string"
            ? String((lastProvider?.config as Record<string, unknown>).providerId)
            : typeof (lastProvider?.config as Record<string, unknown> | undefined)?.provider === "string"
              ? String((lastProvider?.config as Record<string, unknown>).provider)
              : undefined,
        size: stat.size,
      });
    }
  }
  unreadable.sort((a, b) => a.id.localeCompare(b.id));
  return { sessions: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), unreadable };
}

/** The title a session list shows: its first task, or the language's "untitled" label. */
export function sessionTitle(session: Pick<SessionListItem, "firstTask">, language: UiLanguage, maximum = 72): string {
  return session.firstTask.replace(/\s+/g, " ").trim().slice(0, maximum) || localize(language, "未命名会话", "Untitled session");
}

/** A log timestamp as local `YYYY-MM-DD HH:mm:ss` for session lists; anything unparsable is returned as is. */
export function formatSessionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One line naming how many session logs a list leaves out and why; undefined when none. */
export function unreadableSessionsNote(unreadable: SessionListing["unreadable"], language: "zh-CN" | "en-US"): string | undefined {
  if (!unreadable.length) return undefined;
  const counts = new Map<string, number>();
  for (const item of unreadable) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const reasons = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} ×${count}`);
  return language === "zh-CN"
    ? `另有 ${unreadable.length} 个会话日志无法读取（${reasons.join("、")}），未列出。`
    : `${unreadable.length} more session log(s) could not be read (${reasons.join(", ")}) and are not listed.`;
}

/** Delete one exact local conversation log without touching workspace content. */
export async function deleteSession(cwd: string, requested: string): Promise<boolean> {
  if (!/^[A-Za-z0-9-]{1,160}$/.test(requested)) throw new Error("Invalid session deletion request.");
  const selected = (await listSessions(cwd)).filter((item) => item.id === requested);
  if (!selected.length) return false;
  for (const item of selected) {
    const stat = await fs.lstat(item.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe session deletion target.");
  }
  for (const item of selected) await fs.unlink(item.file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

export async function loadSession(cwd: string, requested?: string): Promise<RestoredSession> {
  const { sessions, unreadable } = await listSessionsWithIssues(cwd);
  const selected = requested
    ? sessions.find((item) => item.id === requested || item.id.startsWith(requested))
    : sessions[0];
  if (!selected) {
    const broken = requested ? unreadable.find((item) => item.id === requested || item.id.startsWith(requested)) : undefined;
    if (broken) throw Object.assign(new Error(`Session log cannot be read (${broken.reason}): ${broken.id}`), { code: broken.reason });
    if (!sessions.length) throw new Error("No Xiu sessions exist in this workspace.");
    throw new Error(`Session not found in this workspace: ${requested}`);
  }
  if (requested && sessions.filter((item) => item.id.startsWith(requested)).length > 1 && !sessions.some((item) => item.id === requested)) {
    throw new Error(`Session id prefix is ambiguous: ${requested}`);
  }
  const file = selected.file;
  const events = await readEvents(file);
  let messages: ConversationMessage[] = [];
  let stats = emptySessionStats();
  let model = selected.model;
  let providerId = selected.providerId;
  let lastResponseProtocolIssue: RestoredSession["lastResponseProtocolIssue"];
  let lastStreamTimedOut = false;
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
      if (event.config && typeof event.config === "object") {
        const saved = event.config as Record<string, unknown>;
        if (typeof saved.providerId === "string") providerId = saved.providerId;
        else if (typeof saved.provider === "string") providerId = saved.provider;
      }
    }
    else if (event.type === "model_timeout" && event.transport === "stream") {
      lastStreamTimedOut = true;
    }
    else if (event.type === "model_protocol") {
      lastStreamTimedOut = false;
    }
    else if (event.type === "assistant") {
      lastResponseProtocolIssue = event.protocolIssue === "missing_finish_reason" || event.protocolIssue === "unsupported_finish_reason" ? event.protocolIssue : undefined;
      const text = String(event.text ?? "");
      messages.push({
        role: "assistant",
        content: text,
        raw: event.raw,
        toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls as ConversationMessage["toolCalls"] : undefined,
        thinkingReplay: restoredThinkingReplay(event.thinkingReplay),
      });
      if (replayTurn && text.trim()) replayTurn.response = text;
    }
    else if (event.type === "tool") messages.push({ role: "tool", content: String(event.contextResult ?? event.result ?? ""), toolCallId: String(event.id ?? ""), toolName: String(event.name ?? "") });
    else if (event.type === "completion_gate") messages.push({ role: "user", content: String(event.message ?? "") });
    else if (event.type === "compact") messages = [{ role: "user", content: String(event.context ?? event.summary ?? "") }];
    else if (event.type === "stats" && event.stats) stats = { ...stats, ...event.stats as Partial<SessionStats> };
    else if (event.type === "model_changed" && typeof event.model === "string") { model = event.model; lastStreamTimedOut = false; lastResponseProtocolIssue = undefined; }
    else if (event.type === "provider_changed") {
      lastStreamTimedOut = false; lastResponseProtocolIssue = undefined;
      if (typeof event.providerId === "string") providerId = event.providerId;
      if (typeof event.model === "string") model = event.model;
    }
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
    providerId,
    lastResponseProtocolIssue,
    lastStreamTimedOut,
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

/** Accepts only the opaque block shapes Xiu itself persists; anything readable is left behind. */
function restoredThinkingReplay(value: unknown): ThinkingReplayBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: ThinkingReplayBlock[] = [];
  for (const block of value as Array<Record<string, unknown>>) {
    if (block?.type === "thinking" && block.thinking === "" && typeof block.signature === "string") blocks.push({ type: "thinking", thinking: "", signature: block.signature });
    else if (block?.type === "redacted_thinking" && typeof block.data === "string") blocks.push({ type: "redacted_thinking", data: block.data });
  }
  return blocks.length ? blocks : undefined;
}

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce((sum, message) => {
    const contentTokens = estimateTextTokens(message.content);
    const rawTokens = message.raw === undefined ? 0 : estimateTextTokens(JSON.stringify(message.raw));
    const imageTokens = (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
    return sum + Math.max(contentTokens, rawTokens) + imageTokens + 4;
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
