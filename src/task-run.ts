import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "./secret-redaction.js";

export const TASK_RUN_SCHEMA_VERSION = 1 as const;

export type TaskRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled" | "unverified" | "abandoned";
export type TaskOperationKind = "model" | "tool" | "verification" | "checkpoint" | "steering";
export type TaskOperationStatus = "planned" | "started" | "succeeded" | "failed" | "cancelled" | "unknown";
export type TaskSideEffect = "none" | "workspace" | "process" | "external" | "unknown";
export type TaskReplayPolicy = "safe-after-confirmation" | "verify-first" | "forbidden";

export interface TaskRunOperation {
  id: string;
  kind: TaskOperationKind;
  name: string;
  signature?: string;
  risk?: "read" | "write" | "execute" | "dangerous";
  sideEffect: TaskSideEffect;
  replay: TaskReplayPolicy;
  status: TaskOperationStatus;
  startedAt: string;
  finishedAt?: string;
  evidence?: string;
}

export interface TaskRecoveryPoint {
  id: string;
  kind: "assistant" | "tool" | "verification" | "checkpoint" | "steering";
  at: string;
  operationId?: string;
  evidence: string;
}

export interface TaskRunEvent {
  id: string;
  at: string;
  type: "run-started" | "operation-started" | "operation-finished" | "recovery-point" | "run-paused" | "run-finished" | "run-abandoned";
  operationId?: string;
  status?: TaskRunStatus | TaskOperationStatus;
  evidence?: string;
}

export interface TaskRunRecord {
  version: typeof TASK_RUN_SCHEMA_VERSION;
  runId: string;
  workspaceId: string;
  sessionId: string;
  taskPreview: string;
  providerId: string;
  model: string;
  status: TaskRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  ownerPid: number;
  ownerInstance: string;
  operations: TaskRunOperation[];
  recoveryPoints: TaskRecoveryPoint[];
  events: TaskRunEvent[];
  resumedFrom?: string;
}

export interface InterruptedTaskRun extends TaskRunRecord {
  interruptedOperations: TaskRunOperation[];
  pendingSideEffects: TaskRunOperation[];
  recommendation: string;
}

interface BeginRunOptions {
  sessionId: string;
  task: string;
  providerId: string;
  model: string;
  resumedFrom?: string;
}

interface BeginOperationOptions {
  kind: TaskOperationKind;
  name: string;
  signature?: string;
  risk?: "read" | "write" | "execute" | "dangerous";
  sideEffect?: TaskSideEffect;
}

interface TaskRunLock {
  version: typeof TASK_RUN_SCHEMA_VERSION;
  workspaceId: string;
  runId: string;
  ownerPid: number;
  ownerInstance: string;
  createdAt: string;
}

