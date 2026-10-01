import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentTool, ApprovalRequest } from "./types.js";
import { WorktreeManager, type WorktreeInfo, type WorktreeMergeAnalysis } from "./worktree.js";
import { localize, type UiLanguage } from "./i18n.js";
import { sanitizeSecrets } from "./secret-redaction.js";
import { captureVerificationStamp, type VerificationEvidence } from "./verification.js";

export type SubagentRole = "explorer" | "implementer" | "reviewer" | "tester";
export type SubagentMode = "shared_readonly" | "worktree";
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "blocked";

export interface SubagentTaskInput {
  id: string;
  title: string;
  instructions: string;
  role: SubagentRole;
  dependencies?: string[];
  mode?: SubagentMode;
  maxTurns?: number;
}

export interface SubagentStats {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  activeMs: number;
}

export interface SubagentTask extends SubagentTaskInput {
  dependencies: string[];
  mode: SubagentMode;
  status: SubagentStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  progress?: string;
  stats?: SubagentStats;
  worktree?: WorktreeInfo;
  integration?: SubagentIntegrationRecord;
  inspection?: SubagentInspection;
}

export interface SubagentInspection {
  targetTaskId: string;
  baseCommit: string;
  patchDigest: string;
  observedAt: string;
  verification?: VerificationEvidence;
}

export interface IntegrationEvidence {
  reviewers: string[];
  testers: string[];
  blockers: string[];
}

export interface AgentIntegrationPlan {
  runId: string;
  taskId: string;
  analysis: WorktreeMergeAnalysis;
  evidence: IntegrationEvidence;
  blockers: string[];
  canIntegrate: boolean;
}

export interface SubagentIntegrationRecord {
  status: "ready" | "blocked" | "applied";
  updatedAt: string;
  changedFiles: string[];
  blockers: string[];
  reviewerEvidence: string[];
  testerEvidence: string[];
  patchFile?: string;
  error?: string;
}

export interface SubagentRun {
  id: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  concurrency: number;
  tasks: SubagentTask[];
}

export interface TaskExecutionContext {
  cwd: string;
  signal: AbortSignal;
  dependencyResults: Array<{ id: string; result: string }>;
  reportProgress: (message: string) => void;
}

export interface TaskExecutionResult {
  result: string;
  stats: SubagentStats;
  verification?: VerificationEvidence;
}

export type SubagentExecutor = (task: SubagentTask, context: TaskExecutionContext) => Promise<TaskExecutionResult>;

export function requireCompletedSubagent(status: { outcome: string; failureReason?: string }): void {
  if (status.outcome !== "completed") throw new Error(`Subagent outcome: ${status.outcome}${status.failureReason ? ` (${status.failureReason})` : ""}`);
}

export function selectSubagentTools(tools: AgentTool[], mode: SubagentMode): AgentTool[] {
  return mode === "shared_readonly" ? tools.filter((tool) => tool.risk === "read") : [...tools];
}

export interface MultiAgentEvents {
  onTaskUpdate?: (run: SubagentRun, task: SubagentTask) => void;
  onRunUpdate?: (run: SubagentRun) => void;
}

const terminalStatuses = new Set<SubagentStatus>(["completed", "failed", "cancelled", "blocked"]);
const retryableStatuses = new Set<SubagentStatus>(["failed", "cancelled", "interrupted", "blocked"]);

function now(): string { return new Date().toISOString(); }

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(trimmed)) {
    throw new Error(`${label} must use 1-64 letters, numbers, underscores, or hyphens.`);
  }
  return trimmed;
}

