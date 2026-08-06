import { randomUUID } from "node:crypto";

export interface QueuedTaskInput {
  id: string;
  text: string;
  createdAt: string;
}

export class TaskInputQueue {
  private items: QueuedTaskInput[] = [];

  constructor(private readonly limit = 20) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Task input queue limit must be a positive integer.");
  }

  enqueue(text: string): QueuedTaskInput {
    const normalized = text.trim();
    if (!normalized) throw new Error("Queued input cannot be empty.");
    if (this.items.length >= this.limit) throw new Error(`Task input queue is full (${this.limit}).`);
    const item = { id: randomUUID().slice(0, 8), text: normalized, createdAt: new Date().toISOString() };
    this.items.push(item);
    return item;
  }

  dequeue(): QueuedTaskInput | undefined {
    return this.items.shift();
  }

  list(): QueuedTaskInput[] {
    return this.items.map((item) => ({ ...item }));
  }

  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }

  get size(): number {
    return this.items.length;
  }
}

export class RunningTaskView {
  private buffer = "";
  private truncated = false;
  private currentPhase = "Starting";

  constructor(private readonly maxCharacters = 256_000) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error("Running task output limit must be a positive integer.");
  }

  setPhase(phase: string): void {
    this.currentPhase = phase.replace(/\s+/g, " ").trim() || "Working";
  }

  phase(): string {
    return this.currentPhase;
  }

  write(value: string): void {
    if (!value) return;
    this.buffer += value;
    if (this.buffer.length > this.maxCharacters) {
      this.buffer = this.buffer.slice(-this.maxCharacters);
      this.truncated = true;
    }
  }

  line(value = ""): void {
    this.write(`${value}\n`);
  }

  drain(): string {
    const output = `${this.truncated ? "[Earlier live output was truncated; complete tool output remains available in /details.]\n" : ""}${this.buffer}`;
    this.buffer = "";
    this.truncated = false;
    return output;
  }
}

export function formatRunningInputFooter(phase: string, queued: number, baseFooter: string): string {
  const queue = queued ? `${queued} queued` : "queue empty";
  return `Working: ${phase} | ${queue} | Enter queues follow-up | Ctrl+C cancels current\n${baseFooter}`;
}
