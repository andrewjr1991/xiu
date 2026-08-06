import { randomUUID } from "node:crypto";
import type { TaskPlan, PlanStepStatus } from "./plan.js";

export interface QueuedTaskInput {
  id: string;
  text: string;
  createdAt: string;
}

export type FailureRecoveryAction = "stop" | "retry" | "continue";

export interface WorkspaceChangeNotice {
  tool: string;
  paths: string[];
  description: string;
}

type AutomaticStage = "analyzing" | "investigating" | "editing" | "verifying" | "finishing";

const AUTOMATIC_STEPS: Array<{ stage: AutomaticStage; title: string }> = [
  { stage: "analyzing", title: "Understand the task" },
  { stage: "investigating", title: "Inspect relevant files" },
  { stage: "editing", title: "Implement changes" },
  { stage: "verifying", title: "Verify the result" },
  { stage: "finishing", title: "Review and finish" },
];

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
  private currentPlan?: TaskPlan;
  private automaticStage: AutomaticStage = "analyzing";
  private changes: Array<{ timestamp: number; text: string }> = [];

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

  setPlan(plan?: TaskPlan): void {
    this.currentPlan = plan ? structuredClone(plan) : undefined;
  }

  beginTool(name: string, description: string, changesWorkspace = false, verification = false): void {
    if (verification) this.advanceAutomaticStage("verifying");
    else if (changesWorkspace) this.advanceAutomaticStage("editing");
    else if (/^(?:read_file|list_files|search_text|project_info|git_status|git_diff|git_log|vision_analyze)/.test(name)) this.advanceAutomaticStage("investigating");
    this.activity(`${name}: ${description}`);
  }

  recordWorkspaceChange(change: WorkspaceChangeNotice): void {
    const paths = change.paths.length ? change.paths.join(", ") : change.description;
    const action = change.tool === "write_file" ? "Wrote"
      : change.tool === "replace_text" || change.tool === "apply_patch" ? "Modified"
      : /^generate_(?:image|video)$/.test(change.tool) ? "Created"
      : "Workspace operation";
    const text = `${action}: ${paths}`.replace(/\s+/g, " ").trim();
    if (!text || this.changes.at(-1)?.text === text) return;
    this.changes.push({ timestamp: Date.now(), text });
    if (this.changes.length > 12) this.changes.shift();
  }

  markFinishing(): void {
    this.advanceAutomaticStage("finishing");
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
    if (!this.detailed) return this.summaryLines();
    return this.activities.slice(-8).map((item) => {
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

  private advanceAutomaticStage(stage: AutomaticStage): void {
    const currentIndex = AUTOMATIC_STEPS.findIndex((step) => step.stage === this.automaticStage);
    const nextIndex = AUTOMATIC_STEPS.findIndex((step) => step.stage === stage);
    if (nextIndex > currentIndex) this.automaticStage = stage;
  }

  private summaryLines(): string[] {
    const lines = this.currentPlan ? this.planSummaryLines(this.currentPlan) : this.automaticSummaryLines();
    const latestChange = this.changes.at(-1)?.text;
    if (latestChange) lines.push(`Changed: ${latestChange}`);
    return lines;
  }

  private planSummaryLines(plan: TaskPlan): string[] {
    const completed = plan.steps.filter((step) => step.status === "completed").length;
    const currentIndex = plan.steps.findIndex((step) => step.status === "in_progress");
    const nextIndex = plan.steps.findIndex((step, index) => index > currentIndex && step.status === "pending");
    const visible = plan.steps.length <= 6
      ? plan.steps
      : plan.steps.filter((step, index) => step.status === "in_progress" || step.status === "blocked" || index === nextIndex).slice(0, 4);
    const lines = [`Plan: ${completed}/${plan.steps.length} completed`];
    for (const step of visible) lines.push(`  ${this.stepIcon(step.status)} ${step.title}${step.note ? ` - ${step.note}` : ""}`);
    if (visible.length < plan.steps.length) lines.push(`  ... ${plan.steps.length - visible.length} more step(s)`);
    const current = currentIndex >= 0 ? plan.steps[currentIndex] : undefined;
    const next = nextIndex >= 0 ? plan.steps[nextIndex] : plan.steps.find((step) => step.status === "pending");
    lines.push(`Now: ${current?.title ?? (completed === plan.steps.length ? "Final review" : this.currentPhase)}`);
    if (next) lines.push(`Next: ${next.title}`);
    return lines;
  }

  private automaticSummaryLines(): string[] {
    const currentIndex = AUTOMATIC_STEPS.findIndex((step) => step.stage === this.automaticStage);
    const lines = [`Progress: automatic ${currentIndex}/${AUTOMATIC_STEPS.length} completed`];
    for (const [index, step] of AUTOMATIC_STEPS.entries()) {
      const status: PlanStepStatus = index < currentIndex ? "completed" : index === currentIndex ? "in_progress" : "pending";
      lines.push(`  ${this.stepIcon(status)} ${step.title}`);
    }
    lines.push(`Now: ${this.currentPhase}`);
    const next = AUTOMATIC_STEPS[currentIndex + 1];
    if (next) lines.push(`Next: ${next.title}`);
    return lines;
  }

  private stepIcon(status: PlanStepStatus): string {
    return ({ pending: "[ ]", in_progress: "[>]", completed: "[x]", blocked: "[!]" } as const)[status];
  }
}

export function formatRunningInputFooter(view: RunningTaskView, queued: number, steering: number, baseFooter: string): string {
  const turn = view.turn();
  const elapsed = Math.floor(view.elapsedMs() / 1000);
  const queue = queued ? `${queued} queued` : "queue empty";
  const steeringState = steering ? `${steering} steering` : "no steering";
  const details = view.detailsVisible() ? "Ctrl+O hide details" : "Ctrl+O show details";
  const turnLabel = turn.maximum ? `${turn.current || "-"}/${turn.maximum}` : `${turn.current || "-"}`;
  const headline = `Working: Turn ${turnLabel} | ${view.phase()} | ${elapsed}s | ${steeringState} | ${queue}`;
  return [headline, ...view.progressLines(), `${details} | Enter steers current | /queue <task> schedules next | Ctrl+C cancels`, baseFooter].join("\n");
}
