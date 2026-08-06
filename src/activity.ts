import { randomUUID } from "node:crypto";

export type ActivityState = "running" | "completed" | "failed";

export interface ActivityRecord {
  id: string;
  kind: "tool" | "agent" | "system";
  title: string;
  description: string;
  state: ActivityState;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  detail?: string;
}

export class ActivityLog {
  private records: ActivityRecord[] = [];
  constructor(private readonly limit = 100) {}

  start(kind: ActivityRecord["kind"], title: string, description: string): string {
    const id = randomUUID().slice(0, 8);
    this.records.push({ id, kind, title, description, state: "running", startedAt: new Date().toISOString() });
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    return id;
  }

  progress(id: string, summary: string): void {
    const record = this.records.find((item) => item.id === id);
    if (record) record.summary = summary;
  }

  finish(id: string, detail: string, failed = false): void {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    record.state = failed ? "failed" : "completed";
    record.completedAt = new Date().toISOString();
    record.detail = detail;
    record.summary = detail.replace(/\s+/g, " ").trim().slice(0, 180) || record.summary;
  }

  list(): ActivityRecord[] { return this.records.slice().reverse().map((item) => ({ ...item })); }
  get(id: string): ActivityRecord | undefined { return this.records.find((item) => item.id === id || item.id.startsWith(id)); }
}
