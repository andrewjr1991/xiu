import { randomUUID } from "node:crypto";
import type { TaskPlan, PlanStepStatus } from "./plan.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import { localize, type UiLanguage } from "./i18n.js";
import { formatTaskDiagnosticSummary, type TaskDiagnosticSnapshot } from "./diagnostics.js";

export interface QueuedTaskInput {
  id: string;
  text: string;
  createdAt: string;
}

function isEnglishNarrative(value: string): boolean {
  const words = value.replace(/`[^`]*`|(?:[A-Za-z]:)?[\\/][^\s]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|html|css|py)\b/g, " ").match(/[A-Za-z]{2,}/g) ?? [];
  return words.length >= 2 && !/[\u3400-\u9fff]/.test(value);
}

export type FailureRecoveryAction = "stop" | "retry" | "continue";

type AutomaticStage = "analyzing" | "investigating" | "editing" | "verifying" | "finishing";

function automaticSteps(language: UiLanguage): Array<{ stage: AutomaticStage; title: string }> {
  return [
    { stage: "analyzing", title: localize(language, "理解任务", "Understand the task") },
    { stage: "investigating", title: localize(language, "检查相关文件", "Inspect relevant files") },
    { stage: "editing", title: localize(language, "实施修改", "Implement changes") },
    { stage: "verifying", title: localize(language, "验证结果", "Verify the result") },
    { stage: "finishing", title: localize(language, "复核并完成", "Review and finish") },
  ];
}

export function failureRecoveryOptions(queued: number, language: UiLanguage = "en-US"): Array<{ label: string; description: string; value: FailureRecoveryAction }> {
  return [
    { label: localize(language, "停止并返回", "Stop and return"), description: localize(language, "清空后续任务并返回输入框", "Clear scheduled tasks and return to the normal prompt"), value: "stop" },
    { label: localize(language, "继续未完成任务", "Retry unfinished task"), description: localize(language, "沿用当前证据继续，不重新调查", "Continue from the current conversation without restarting investigation"), value: "retry" },
    ...(queued ? [{ label: localize(language, "跳过并运行排队任务", "Skip and run scheduled tasks"), description: localize(language, `继续运行 ${queued} 个已安排任务`, `Continue with ${queued} explicitly scheduled task(s)`), value: "continue" as const }] : []),
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
  private currentPhase: string;
  private currentTurn = 0;
  private maximumTurns = 0;
  private readonly startedAt = Date.now();
  private detailed = false;
  private activities: Array<{ timestamp: number; text: string }> = [];
  private currentPlan?: TaskPlan;
  private automaticStage: AutomaticStage = "analyzing";
  private changes: Array<{ timestamp: number; text: string }> = [];
  private pendingChanges: WorkspaceChangeNotice[] = [];
  private latestNarration = "";
  private completion?: { message: string; success: boolean };
  private importantActions: string[] = [];
  private diagnostics?: TaskDiagnosticSnapshot;

  constructor(private readonly maxCharacters = 256_000, private uiLanguage: UiLanguage = "en-US") {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error("Running task output limit must be a positive integer.");
    this.currentPhase = localize(uiLanguage, "正在启动", "Starting");
  }

  setPhase(phase: string): void {
    this.currentPhase = phase.replace(/\s+/g, " ").trim() || localize(this.uiLanguage, "处理中", "Working");
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
    else if (/^(?:read_file|extract_html|extract_json|extract_csv|repository_map|find_symbol|find_references|find_callers|list_files|search_text|project_info|git_status|git_diff|git_log|vision_analyze)/.test(name)) this.advanceAutomaticStage("investigating");
    this.activity(`${name}: ${description}`);
  }

  recordWorkspaceChange(change: WorkspaceChangeNotice): void {
    const paths = change.paths.length ? change.paths.join(", ") : change.description;
    const action = change.tool === "write_file" ? localize(this.uiLanguage, "已写入", "Wrote")
      : change.tool === "replace_text" || change.tool === "apply_patch" ? localize(this.uiLanguage, "已修改", "Modified")
      : /^generate_(?:image|video)$/.test(change.tool) ? localize(this.uiLanguage, "已创建", "Created")
      : localize(this.uiLanguage, "工作区操作", "Workspace operation");
    const text = `${action}: ${paths}`.replace(/\s+/g, " ").trim();
    if (!text || this.changes.at(-1)?.text === text) return;
    this.changes.push({ timestamp: Date.now(), text });
    if (this.changes.length > 12) this.changes.shift();
    this.pendingChanges.push(structuredClone(change));
  }

  recordImportantAction(action: string): void {
    const normalized = action.replace(/\s+/g, " ").trim();
    if (!normalized || this.importantActions.at(-1) === normalized) return;
    this.importantActions.push(normalized);
    if (this.importantActions.length > 8) this.importantActions.shift();
  }

  receiptLines(): string[] {
    return this.importantActions.map((action) => `  √ ${action}`);
  }

  drainWorkspaceChanges(): WorkspaceChangeNotice[] {
    return this.pendingChanges.splice(0).map((change) => structuredClone(change));
  }

  narrate(text: string): void {
    const normalized = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || (this.uiLanguage === "zh-CN" && isEnglishNarrative(normalized))) return;
    this.latestNarration = normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
  }

  setCompletion(message: string, success: boolean): void {
    this.completion = { message: message.trim(), success };
  }

  setDiagnostics(diagnostics?: TaskDiagnosticSnapshot): void {
    this.diagnostics = diagnostics ? structuredClone(diagnostics) : undefined;
  }

  diagnosticLine(): string | undefined {
    return this.diagnostics ? `${localize(this.uiLanguage, "诊断：", "Diagnostics: ")}${formatTaskDiagnosticSummary(this.diagnostics, this.uiLanguage)}` : undefined;
  }

  completionSummary(): { message: string; success: boolean } | undefined {
    return this.completion ? { ...this.completion } : undefined;
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

  language(): UiLanguage {
    return this.uiLanguage;
  }

  setLanguage(language: UiLanguage): void {
    if (language === this.uiLanguage) return;
    this.uiLanguage = language;
    this.currentPhase = localize(language, "处理中", "Working");
    this.latestNarration = "";
    this.activities = [];
    this.changes = [];
    this.importantActions = [];
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
    const output = `${this.truncated ? localize(this.uiLanguage, "[较早的实时输出已截断；完整工具输出仍可在 /details 中查看。]\n", "[Earlier live output was truncated; complete tool output remains available in /details.]\n") : ""}${this.buffer}`;
    this.buffer = "";
    this.truncated = false;
    return output;
  }

  discard(): void {
    this.buffer = "";
    this.truncated = false;
  }

  private advanceAutomaticStage(stage: AutomaticStage): void {
    const steps = automaticSteps(this.uiLanguage);
    const currentIndex = steps.findIndex((step) => step.stage === this.automaticStage);
    const nextIndex = steps.findIndex((step) => step.stage === stage);
    if (nextIndex > currentIndex) this.automaticStage = stage;
  }

  private summaryLines(): string[] {
    const lines = this.currentPlan ? this.planSummaryLines(this.currentPlan) : this.automaticSummaryLines();
    if (this.latestNarration) lines.push(`${localize(this.uiLanguage, "进展：", "Update: ")}${this.latestNarration}`);
    const latestChange = this.changes.at(-1)?.text;
    if (latestChange) lines.push(`${localize(this.uiLanguage, "变更：", "Changed: ")}${latestChange}`);
    return lines;
  }

  private planSummaryLines(plan: TaskPlan): string[] {
    const completed = plan.steps.filter((step) => step.status === "completed").length;
    const currentIndex = plan.steps.findIndex((step) => step.status === "in_progress");
    const nextIndex = plan.steps.findIndex((step, index) => index > currentIndex && step.status === "pending");
    const visible = plan.steps.length <= 6
      ? plan.steps
      : plan.steps.filter((step, index) => step.status === "in_progress" || step.status === "blocked" || index === nextIndex).slice(0, 4);
    const lines = [`${localize(this.uiLanguage, "计划：", "Plan: ")}${completed}/${plan.steps.length} ${localize(this.uiLanguage, "已完成", "completed")}`];
    for (const step of visible) {
      const title = this.uiLanguage === "zh-CN" && isEnglishNarrative(step.title) ? `步骤 ${step.id}` : step.title;
      const note = step.note && !(this.uiLanguage === "zh-CN" && isEnglishNarrative(step.note)) ? ` - ${step.note}` : "";
      lines.push(`  ${this.stepIcon(step.status)} ${title}${note}`);
    }
    if (visible.length < plan.steps.length) lines.push(`  ... ${localize(this.uiLanguage, `另有 ${plan.steps.length - visible.length} 步`, `${plan.steps.length - visible.length} more step(s)`)}`);
    const current = currentIndex >= 0 ? plan.steps[currentIndex] : undefined;
    const next = nextIndex >= 0 ? plan.steps[nextIndex] : plan.steps.find((step) => step.status === "pending");
    const currentTitle = current && this.uiLanguage === "zh-CN" && isEnglishNarrative(current.title) ? `步骤 ${current.id}` : current?.title;
    const nextTitle = next && this.uiLanguage === "zh-CN" && isEnglishNarrative(next.title) ? `步骤 ${next.id}` : next?.title;
    lines.push(`${localize(this.uiLanguage, "当前：", "Now: ")}${currentTitle ?? (completed === plan.steps.length ? localize(this.uiLanguage, "最终复核", "Final review") : this.currentPhase)}`);
    if (nextTitle) lines.push(`${localize(this.uiLanguage, "下一步：", "Next: ")}${nextTitle}`);
    return lines;
  }

  private automaticSummaryLines(): string[] {
    const steps = automaticSteps(this.uiLanguage);
    const currentIndex = steps.findIndex((step) => step.stage === this.automaticStage);
    const lines = [`${localize(this.uiLanguage, "进度：", "Progress: ")}${localize(this.uiLanguage, "自动", "automatic")} ${currentIndex}/${steps.length} ${localize(this.uiLanguage, "已完成", "completed")}`];
    for (const [index, step] of steps.entries()) {
      const status: PlanStepStatus = index < currentIndex ? "completed" : index === currentIndex ? "in_progress" : "pending";
      lines.push(`  ${this.stepIcon(status)} ${step.title}`);
    }
    lines.push(`${localize(this.uiLanguage, "当前：", "Now: ")}${this.currentPhase}`);
    const next = steps[currentIndex + 1];
    if (next) lines.push(`${localize(this.uiLanguage, "下一步：", "Next: ")}${next.title}`);
    return lines;
  }

  private stepIcon(status: PlanStepStatus): string {
    return ({ pending: "○", in_progress: "→", completed: "√", blocked: "!" } as const)[status];
  }
}

export function formatRunningInputFooter(view: RunningTaskView, queued: number, steering: number, baseFooter: string): string {
  const turn = view.turn();
  const elapsed = Math.floor(view.elapsedMs() / 1000);
  const language = view.language();
  const queue = queued ? localize(language, `${queued} 个排队任务`, `${queued} queued`) : localize(language, "队列为空", "queue empty");
  const steeringState = steering ? localize(language, `${steering} 条补充要求`, `${steering} steering`) : localize(language, "无补充要求", "no steering");
  const details = view.detailsVisible() ? localize(language, "Ctrl+O 隐藏详情", "Ctrl+O hide details") : localize(language, "Ctrl+O 显示详情", "Ctrl+O show details");
  const turnLabel = turn.maximum ? `${turn.current || "-"}/${turn.maximum}` : `${turn.current || "-"}`;
  const headline = `${localize(language, "运行中：", "Working: ")}${localize(language, "轮次", "Turn")} ${turnLabel} | ${view.phase()} | ${elapsed}s | ${steeringState} | ${queue}`;
  const diagnostic = view.diagnosticLine();
  return [headline, ...(diagnostic ? [diagnostic] : []), ...view.progressLines(), `${details} | ${localize(language, "Enter 补充当前任务 | /queue <任务> 安排下一项 | Ctrl+C 取消", "Enter steers current | /queue <task> schedules next | Ctrl+C cancels")}`, baseFooter].join("\n");
}