function workspaceIdentity(workspace: string): string {
  const normalized = path.resolve(workspace).replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function boundedEvidence(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 320);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Stable, non-reversible identity for replay detection. Raw tool arguments never enter the journal. */
export function taskOperationSignature(name: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(name).update("\0").update(stableJson(input)).digest("hex");
}

export function safeTaskPreview(task: string, workspace: string): string {
  const normalizedWorkspace = path.resolve(workspace);
  return boundedEvidence(redactSecrets(task))
    .replaceAll(normalizedWorkspace, "[workspace]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 200);
}

function replayPolicy(sideEffect: TaskSideEffect): TaskReplayPolicy {
  if (sideEffect === "none") return "safe-after-confirmation";
  if (sideEffect === "workspace") return "verify-first";
  return "forbidden";
}

function isRecord(value: unknown): value is TaskRunRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TaskRunRecord>;
  return item.version === TASK_RUN_SCHEMA_VERSION
    && typeof item.runId === "string"
    && typeof item.workspaceId === "string"
    && typeof item.sessionId === "string"
    && typeof item.status === "string"
    && Array.isArray(item.operations)
    && Array.isArray(item.recoveryPoints)
    && Array.isArray(item.events);
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await fs.lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`Unsafe task-run journal path: ${file}`);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export class TaskRunJournal {
  readonly workspaceId: string;
  readonly instanceId = randomUUID();
  private current?: TaskRunRecord;

  constructor(
    private readonly workspace: string,
    private readonly root = path.join(os.homedir(), ".xiu", "task-runs"),
  ) {
    this.workspaceId = workspaceIdentity(workspace);
  }

  private directory(): string { return path.join(this.root, this.workspaceId); }
  private runFile(runId: string): string { return path.join(this.directory(), `${runId}.json`); }
  private lockFile(): string { return path.join(this.directory(), ".active.lock"); }

  async begin(options: BeginRunOptions): Promise<TaskRunRecord> {
    if (this.current?.status === "running") throw new Error("A task run is already active in this Xiu process.");
    const existing = (await this.recoverableRecords())[0];
    if (existing && existing.runId !== options.resumedFrom) {
      if (existing.ownerPid !== process.pid && this.processAlive(existing.ownerPid)) {
        throw new Error(`Another Xiu process (${existing.ownerPid}) is already running a task in this workspace.`);
      }
      throw new Error("An interrupted task requires an explicit resume or abandon decision before starting another task.");
    }
    const now = new Date().toISOString();
    const runId = randomUUID();
    await this.acquireLock(runId, options.resumedFrom);
    const record: TaskRunRecord = {
      version: TASK_RUN_SCHEMA_VERSION,
      runId,
      workspaceId: this.workspaceId,
      sessionId: options.sessionId,
      taskPreview: safeTaskPreview(options.task, this.workspace),
      providerId: boundedEvidence(options.providerId).slice(0, 100),
      model: boundedEvidence(options.model).slice(0, 160),
      status: "running",
      startedAt: now,
      updatedAt: now,
      ownerPid: process.pid,
      ownerInstance: this.instanceId,
      operations: [],
      recoveryPoints: [],
      events: [{ id: randomUUID(), at: now, type: "run-started", status: "running" }],
      ...(options.resumedFrom ? { resumedFrom: options.resumedFrom } : {}),
    };
    try {
      if (options.resumedFrom) await this.abandon(options.resumedFrom, "superseded by confirmed recovery");
      await atomicWrite(this.runFile(record.runId), record);
      this.current = record;
      return structuredClone(record);
    } catch (error) {
      await this.releaseLock(runId);
      throw error;
    }
  }

  async beginOperation(options: BeginOperationOptions): Promise<string> {
    const run = this.requireCurrent();
    const sideEffect = options.sideEffect ?? "unknown";
    const operation: TaskRunOperation = {
      id: randomUUID(),
      kind: options.kind,
      name: boundedEvidence(options.name).slice(0, 160),
      ...(options.signature ? { signature: options.signature.slice(0, 128) } : {}),
      ...(options.risk ? { risk: options.risk } : {}),
      sideEffect,
      replay: replayPolicy(sideEffect),
      status: "started",
      startedAt: new Date().toISOString(),
    };
    run.operations.push(operation);
    this.appendEvent(run, { type: "operation-started", operationId: operation.id, status: "started" });
    if (run.operations.length > 200) run.operations.splice(0, run.operations.length - 200);
    await this.persist();
    return operation.id;
  }

  async finishOperation(id: string, status: Exclude<TaskOperationStatus, "planned" | "started" | "unknown">, evidence = ""): Promise<void> {
    const run = this.requireCurrent();
    const operation = run.operations.find((item) => item.id === id);
    if (!operation) throw new Error(`Task operation not found: ${id}`);
    operation.status = status;
    operation.finishedAt = new Date().toISOString();
    if (evidence) operation.evidence = this.safeEvidence(evidence);
    this.appendEvent(run, { type: "operation-finished", operationId: id, status, ...(evidence ? { evidence } : {}) });
    await this.persist();
  }

  async recoveryPoint(kind: TaskRecoveryPoint["kind"], evidence: string, operationId?: string): Promise<void> {
    const run = this.requireCurrent();
    run.recoveryPoints.push({
      id: randomUUID(),
      kind,
      at: new Date().toISOString(),
      ...(operationId ? { operationId } : {}),
      evidence: this.safeEvidence(evidence),
    });
    this.appendEvent(run, { type: "recovery-point", ...(operationId ? { operationId } : {}), evidence });
    if (run.recoveryPoints.length > 80) run.recoveryPoints.splice(0, run.recoveryPoints.length - 80);
    await this.persist();
  }

  async complete(status: Exclude<TaskRunStatus, "running" | "paused" | "abandoned">): Promise<void> {
    const run = this.requireCurrent();
    run.status = status;
    run.finishedAt = new Date().toISOString();
    for (const operation of run.operations) {
      if (operation.status === "started") {
        operation.status = status === "cancelled" ? "cancelled" : "unknown";
        operation.finishedAt = run.finishedAt;
      }
    }
    this.appendEvent(run, { type: "run-finished", status });
    run.updatedAt = run.finishedAt;
    await atomicWrite(this.runFile(run.runId), run);
    this.current = undefined;
    await this.releaseLock(run.runId);
  }

  async pause(evidence: string): Promise<void> {
    const run = this.requireCurrent();
    await this.recoveryPoint("checkpoint", evidence);
    run.status = "paused";
    run.finishedAt = new Date().toISOString();
    for (const operation of run.operations) {
      if (operation.status === "started") {
        operation.status = "unknown";
        operation.finishedAt = run.finishedAt;
      }
    }
    this.appendEvent(run, { type: "run-paused", status: "paused", evidence });
    run.updatedAt = run.finishedAt;
    await atomicWrite(this.runFile(run.runId), run);
    this.current = undefined;
    await this.releaseLock(run.runId);
  }

  async abandon(runId: string, evidence = "abandoned by user"): Promise<void> {
    const record = await this.read(runId);
    if (!record) return;
    record.status = "abandoned";
    record.finishedAt = new Date().toISOString();
    record.updatedAt = record.finishedAt;
    for (const operation of record.operations) {
      if (operation.status === "started") {
        operation.status = "unknown";
        operation.finishedAt = record.finishedAt;
        operation.evidence = this.safeEvidence(evidence);
      }
    }
    this.appendEvent(record, { type: "run-abandoned", status: "abandoned", evidence });
    await atomicWrite(this.runFile(record.runId), record);
  }

  async interrupted(): Promise<InterruptedTaskRun | undefined> {
    const record = (await this.recoverableRecords())[0];
    if (!record) return undefined;
    if (record.ownerPid !== process.pid && this.processAlive(record.ownerPid)) return undefined;
    const interruptedOperations = record.operations.filter((operation) => operation.status === "started").map((operation) => ({ ...operation, status: "unknown" as const }));
    const pendingSideEffects = interruptedOperations.filter((operation) => operation.sideEffect !== "none");
    return {
      ...structuredClone(record),
      interruptedOperations,
      pendingSideEffects,
      recommendation: pendingSideEffects.length
        ? "Inspect the recorded recovery point and verify possible side effects before continuing. Never replay unknown operations automatically."
        : "Resume from the last recovery point only after user confirmation.",
    };
  }

  async read(runId: string): Promise<TaskRunRecord | undefined> {
    const file = this.runFile(runId);
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe task-run journal entry: ${file}`);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error(`Unsupported or corrupt task-run journal: ${file}`);
    if (parsed.workspaceId !== this.workspaceId) throw new Error("Task-run journal belongs to another workspace.");
    return parsed;
  }

  /** Returns the newest run for this workspace, including terminal runs. */
  async latest(): Promise<TaskRunRecord | undefined> {
    return (await this.recent(1))[0];
  }

  /** Returns newest runs for this workspace, including terminal runs. */
  async recent(limit = 100): Promise<TaskRunRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Task-run history limit must be between 1 and 500.");
    const names = await fs.readdir(this.directory()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const records = (await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(path.basename(name, ".json")))))
      .filter((record): record is TaskRunRecord => Boolean(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records.slice(0, limit).map((record) => structuredClone(record));
  }

  currentRun(): TaskRunRecord | undefined { return this.current ? structuredClone(this.current) : undefined; }

  private requireCurrent(): TaskRunRecord {
    if (!this.current || this.current.status !== "running") throw new Error("No active task run journal.");
    return this.current;
  }

  private async runningRecords(): Promise<TaskRunRecord[]> {
    const names = await fs.readdir(this.directory()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return (await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.read(path.basename(name, ".json")))))
      .filter((record): record is TaskRunRecord => Boolean(record))
      .filter((record) => record.status === "running")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async recoverableRecords(): Promise<TaskRunRecord[]> {
    const names = await fs.readdir(this.directory()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return (await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.read(path.basename(name, ".json")))))
      .filter((record): record is TaskRunRecord => Boolean(record))
      .filter((record) => record.status === "running" || record.status === "paused")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async persist(): Promise<void> {
    const run = this.requireCurrent();
    run.updatedAt = new Date().toISOString();
    await atomicWrite(this.runFile(run.runId), run);
  }

  private async acquireLock(runId: string, resumedFrom?: string): Promise<void> {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = this.lockFile();
    const lock: TaskRunLock = {
      version: TASK_RUN_SCHEMA_VERSION,
      workspaceId: this.workspaceId,
      runId,
      ownerPid: process.pid,
      ownerInstance: this.instanceId,
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(file, `${JSON.stringify(lock)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe task-run lock path: ${file}`);
        let existing: TaskRunLock;
        try { existing = JSON.parse(await fs.readFile(file, "utf8")) as TaskRunLock; }
        catch { throw new Error(`Corrupt task-run lock: ${file}`); }
        const valid = existing.version === TASK_RUN_SCHEMA_VERSION
          && existing.workspaceId === this.workspaceId
          && typeof existing.runId === "string"
          && Number.isSafeInteger(existing.ownerPid);
        if (!valid) throw new Error(`Unsupported or corrupt task-run lock: ${file}`);
        const takeoverConfirmed = resumedFrom === existing.runId;
        const existingRecord = await this.read(existing.runId).catch(() => undefined);
        const terminal = existingRecord && existingRecord.status !== "running";
        if (this.processAlive(existing.ownerPid) && !takeoverConfirmed && !terminal) {
          throw new Error(`Another Xiu process (${existing.ownerPid}) is already running a task in this workspace.`);
        }
        await fs.unlink(file);
      }
    }
    throw new Error("Could not acquire the task-run workspace lock.");
  }

  private async releaseLock(runId: string): Promise<void> {
    const file = this.lockFile();
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe task-run lock path: ${file}`);
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as Partial<TaskRunLock>;
    if (existing.runId === runId && existing.ownerInstance === this.instanceId) await fs.unlink(file);
  }

  private appendEvent(run: TaskRunRecord, event: Omit<TaskRunEvent, "id" | "at">): void {
    run.events.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      ...event,
      ...(event.evidence ? { evidence: this.safeEvidence(event.evidence) } : {}),
    });
    if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
  }

  private safeEvidence(value: string): string {
    const normalizedWorkspace = path.resolve(this.workspace);
    return boundedEvidence(redactSecrets(value))
      .replaceAll(normalizedWorkspace, "[workspace]")
      .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
      .slice(0, 320);
  }

  private processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
}

