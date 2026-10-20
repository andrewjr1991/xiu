import { redactSecrets } from "../../../src/secret-redaction.js";
import { loadTaskChangeHistory } from "../../../src/task-change-history.js";
import { loadSession, type RestoredSession } from "../../../src/session.js";
import { safeTaskPreview, type TaskRunOperation, type TaskRunRecord } from "../../../src/task-run.js";
import { historyAttachmentReferences } from "./history-attachments.js";
import type { DesktopReviewOperation, DesktopTaskHistoryRequest, DesktopTaskHistorySnapshot } from "../shared/protocol.js";
import type { RuntimeEvent } from "../../../src/runtime/protocol.js";

/**
 * Desktop task history: turns a conversation's session log and journal runs
 * into the bounded, redacted transcript the renderer shows. Pure over its
 * inputs; the controller owns the host, the persistence barrier and the
 * busy checks around it.
 */

/** The journal access the history view needs. */
export type TaskHistoryJournal = { recent: (limit?: number) => Promise<TaskRunRecord[]> };

export type TaskHistorySession = Pick<RestoredSession, "id" | "updatedAt" | "providerId" | "model" | "messages" | "replay">;

export interface TaskHistoryIo {
  loadSession: (workspace: string, sessionId: string) => Promise<TaskHistorySession>;
  loadTaskChangeHistory: typeof loadTaskChangeHistory;
}

const defaultIo: TaskHistoryIo = { loadSession, loadTaskChangeHistory };

/** Rejects task IDs that are not plain identifiers before any file is touched. */
export function assertTaskHistoryRequest(request: DesktopTaskHistoryRequest): void {
  if (!request || typeof request.taskId !== "string" || !/^[A-Za-z0-9-]{1,160}$/.test(request.taskId)) throw new Error("Invalid task history request.");
}

export async function buildTaskHistorySnapshot(workspace: string, request: DesktopTaskHistoryRequest, journal: TaskHistoryJournal, io: TaskHistoryIo = defaultIo): Promise<DesktopTaskHistorySnapshot> {
  assertTaskHistoryRequest(request);
  const allRuns = await journal.recent(500);
  const selectedRun = allRuns.find((run) => run.runId === request.taskId);
  const sessionId = selectedRun?.sessionId ?? request.taskId;
  const runs = allRuns.filter((item) => item.sessionId === sessionId).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const run = runs.at(-1);
  const session = await io.loadSession(workspace, sessionId);
  const clean = (value: string, maximum = 32_000) => [...redactSecrets(value).trim()].slice(0, maximum).join("");
  const entries: DesktopTaskHistorySnapshot["entries"] = [];
  const push = (kind: DesktopTaskHistorySnapshot["entries"][number]["kind"], title: string, text: string) => {
    const safe = clean(text);
    if (safe) entries.push({ id: `${session.id}-${entries.length + 1}`, kind, title, text: safe });
  };
  const turnEntries: Array<{ preview: string; entries: DesktopTaskHistorySnapshot["entries"] }> = [];
  for (const turn of session.replay) {
    const start = entries.length;
    push("user", turn.inputKind === "system" ? "系统续接" : "你", turn.task);
    for (const supplement of turn.supplements) push("user", "你 · 补充要求", supplement);
    for (const receipt of turn.receipts) push("activity", "运行记录", receipt);
    if (turn.changes.length) push("activity", "工作区变更", `${turn.changes.reduce((sum, change) => sum + change.files.length, 0)} 个文件变更`);
    if (turn.response) push("assistant", "Xiu", turn.response);
    if (turn.question) push("assistant", "Xiu · 等待回答", turn.question);
    if (turn.completion && turn.completion.message !== turn.response) push("completion", turn.completion.success ? "已完成" : "未完成", turn.completion.message);
    turnEntries.push({ preview: safeTaskPreview(turn.task, workspace), entries: entries.slice(start) });
  }
  if (!entries.length) {
    for (const message of session.messages) {
      if (message.role === "user") push("user", "你", message.content);
      else if (message.role === "assistant") push("assistant", "Xiu", message.content);
    }
  }
  const completeEventHistory = runs.length > 0 && runs.every((item) => (item.runtimeEvents?.length ?? 0) > 0);
  // A legacy round must not downgrade newer exact rounds or inherit another
  // round's reply. Ambiguous legacy previews have no attributable reply.
  let sequence = 0;
  const historyEvents = runs.flatMap((item) => {
    if (item.runtimeEvents?.length) return combineHistoryEvents([item]);
    const matching = turnEntries.filter((turn) => turn.preview === item.taskPreview);
    const uniqueRun = runs.filter((candidate) => candidate.taskPreview === item.taskPreview).length === 1;
    return reconstructHistoryEvents(item, uniqueRun && matching.length === 1 ? matching[0]!.entries : []);
  }).map((event) => ({ ...event, sequence: ++sequence })).slice(-1_000);
  if (!runs.length) {
    // Legacy sessions may predate journals. Preserve attributable user and
    // assistant messages without inventing execution or completion evidence.
    for (const [index, turn] of turnEntries.entries()) {
      const taskId = `${session.id}-round-${index + 1}`;
      for (const [entryIndex, entry] of turn.entries.entries()) {
        const type = entry.kind === "user" ? entryIndex === 0 ? "task.started" : "task.steered" : entry.kind === "assistant" ? "assistant.message" : undefined;
        if (!type) continue;
        historyEvents.push({ schemaVersion: 1, eventId: `${taskId}-${entryIndex}`, taskId, sequence: ++sequence, timestamp: session.updatedAt,
          type, payload: type === "task.started" ? { taskPreview: entry.text } : type === "task.steered" ? { text: entry.text } : { text: entry.text, hasToolCalls: false } } as RuntimeEvent);
      }
    }
  }
  let changes;
  const changeRounds = await Promise.all(runs.slice(-80).map(async (candidate) => ({ id: candidate.runId, startedAt: candidate.startedAt, report: await io.loadTaskChangeHistory(workspace, candidate.runId) })));
  for (const candidate of [...runs].reverse()) {
    changes = await io.loadTaskChangeHistory(workspace, candidate.runId);
    if (changes) break;
  }
  return {
    taskId: session.id,
    title: clean(session.replay[0]?.task ?? run?.taskPreview ?? "历史任务", 160),
    status: run?.status ?? "session",
    manualAcceptance: run?.manualAcceptance ? { eligible: true, ...run.manualAcceptance } : undefined,
    updatedAt: run?.updatedAt ?? session.updatedAt,
    ...(run?.providerId ?? session.providerId ? { providerId: run?.providerId ?? session.providerId } : {}),
    ...(run?.model ?? session.model ? { model: run?.model ?? session.model } : {}),
    entries: entries.slice(-200),
    events: historyEvents,
    attachmentReferences: historyAttachmentReferences(historyEvents, session.replay.flatMap(turn => [turn.task, ...turn.supplements]).map(text => redactSecrets(text))),
    fidelity: completeEventHistory ? "exact" : "reconstructed",
    changeRounds,
    ...(changes ? { changes } : {}),
    tools: runs.flatMap((item) => item.operations.filter((operation) => operation.kind === "tool").map((operation) => reviewOperation(operation, "command"))).slice(-80),
    validations: runs.flatMap((item) => item.operations.filter((operation) => operation.kind === "verification").map((operation) => reviewOperation(operation, "verification"))).slice(-80),
  };
}