export function validateTaskGraph(tasks: SubagentTaskInput[]): void {
  if (!tasks.length) throw new Error("At least one agent task is required.");
  if (tasks.length > 80) throw new Error("At most 80 agent tasks are allowed in one run.");
  const ids = new Set<string>();
  for (const task of tasks) {
    const id = safeId(task.id, "task id");
    if (ids.has(id)) throw new Error(`Duplicate agent task id: ${id}`);
    if (!task.title.trim() || !task.instructions.trim()) throw new Error(`Agent task ${id} needs a title and instructions.`);
    if (task.title.length > 240 || task.instructions.length > 16_000) throw new Error(`Agent task ${id} exceeds text limits.`);
    if (!["explorer", "implementer", "reviewer", "tester"].includes(task.role) || task.mode !== undefined && !["shared_readonly", "worktree"].includes(task.mode)) throw new Error(`Agent task ${id} has an invalid role or mode.`);
    if (task.maxTurns !== undefined && (!Number.isInteger(task.maxTurns) || task.maxTurns < 1 || task.maxTurns > 100)) {
      throw new Error(`Agent task ${id} maxTurns must be an integer from 1 to 100.`);
    }
    ids.add(id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies ?? []) {
      if (!ids.has(dependency)) throw new Error(`Agent task ${task.id} has unknown dependency: ${dependency}`);
      if (dependency === task.id) throw new Error(`Agent task ${task.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Agent task graph contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function defaultMode(role: SubagentRole): SubagentMode {
  return role === "implementer" ? "worktree" : "shared_readonly";
}

function cloneRun(run: SubagentRun): SubagentRun { return structuredClone(run); }

function dependsOn(run: SubagentRun, task: SubagentTask, targetId: string, visited = new Set<string>()): boolean {
  if (visited.has(task.id)) return false;
  visited.add(task.id);
  for (const dependencyId of task.dependencies) {
    if (dependencyId === targetId) return true;
    const dependency = run.tasks.find((candidate) => candidate.id === dependencyId);
    if (dependency && dependsOn(run, dependency, targetId, visited)) return true;
  }
  return false;
}

function evidencePassed(result: string | undefined): boolean {
  if (!result) return false;
  const finalLine = result.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  return /^VERDICT\s*:\s*PASS\.?$/i.test(finalLine) || /^(?:结论|审查|测试|验证)\s*[:：]\s*(?:通过|合格)[。.]?$/u.test(finalLine);
}

function patchDigest(patch: string): string { return createHash("sha256").update(patch).digest("hex"); }

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function collectIntegrationEvidence(run: SubagentRun, targetId: string, current?: Pick<WorktreeMergeAnalysis, "patch" | "changedFiles">): Promise<IntegrationEvidence> {
  const target = run.tasks.find((task) => task.id === targetId);
  const digest = current ? patchDigest(current.patch) : undefined;
  const related = run.tasks.filter((task) => dependsOn(run, task, targetId));
  const inspected = related.filter((task) => task.mode === "shared_readonly" && task.status === "completed" && evidencePassed(task.result)
    && digest && task.inspection?.targetTaskId === targetId && task.inspection.patchDigest === digest
    && task.inspection.baseCommit === target?.worktree?.baseCommit);
  const reviewers = inspected.filter((task) => task.role === "reviewer").map((task) => task.id);
  const testers: string[] = [];
  for (const task of inspected.filter((candidate) => candidate.role === "tester")) {
    const evidence = task.inspection?.verification;
    if (!evidence || evidence.version !== 1 || !target?.worktree || !current?.changedFiles.length
      || !Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.length > 64
      || !Array.isArray(evidence.explicitPaths) || !evidence.explicitPaths.length || evidence.explicitPaths.length > 64) continue;
    try {
      const root = await fs.realpath(target.worktree.path);
      if (pathIdentity(evidence.cwd) !== pathIdentity(root)) continue;
      const observed = Date.parse(evidence.observedAt);
      const started = Date.parse(task.startedAt ?? ""), completed = Date.parse(task.completedAt ?? "");
      if (![observed, started, completed].every(Number.isFinite) || observed < started || observed > completed) continue;
      // shared_readonly does not acquire command execution. Its concrete evidence
      // is bounded artifact validation and must cover every file in this patch.
      const verifiedFiles = new Set<string>();
      let valid = true;
      for (const check of evidence.checks) {
        if (check.toolName !== "verify_output" || typeof check.path !== "string" || check.path.length > 4096) { valid = false; break; }
        const relative = path.relative(root, path.resolve(root, check.path));
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
          || !evidence.explicitPaths.includes(check.path)) { valid = false; break; }
        verifiedFiles.add(pathIdentity(path.join(root, relative)));
      }
      if (!valid || !current.changedFiles.every((file) => verifiedFiles.has(pathIdentity(path.resolve(root, file))))) continue;
      if (evidence.workspaceStamp !== await captureVerificationStamp(root, evidence.explicitPaths)) continue;
      testers.push(task.id);
    } catch { /* Missing, unsafe, malformed, or stale evidence fails closed. */ }
  }
  const blockers: string[] = [];
  if (current && current.changedFiles.length > 64) blockers.push("Bounded artifact verification supports at most 64 changed files per implementation task; split this patch into smaller tasks.");
  if (!reviewers.length) blockers.push("A completed reviewer dependency with VERDICT: PASS bound to the current patch is required.");
  if (!testers.length) blockers.push("A completed tester dependency with fresh program-observed verify_output evidence for every changed file and VERDICT: PASS is required. Text-only PASS is not verification; shared_readonly cannot execute tests.");
  return { reviewers, testers, blockers };
}

function inheritedWorktree(run: SubagentRun, task: SubagentTask): WorktreeInfo | undefined {
  const worktrees = new Map<string, WorktreeInfo>();
  const visit = (candidate: SubagentTask): void => {
    if (candidate.worktree) worktrees.set(path.resolve(candidate.worktree.path).toLowerCase(), candidate.worktree);
    for (const dependencyId of candidate.dependencies) {
      const dependency = run.tasks.find((item) => item.id === dependencyId);
      if (dependency) visit(dependency);
    }
  };
  for (const dependencyId of task.dependencies) {
    const dependency = run.tasks.find((item) => item.id === dependencyId);
    if (dependency) visit(dependency);
  }
  if (worktrees.size > 1) throw new Error(`Agent task ${task.id} depends on multiple Worktrees; split the review or test into one target per task.`);
  return [...worktrees.values()][0];
}

export class MultiAgentCoordinator {
  private runs = new Map<string, SubagentRun>();
  private controllers = new Map<string, AbortController>();
  private drivers = new Map<string, Promise<void>>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly worktrees: WorktreeManager;

  constructor(
    private readonly cwd: string,
    private readonly executor: SubagentExecutor,
    private readonly events: MultiAgentEvents = {},
    private readonly defaultConcurrency = 3,
    private readonly secrets: readonly string[] = [],
  ) {
    this.worktrees = new WorktreeManager(cwd);
  }

  private directory(): string { return path.join(this.cwd, ".xiu", "agents"); }
  private file(id: string): string { return path.join(this.directory(), `${id}.json`); }

  async initialize(): Promise<void> {
    const names = await fs.readdir(this.directory()).catch(() => [] as string[]);
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(this.directory(), name), "utf8")) as SubagentRun;
        let changed = false;
        for (const task of run.tasks) {
          // Persisted JSON is display/history, not proof of program execution in
          // this coordinator. Re-run specialists to establish fresh receipts.
          task.inspection = undefined;
          if (task.status === "running") {
            task.status = "interrupted";
            task.error = "Xiu exited while this agent was running. Retry it to continue.";
            task.completedAt = now();
            changed = true;
          }
        }
        if (changed) {
          run.status = "failed";
          run.updatedAt = now();
        }
        this.runs.set(run.id, run);
        if (changed) await this.persist(run);
      } catch { /* Ignore malformed or incomplete state files. */ }
    }
  }

  async start(goal: string, inputs: SubagentTaskInput[], concurrency = this.defaultConcurrency): Promise<SubagentRun> {
    validateTaskGraph(inputs);
    if (!goal.trim()) throw new Error("Agent run goal must not be empty.");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Agent concurrency must be from 1 to 8.");
    const createdAt = now();
    const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const run: SubagentRun = {
      id,
      goal: goal.trim(),
      status: "running",
      createdAt,
      updatedAt: createdAt,
      concurrency,
      tasks: inputs.map((task) => ({
        ...task,
        id: safeId(task.id, "task id"),
        dependencies: [...new Set(task.dependencies ?? [])],
        mode: task.mode ?? defaultMode(task.role),
        status: "pending",
        createdAt,
        inspection: undefined,
      })),
    };
    this.runs.set(id, run);
    await this.persist(run);
    this.launchDriver(run);
    return cloneRun(run);
  }

  list(): SubagentRun[] {
    return [...this.runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(cloneRun);
  }

  /** No child may outlive a detached desktop host or its parent task. */
  async shutdown(): Promise<void> {
    for (const run of this.list()) for (const task of run.tasks) {
      if (["pending", "running"].includes(task.status)) await this.cancel(run.id, task.id);
    }
    await Promise.allSettled([...this.drivers.values()]);
  }

  get(runId: string): SubagentRun {
    const matches = [...this.runs.values()].filter((run) => run.id === runId || run.id.startsWith(runId));
    if (!matches.length) throw new Error(`Agent run not found: ${runId}`);
    if (matches.length > 1) throw new Error(`Agent run id prefix is ambiguous: ${runId}`);
    return cloneRun(matches[0]!);
  }

  async wait(runId: string, timeoutMs = 30_000): Promise<SubagentRun> {
    const run = this.resolveRun(runId);
    const driver = this.drivers.get(run.id);
    if (driver && run.status === "running") {
      await Promise.race([driver, new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(timeoutMs, 60_000))))]);
    }
    return cloneRun(this.resolveRun(run.id));
  }

  async cancel(runId: string, taskId: string): Promise<SubagentTask> {
    const run = this.resolveRun(runId);
    const task = this.resolveTask(run, taskId);
    if (terminalStatuses.has(task.status) || task.status === "interrupted") return structuredClone(task);
    if (task.status === "running") this.controllers.get(`${run.id}:${task.id}`)?.abort();
    task.status = "cancelled";
    task.error = "Cancelled by user or parent agent.";
    task.completedAt = now();
    run.updatedAt = now();
    await this.persist(run);
    this.events.onTaskUpdate?.(cloneRun(run), structuredClone(task));
    return structuredClone(task);
  }

  async retry(runId: string, taskId: string): Promise<SubagentRun> {
    const run = this.resolveRun(runId);
    const task = this.resolveTask(run, taskId);
    const repeatInspection = task.status === "completed" && task.mode === "shared_readonly" && ["reviewer", "tester"].includes(task.role);
    if (!retryableStatuses.has(task.status) && !repeatInspection) throw new Error(`Agent task ${task.id} is ${task.status}, not retryable.`);
    task.status = "pending";
    task.error = undefined;
    task.result = undefined;
    task.progress = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.stats = undefined;
    task.inspection = undefined;
    run.status = "running";
    run.updatedAt = now();
    await this.persist(run);
    this.launchDriver(run);
    return cloneRun(run);
  }

  async diff(runId: string, taskId: string): Promise<string> {
    const task = this.resolveTask(this.resolveRun(runId), taskId);
    if (!task.worktree) throw new Error(`Agent task ${task.id} has no Worktree.`);
    return await this.worktrees.diff(task.worktree);
  }

  async analyzeIntegration(runId: string, taskId: string): Promise<AgentIntegrationPlan> {
    const run = this.resolveRun(runId);
    const task = this.resolveTask(run, taskId);
    if (task.status !== "completed") throw new Error(`Only completed agent tasks can be integrated; ${task.id} is ${task.status}.`);
    if (!task.worktree) throw new Error(`Agent task ${task.id} has no Worktree.`);
    const analysis = await this.worktrees.analyze(task.worktree);
    const evidence = await collectIntegrationEvidence(run, task.id, analysis);
    const blockers = [
      ...analysis.conflicts.map((conflict) => `${conflict.kind}: ${conflict.detail}`),
      ...evidence.blockers,
    ];
    const plan: AgentIntegrationPlan = { runId: run.id, taskId: task.id, analysis, evidence, blockers, canIntegrate: analysis.canIntegrate && blockers.length === 0 };
    task.integration = {
      status: plan.canIntegrate ? "ready" : "blocked",
      updatedAt: now(),
      changedFiles: analysis.changedFiles,
      blockers,
      reviewerEvidence: evidence.reviewers,
      testerEvidence: evidence.testers,
      patchFile: analysis.patchFile,
    };
    run.updatedAt = now();
    await this.persist(run);
    return structuredClone(plan);
  }

  async integrate(runId: string, taskId: string): Promise<string> {
    const run = this.resolveRun(runId);
    const task = this.resolveTask(run, taskId);
    const plan = await this.analyzeIntegration(run.id, task.id);
    if (!plan.canIntegrate) throw new Error(`Agent patch was not applied: ${plan.blockers.join(" ")}`);
    try {
      const result = await this.worktrees.integrate(task.worktree!, plan.analysis.patch);
      task.integration = { ...task.integration!, status: "applied", updatedAt: now() };
      run.updatedAt = now();
      await this.persist(run);
      return result;
    } catch (error) {
      task.integration = { ...task.integration!, status: "blocked", updatedAt: now(), error: error instanceof Error ? error.message : String(error) };
      run.updatedAt = now();
      await this.persist(run);
      throw error;
    }
  }

  private resolveRun(id: string): SubagentRun {
    const matches = [...this.runs.values()].filter((run) => run.id === id || run.id.startsWith(id));
    if (!matches.length) throw new Error(`Agent run not found: ${id}`);
    if (matches.length > 1) throw new Error(`Agent run id prefix is ambiguous: ${id}`);
    return matches[0]!;
  }

  private resolveTask(run: SubagentRun, id: string): SubagentTask {
    const matches = run.tasks.filter((task) => task.id === id || task.id.startsWith(id));
    if (!matches.length) throw new Error(`Agent task not found in ${run.id}: ${id}`);
    if (matches.length > 1) throw new Error(`Agent task id prefix is ambiguous: ${id}`);
    return matches[0]!;
  }

  private launchDriver(run: SubagentRun): void {
    if (this.drivers.has(run.id)) return;
    const driver = this.drive(run).finally(() => this.drivers.delete(run.id));
    this.drivers.set(run.id, driver);
  }

  private async drive(run: SubagentRun): Promise<void> {
    const active = new Map<string, Promise<void>>();
    while (run.status === "running") {
      for (const task of run.tasks.filter((item) => item.status === "pending")) {
        const dependencies = task.dependencies.map((id) => this.resolveTask(run, id));
        if (dependencies.some((dependency) => ["failed", "cancelled", "interrupted", "blocked"].includes(dependency.status))) {
          task.status = "blocked";
          task.error = "A dependency did not complete successfully.";
          task.completedAt = now();
          await this.changed(run, task);
        }
      }
      const ready = run.tasks.filter((task) => task.status === "pending"
        && task.dependencies.every((id) => this.resolveTask(run, id).status === "completed"));
      while (ready.length && active.size < run.concurrency) {
        const task = ready.shift()!;
        const promise = this.execute(run, task).finally(() => active.delete(task.id));
        active.set(task.id, promise);
      }
      if (active.size) {
        await Promise.race(active.values());
        continue;
      }
      const unfinished = run.tasks.some((task) => task.status === "pending" || task.status === "running");
      if (unfinished) continue;
      const completed = run.tasks.filter((task) => task.status === "completed").length;
      const cancelled = run.tasks.every((task) => task.status === "cancelled");
      run.status = cancelled ? "cancelled" : completed === run.tasks.length ? "completed" : "failed";
      run.updatedAt = now();
      await this.persist(run);
      this.events.onRunUpdate?.(cloneRun(run));
    }
  }

  private async execute(run: SubagentRun, task: SubagentTask): Promise<void> {
    const controller = new AbortController();
    const key = `${run.id}:${task.id}`;
    this.controllers.set(key, controller);
    task.status = "running";
    task.startedAt = now();
    task.completedAt = undefined;
    task.error = undefined;
    let taskCwd = this.cwd;
    let inspectionTarget: SubagentTask | undefined;
    let beforePatch: string | undefined;
    try {
      if (task.mode === "worktree") {
        task.progress = "Creating isolated Git Worktree";
        await this.changed(run, task);
        task.worktree ??= await this.worktrees.create(run.id, task.id);
        taskCwd = task.worktree.path;
      } else if (task.role === "reviewer" || task.role === "tester") {
        const inherited = inheritedWorktree(run, task);
        if (inherited) {
          taskCwd = inherited.path;
          inspectionTarget = run.tasks.find((candidate) => candidate.role === "implementer" && candidate.worktree
            && pathIdentity(candidate.worktree.path) === pathIdentity(inherited.path) && dependsOn(run, task, candidate.id));
          if (inspectionTarget) beforePatch = patchDigest(await this.worktrees.diff(inherited));
        }
      }
      await this.changed(run, task);
      const dependencies = task.dependencies.map((id) => this.resolveTask(run, id));
      const execution = await this.executor(task, {
        cwd: taskCwd,
        signal: controller.signal,
        dependencyResults: dependencies.map((dependency) => ({ id: dependency.id, result: dependency.result ?? "" })),
        reportProgress: (message) => {
          task.progress = message;
          run.updatedAt = now();
          void this.persist(run);
          this.events.onTaskUpdate?.(cloneRun(run), structuredClone(task));
        },
      });
      if (controller.signal.aborted) return;
      if (inspectionTarget?.worktree && beforePatch === patchDigest(await this.worktrees.diff(inspectionTarget.worktree))) {
        task.inspection = {
          targetTaskId: inspectionTarget.id, baseCommit: inspectionTarget.worktree.baseCommit,
          patchDigest: beforePatch!, observedAt: now(),
          ...(task.role === "tester" && execution.verification ? { verification: structuredClone(execution.verification) } : {}),
        };
      }
      task.status = "completed";
      task.result = execution.result;
      task.stats = execution.stats;
      task.progress = "Completed";
    } catch (error) {
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      task.error = controller.signal.aborted ? "Cancelled by user or parent agent." : error instanceof Error ? error.message : String(error);
    } finally {
      this.controllers.delete(key);
      task.completedAt = now();
      await this.changed(run, task);
    }
  }

  private async changed(run: SubagentRun, task: SubagentTask): Promise<void> {
    run.updatedAt = now();
    await this.persist(run);
    this.events.onTaskUpdate?.(cloneRun(run), structuredClone(task));
  }

  private async persist(run: SubagentRun): Promise<void> {
    const safe = sanitizeSecrets(run, this.secrets);
    safe.goal = safe.goal.slice(0, 4_000);
    for (const task of safe.tasks) {
      task.instructions = task.instructions.slice(0, 16_000);
      if (task.result) task.result = task.result.slice(0, 16_000);
      if (task.progress) task.progress = task.progress.slice(0, 2_000);
      if (task.error) task.error = task.error.slice(0, 2_000);
    }
    const snapshot = JSON.stringify(safe, null, 2);
    const file = this.file(run.id);
    const temporary = `${file}.tmp`;
    this.persistQueue = this.persistQueue.then(async () => {
      await fs.mkdir(this.directory(), { recursive: true });
      await fs.writeFile(temporary, snapshot, "utf8");
      await fs.rename(temporary, file);
    });
    await this.persistQueue;
  }
}

function taskSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: "Stable short task id" },
      title: { type: "string" },
      instructions: { type: "string", description: "Self-contained task instructions" },
      role: { type: "string", enum: ["explorer", "implementer", "reviewer", "tester"] },
      dependencies: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["shared_readonly", "worktree"] },
      maxTurns: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["id", "title", "instructions", "role"],
    additionalProperties: false,
  };
}

export function formatAgentRun(run: SubagentRun, language: UiLanguage = "en-US"): string {
  const totals = run.tasks.reduce((sum, task) => ({
    tokens: sum.tokens + (task.stats?.inputTokens ?? 0) + (task.stats?.outputTokens ?? 0),
    activeMs: sum.activeMs + (task.stats?.activeMs ?? 0),
  }), { tokens: 0, activeMs: 0 });
  return [
    `${localize(language, "运行", "Run")} ${run.id} - ${run.status} - ${run.goal}`,
    ...run.tasks.map((task) => {
      const elapsed = task.startedAt ? ((new Date(task.completedAt ?? now()).getTime() - new Date(task.startedAt).getTime()) / 1000).toFixed(1) : "0.0";
      const tokens = (task.stats?.inputTokens ?? 0) + (task.stats?.outputTokens ?? 0);
      const integration = task.integration ? ` - integration:${task.integration.status}` : "";
      return `[${task.status}] ${task.id} (${task.role}, ${task.mode}) ${task.title} - ${elapsed}s, ${tokens} tokens${task.progress ? ` - ${task.progress}` : ""}${task.error ? ` - ${task.error}` : ""}${integration}`;
    }),
    localize(language, `总计：${totals.tokens} tokens，${(totals.activeMs / 1000).toFixed(1)} 秒 Agent 时间`, `Total: ${totals.tokens} tokens, ${(totals.activeMs / 1000).toFixed(1)}s agent time`),
  ].join("\n");
}

export function formatIntegrationPlan(plan: AgentIntegrationPlan, language: UiLanguage = "en-US"): string {
  const previewLines = plan.analysis.patch.split(/\r?\n/);
  const preview = previewLines.slice(0, 80).join("\n");
  const omitted = Math.max(0, previewLines.length - 80);
  const fileList = plan.analysis.changedFiles.length ? plan.analysis.changedFiles.join(", ") : localize(language, "无", "none");
  const dirtyList = plan.analysis.dirtyMainFiles.length ? plan.analysis.dirtyMainFiles.join(", ") : localize(language, "无", "none");
  const displayedBlockers = [
    ...plan.analysis.conflicts.map((conflict) => {
      if (conflict.kind === "file") return localize(language, `主工作区和 Agent 同时修改了文件：${conflict.files.join(", ")}`, conflict.detail);
      if (conflict.kind === "dependency") return localize(language, `双方同时修改了依赖清单：${conflict.files.join(", ")}`, conflict.detail);
      if (conflict.kind === "symbol") return localize(language, `双方同时修改了符号：${conflict.symbols?.join(", ") ?? ""}`, conflict.detail);
      return localize(language, `Git 补丁预检失败：${conflict.detail}`, `Git patch preflight failed: ${conflict.detail}`);
    }),
    ...plan.evidence.blockers.map((blocker) => blocker.startsWith("Bounded artifact")
      ? localize(language, "单个实现任务最多验证 64 个变更文件；请拆分为更小的任务。", blocker)
      : blocker.startsWith("A completed reviewer")
      ? localize(language, "缺少绑定当前补丁且以 VERDICT: PASS 结束的 Reviewer 审查证据。", blocker)
      : localize(language, "缺少绑定当前补丁的 Tester 程序验证证据：须通过 verify_output 验证全部变更文件并以 VERDICT: PASS 结束。纯文本 PASS 不算验证；只读子任务不能执行测试命令。", blocker)),
  ];
  const blockerList = displayedBlockers.length ? displayedBlockers.map((item) => `  - ${item}`).join("\n") : localize(language, "  无", "  none");
  return [
    localize(language, "Agent 合并分析", "Agent integration analysis"),
    `${localize(language, "变更文件", "Changed files")}: ${fileList}`,
    `${localize(language, "主工作区未提交文件", "Dirty main-workspace files")}: ${dirtyList}`,
    `${localize(language, "审查证据", "Reviewer evidence")}: ${plan.evidence.reviewers.join(", ") || localize(language, "缺失", "missing")}`,
    `${localize(language, "测试证据", "Tester evidence")}: ${plan.evidence.testers.join(", ") || localize(language, "缺失", "missing")}`,
    `${localize(language, "阻断项", "Blockers")}:\n${blockerList}`,
    `${localize(language, "结论", "Decision")}: ${plan.canIntegrate ? localize(language, "可以合并（仍需明确确认）", "ready for explicit confirmation") : localize(language, "禁止合并", "blocked")}`,
    "",
    localize(language, "有界补丁预览：", "Bounded patch preview:"),
    preview,
    omitted ? localize(language, `... 另有 ${omitted} 行已省略，可在保存的补丁文件中查看。`, `... ${omitted} more lines omitted; inspect the preserved patch file for the complete diff.`) : "",
  ].filter(Boolean).join("\n");
}

export function createMultiAgentTools(coordinator: MultiAgentCoordinator): AgentTool[] {
  return [
    {
      name: "spawn_agents",
      description: "Start a validated dependency graph of specialist agents. Use shared_readonly for investigation/review and worktree for changes. Returns immediately; use wait_agents to collect results.",
      risk: (input) => Array.isArray(input.tasks) && input.tasks.some((item) => (item as Record<string, unknown>).mode === "worktree" || (item as Record<string, unknown>).role === "implementer") ? "execute" : "read",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string" },
          concurrency: { type: "integer", minimum: 1, maximum: 8 },
          tasks: { type: "array", minItems: 1, items: taskSchema() },
        },
        required: ["goal", "tasks"],
        additionalProperties: false,
      },
      describe: (input) => `start ${Array.isArray(input.tasks) ? input.tasks.length : 0} specialist agents`,
      async execute(input) {
        if (typeof input.goal !== "string" || !Array.isArray(input.tasks)) throw new Error("goal and tasks are required");
        const run = await coordinator.start(input.goal, input.tasks as unknown as SubagentTaskInput[], typeof input.concurrency === "number" ? input.concurrency : undefined);
        return `${formatAgentRun(run)}\nUse wait_agents with run_id ${run.id} to collect progress and results.`;
      },
    },
    {
      name: "list_agents",
      description: "List multi-agent runs or inspect one run with task status, time, and token usage.",
      risk: "read",
      inputSchema: { type: "object", properties: { run_id: { type: "string" } }, additionalProperties: false },
      describe: () => "inspect multi-agent status",
      async execute(input) {
        if (typeof input.run_id === "string") return formatAgentRun(coordinator.get(input.run_id));
        const runs = coordinator.list();
        return runs.length ? runs.map((run) => formatAgentRun(run)).join("\n\n") : "No multi-agent runs.";
      },
    },
    {
      name: "wait_agents",
      description: "Wait up to 30 seconds for a multi-agent run to progress, then return statuses and completed results.",
      risk: "read",
      inputSchema: { type: "object", properties: { run_id: { type: "string" }, timeout_ms: { type: "integer", minimum: 0, maximum: 60000 } }, required: ["run_id"], additionalProperties: false },
      describe: (input) => `wait for agent run ${String(input.run_id ?? "")}`,
      async execute(input) {
        if (typeof input.run_id !== "string") throw new Error("run_id is required");
        const run = await coordinator.wait(input.run_id, typeof input.timeout_ms === "number" ? input.timeout_ms : 30_000);
        const results = run.tasks.filter((task) => task.result).map((task) => `\nResult from ${task.id}:\n${task.result}`).join("\n");
        return `${formatAgentRun(run)}${results}`;
      },
    },
    {
      name: "cancel_agent",
      description: "Cancel one pending or running agent without cancelling unrelated agents.",
      risk: "execute",
      replaySafety: "side-effecting",
      maxAttempts: 1,
      inputSchema: { type: "object", properties: { run_id: { type: "string" }, task_id: { type: "string" } }, required: ["run_id", "task_id"], additionalProperties: false },
      describe: (input) => `cancel agent ${String(input.task_id ?? "")}`,
      async execute(input) {
        if (typeof input.run_id !== "string" || typeof input.task_id !== "string") throw new Error("run_id and task_id are required");
        const task = await coordinator.cancel(input.run_id, input.task_id);
        return `Agent ${task.id} is ${task.status}.`;
      },
    },
    {
      name: "retry_agent",
      description: "Retry a failed, cancelled, interrupted, or blocked task, or re-run a completed read-only reviewer/tester to refresh integration evidence.",
      risk: "execute",
      replaySafety: "side-effecting",
      maxAttempts: 1,
      inputSchema: { type: "object", properties: { run_id: { type: "string" }, task_id: { type: "string" } }, required: ["run_id", "task_id"], additionalProperties: false },
      describe: (input) => `retry agent ${String(input.task_id ?? "")}`,
      async execute(input) {
        if (typeof input.run_id !== "string" || typeof input.task_id !== "string") throw new Error("run_id and task_id are required");
        return formatAgentRun(await coordinator.retry(input.run_id, input.task_id));
      },
    },
    {
      name: "integrate_agent",
      description: "Apply a completed Worktree agent's patch to the main workspace after conflict checking. Review the preview and run verification afterward.",
      risk: "dangerous",
      changesWorkspace: true,
      inputSchema: { type: "object", properties: { run_id: { type: "string" }, task_id: { type: "string" } }, required: ["run_id", "task_id"], additionalProperties: false },
      describe: (input) => `integrate agent ${String(input.task_id ?? "")} changes`,
      async preview(input) {
        if (typeof input.run_id !== "string" || typeof input.task_id !== "string") throw new Error("run_id and task_id are required");
        return formatIntegrationPlan(await coordinator.analyzeIntegration(input.run_id, input.task_id));
      },
      async execute(input) {
        if (typeof input.run_id !== "string" || typeof input.task_id !== "string") throw new Error("run_id and task_id are required");
        return await coordinator.integrate(input.run_id, input.task_id);
      },
    },
  ];
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;