export function taskToolSideEffect(risk: "read" | "write" | "execute" | "dangerous", changesWorkspace: boolean): TaskSideEffect {
  if (changesWorkspace) return "workspace";
  if (risk === "read") return "none";
  if (risk === "execute") return "process";
  if (risk === "write") return "external";
  return "unknown";
}

export function recoveryContinuation(run: InterruptedTaskRun, language: "zh-CN" | "en-US" = "en-US"): string {
  const point = run.recoveryPoints.at(-1);
  const blocked = run.pendingSideEffects.map((operation) => `${operation.kind}:${operation.name} (${operation.sideEffect}, ${operation.replay})`).join(", ") || "none";
  if (language === "zh-CN") {
    return `继续已由用户确认恢复的中断任务。原任务摘要：${run.taskPreview || "未记录"}。最后安全恢复点：${point?.evidence ?? "尚无恢复点"}。状态未知且禁止自动重放的副作用操作：${blocked}。先核验工作区、Git、文件、进程或远端状态，再从已有证据继续；不要重复已经成功的操作。`;
  }
  return `Continue the interrupted task after explicit user confirmation. Original task summary: ${run.taskPreview || "not recorded"}. Last safe recovery point: ${point?.evidence ?? "none recorded"}. Unknown side-effect operations that must not be replayed automatically: ${blocked}. Verify workspace, Git, files, processes, or remote state first, then continue from existing evidence without repeating successful work.`;
}