export function reviewOperation(operation: TaskRunOperation, kind: DesktopReviewOperation["kind"]): DesktopReviewOperation {
  const started = Date.parse(operation.startedAt);
  const finished = operation.finishedAt ? Date.parse(operation.finishedAt) : Number.NaN;
  return {
    id: operation.id, kind, name: operation.name, status: operation.status, sideEffect: operation.sideEffect,
    ...(operation.risk ? { risk: operation.risk } : {}), startedAt: operation.startedAt,
    ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    ...(Number.isFinite(started) && Number.isFinite(finished) ? { durationMs: Math.max(0, finished - started) } : {}),
    ...(operation.evidence ? { evidence: redactSecrets(operation.evidence).slice(0, 2_000) } : {}),
  };
}

function combineHistoryEvents(runs: TaskRunRecord[]): RuntimeEvent[] {
  let sequence = 0;
  return runs.flatMap((run) => (run.runtimeEvents ?? [])
    .filter((event) => event && event.schemaVersion === 1)
    .map((event) => ({
      ...structuredClone(event),
      taskId: run.runId,
      sequence: ++sequence,
    } as RuntimeEvent))).slice(-1_000);
}

function reconstructHistoryEvents(run: TaskRunRecord | undefined, entries: DesktopTaskHistorySnapshot["entries"]): RuntimeEvent[] {
  if (!run) return [];
  const events: RuntimeEvent[] = [];
  let sequence = 0;
  let cursor = Date.parse(run.startedAt);
  const timestamp = () => new Date(Number.isFinite(cursor) ? cursor++ : Date.now()).toISOString();
  const push = <K extends RuntimeEvent["type"]>(type: K, payload: Extract<RuntimeEvent, { type: K }>["payload"], at?: string) => {
    sequence++;
    events.push({ schemaVersion: 1, eventId: `history-${run.runId}-${sequence}`, taskId: run.runId, sequence, timestamp: at ?? timestamp(), type, payload } as RuntimeEvent);
  };
  push("task.started", { taskPreview: run.taskPreview }, run.startedAt);
  let modelTurn = 0;
  for (const operation of run.operations) {
    if (operation.kind === "model") {
      modelTurn++;
      push("model.started", { turn: modelTurn }, operation.startedAt);
      push("model.finished", {}, operation.finishedAt);
    } else if (operation.kind === "checkpoint") {
      push("runtime.notice", { kind: "checkpoint", message: operation.evidence ?? operation.name }, operation.finishedAt ?? operation.startedAt);
    } else if (operation.kind === "steering") {
      push("runtime.notice", { kind: "checkpoint", message: operation.evidence ?? "补充要求已记录" }, operation.finishedAt ?? operation.startedAt);
    } else {
      const verification = operation.kind === "verification";
      // Legacy web journals store result evidence, not the original query/action.
      const description = operation.name === "web_search" || operation.name === "web_open"
        ? operation.name : operation.evidence ?? operation.name;
      push("tool.started", { name: operation.name, description, changesWorkspace: operation.sideEffect === "workspace", verification, risk: operation.risk ?? "read" }, operation.startedAt);
      if (operation.finishedAt) push("tool.finished", { name: operation.name, summary: operation.evidence ?? operation.status, verification }, operation.finishedAt);
    }
  }
  for (const entry of entries) {
    if (entry.kind === "assistant") push("assistant.message", { text: entry.text, hasToolCalls: false });
    else if (entry.kind === "user" && entry.title.includes("补充")) push("task.steered", { text: entry.text });
  }
  const state = run.status === "abandoned" ? "cancelled" : run.status;
  const completion = [...entries].reverse().find((entry) => entry.kind === "completion")?.text;
  if (state !== "running") push("task.finished", { state, ...(completion ? { result: completion } : {}) }, run.finishedAt ?? run.updatedAt);
  return events;
}
