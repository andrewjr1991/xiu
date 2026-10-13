import { randomUUID } from "node:crypto";

/** Metadata only: never copy tool arguments, output, or private reasoning. */
export interface SubagentToolActivity {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export function updateSubagentActivity(
  entries: SubagentToolActivity[], name: string, phase: "started" | "completed" | "failed" | "interrupted", timestamp = new Date().toISOString(),
): SubagentToolActivity[] {
  const safeName = /^[a-zA-Z0-9_.:-]{1,80}$/.test(name) ? name : "tool";
  if (phase === "started") return [...entries, { id: randomUUID(), name: safeName, status: "running" as const, startedAt: timestamp }].slice(-100);
  const index = entries.map((entry) => entry.name === safeName && entry.status === "running").lastIndexOf(true);
  if (index < 0) return entries;
  return entries.map((entry, position) => position !== index ? entry : {
    ...entry, status: phase, completedAt: timestamp,
    durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(entry.startedAt)),
  });
}

export function finishSubagentActivity(entries: SubagentToolActivity[], timestamp = new Date().toISOString()): SubagentToolActivity[] {
  return entries.map((entry) => entry.status !== "running" ? entry : {
    ...entry, status: "interrupted", completedAt: timestamp,
    durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(entry.startedAt)),
  });
}
