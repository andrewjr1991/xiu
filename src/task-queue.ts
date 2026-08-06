import { randomUUID } from "node:crypto";

export interface QueuedTaskInput {
  id: string;
  text: string;
  createdAt: string;
}

export type FailureRecoveryAction = "stop" | "retry" | "continue";

export function failureRecoveryOptions(queued: number): Array<{ label: string; description: string; value: FailureRecoveryAction }> {
  return [
    { label: "Stop and return", description: "Clear scheduled tasks and return to the normal prompt", value: "stop" },
    { label: "Retry unfinished task", description: "Continue from the current conversation without restarting investigation", value: "retry" },
    ...(queued ? [{ label: "Skip and run scheduled tasks", description: `Continue with ${queued} explicitly scheduled task(s)`, value: "continue" as const }] : []),
  ];
}

export class TaskInputQueue {
  private items: QueuedTaskInput[] = [];

  constructor(private readonly limit = 20) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Task input queue limit must be a positive integer.");
  }

  enqueue(text: string): QueuedTaskInput {
    return this.insert(text, false);
  }

  prepend(text: string): QueuedTaskInput {
    return this.insert(text, true);
  }

  private insert(text: string, front: boolean): QueuedTaskInput {
    const normalized = text.trim();
    if (!normalized) throw new Error("Queued input cannot be empty.");
    if (this.items.length >= this.limit) throw new Error(`Task input queue is full (${this.limit}).`);
    const item = { id: randomUUID().slice(0, 8), text: normalized, createdAt: new Date().toISOString() };
    if (front) this.items.unshift(item);
    else this.items.push(item);
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
  private currentTurn = 0;
  private maximumTurns = 0;
  private readonly startedAt = Date.now();
  private detailed = false;
  private activities: Array<{ timestamp: number; text: string }> = [];

  constructor(private readonly maxCharacters = 256_000) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error("Running task output limit must be a positive integer.");
  }

  setPhase(phase: string): void {
    this.currentPhase = phase.replace(/\s+/g, " ").trim() || "Working";
  }

  setTurn(turn: number, maximum?: number): void {
    this.currentTurn = turn;
    this.maximumTurns = maximum ?? 0;
  }

  activity(text: string): void {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || this.activities.at(-1)?.text === normalized) return;
    this.activities.push({ timestamp: Date.now(), text: normalized });
    if (this.activities.length > 50) this.activities.shift();
  }

  toggleDetails(): boolean {
    this.detailed = !this.detailed;
    return this.detailed;
  }

  detailsVisible(): boolean {
    return this.detailed;
  }

  progressLines(): string[] {
    const count = this.detailed ? 8 : 1;
    return this.activities.slice(-count).map((item) => {
      const elapsed = Math.max(0, Math.floor((item.timestamp - this.startedAt) / 1000));
      return `  +${elapsed}s ${item.text}`;
    });
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  turn(): { current: number; maximum: number } {
    return { current: this.currentTurn, maximum: this.maximumTurns };
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

export function formatRunningInputFooter(view: RunningTaskView, queued: number, steering: number, baseFooter: string): string {
  const turn = view.turn();
  const elapsed = Math.floor(view.elapsedMs() / 1000);
  const queue = queued ? `${queued} queued` : "queue empty";
  const steeringState = steering ? `${steering} steering` : "no steering";
  const details = view.detailsVisible() ? "Ctrl+O hide progress" : "Ctrl+O show progress";
  const turnLabel = turn.maximum ? `${turn.current || "-"}/${turn.maximum}` : `${turn.current || "-"}`;
  const headline = `Working: Turn ${turnLabel} | ${view.phase()} | ${elapsed}s | ${steeringState} | ${queue}`;
  return [headline, ...view.progressLines(), `${details} | Enter steers current | /queue <task> schedules next | Ctrl+C cancels`, baseFooter].join("\n");
}
