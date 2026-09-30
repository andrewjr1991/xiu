import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listSessions } from "../../../src/session.js";
import { redactSecrets } from "../../../src/secret-redaction.js";
import { TaskRunJournal, type TaskRunStatus } from "../../../src/task-run.js";
import { isWorkspaceTrusted, trustWorkspace } from "../../../src/trust.js";
import {
  DESKTOP_BRIDGE_VERSION,
  type DesktopRecentWorkspace,
  type DesktopTaskSummary,
  type DesktopWorkspaceSnapshot,
  type OpenRecentWorkspaceRequest,
  type RemoveRecentWorkspaceRequest,
  type TrustWorkspaceRequest,
} from "../shared/protocol.js";

interface RecentWorkspaceRecord {
  id: string;
  path: string;
  lastOpenedAt: string;
}

interface RecentWorkspaceStore {
  version: 1;
  workspaces: RecentWorkspaceRecord[];
}

export interface WorkspaceControllerOptions {
  trustStorePath?: string;
  recentStorePath?: string;
  taskRunRoot?: string;
  now?: () => Date;
}

function workspaceId(value: string): string {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function boundedTitle(value: string): string {
  const clean = redactSecrets(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return [...clean].slice(0, 160).join("") || "未命名任务";
}

function validRecentStore(value: unknown): value is RecentWorkspaceStore {
  if (!value || typeof value !== "object") return false;
  const store = value as Partial<RecentWorkspaceStore>;
  return store.version === 1 && Array.isArray(store.workspaces) && store.workspaces.every((item) =>
    item && typeof item.id === "string" && typeof item.path === "string" && typeof item.lastOpenedAt === "string");
}

export class DesktopWorkspaceController {
  private readonly trustStorePath: string;
  private readonly recentStorePath: string;
  private readonly taskRunRoot?: string;
  private readonly now: () => Date;
  private current?: { id: string; path: string; name: string; trusted: boolean };
  private lastError?: string;

  constructor(options: WorkspaceControllerOptions = {}) {
    this.trustStorePath = options.trustStorePath ?? path.join(os.homedir(), ".xiu", "trusted-workspaces.json");
    this.recentStorePath = options.recentStorePath ?? path.join(os.homedir(), ".xiu", "desktop-workspaces.json");
    this.taskRunRoot = options.taskRunRoot;
    this.now = options.now ?? (() => new Date());
  }

  trustedWorkspacePath(): string {
    if (!this.current?.trusted) throw new Error("A trusted workspace is required.");
    return this.current.path;
  }

  async snapshot(): Promise<DesktopWorkspaceSnapshot> {
    const recent = await this.recentSnapshot();
    if (!this.current) return this.safeSnapshot({ bridgeVersion: DESKTOP_BRIDGE_VERSION, trust: "none", recent, tasks: [] });
    if (!this.current.trusted) {
      return this.safeSnapshot({
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        trust: "required",
        workspace: { id: this.current.id, name: this.current.name, lock: "available" },
        recent,
        tasks: [],
      });
    }

    try {
      const journal = new TaskRunJournal(this.current.path, this.taskRunRoot);
      const [runs, sessions, lock] = await Promise.all([journal.recent(100), listSessions(this.current.path), journal.lockStatus()]);
      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      const latestRunBySession = new Map<string, (typeof runs)[number]>();
      for (const run of runs) {
        const previous = latestRunBySession.get(run.sessionId);
        if (!previous || run.updatedAt > previous.updatedAt) latestRunBySession.set(run.sessionId, run);
      }
      const taskIds = new Set([...sessionById.keys(), ...latestRunBySession.keys()]);
      const tasks: DesktopTaskSummary[] = [...taskIds].map((id): DesktopTaskSummary => {
        const session = sessionById.get(id);
        const run = latestRunBySession.get(id);
        const status: DesktopTaskSummary["status"] = run?.status ?? "session";
        return {
          id,
          title: boundedTitle(session?.firstTask ?? run?.taskPreview ?? "未命名任务"),
          updatedAt: [session?.updatedAt, run?.updatedAt].filter((value): value is string => Boolean(value)).sort().at(-1)!,
          status,
        };
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100);
      const recoverable = runs.some((run) => (run.status === "running" && !lock.live) || run.status === "paused");
      return this.safeSnapshot({
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        trust: "trusted",
        workspace: {
          id: this.current.id,
          name: this.current.name,
          path: this.current.path,
          lock: lock.active && lock.live ? "active-elsewhere" : recoverable ? "recoverable" : "available",
        },
        recent,
        tasks,
      });
    } catch (error) {
      this.lastError = this.safeError(error);
      return this.safeSnapshot({
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        trust: "trusted",
        workspace: { id: this.current.id, name: this.current.name, path: this.current.path, lock: "available" },
        recent,
        tasks: [],
      });
    }
  }

  async selectWorkspace(selectedPath: string): Promise<DesktopWorkspaceSnapshot> {
    this.lastError = undefined;
    const canonical = await fs.realpath(selectedPath);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error("Selected workspace is not a directory.");
    const trusted = await isWorkspaceTrusted(canonical, this.trustStorePath);
    this.current = { id: workspaceId(canonical), path: canonical, name: path.basename(canonical), trusted };
    if (trusted) await this.remember(canonical);
    return this.snapshot();
  }

  async clearSelection(): Promise<DesktopWorkspaceSnapshot> {
    this.current = undefined;
    this.lastError = undefined;
    return this.snapshot();
  }

  async openRecent(request: OpenRecentWorkspaceRequest): Promise<DesktopWorkspaceSnapshot> {
    if (!request || typeof request.workspaceId !== "string" || !/^[a-f0-9]{24}$/.test(request.workspaceId)) throw new Error("Invalid recent workspace request.");
    const record = (await this.loadRecent()).workspaces.find((item) => item.id === request.workspaceId);
    if (!record) throw new Error("Recent workspace is unavailable.");
    return this.selectWorkspace(record.path);
  }

  async removeRecent(request: RemoveRecentWorkspaceRequest, confirmed: boolean): Promise<DesktopWorkspaceSnapshot> {
    if (!confirmed || request?.confirmed !== true || typeof request.workspaceId !== "string" || !/^[a-f0-9]{24}$/.test(request.workspaceId)) {
      throw new Error("从最近项目移除需要主进程确认。");
    }
    const store = await this.loadRecent();
    if (!store.workspaces.some((item) => item.id === request.workspaceId)) throw new Error("最近项目不存在或已经移除。");
    await this.saveRecent(store.workspaces.filter((item) => item.id !== request.workspaceId));
    if (this.current?.id === request.workspaceId) {
      this.current = undefined;
      this.lastError = undefined;
    }
    return this.snapshot();
  }

  async trustCurrent(request: TrustWorkspaceRequest): Promise<DesktopWorkspaceSnapshot> {
    if (!request || request.acknowledged !== true || typeof request.workspaceId !== "string") throw new Error("Workspace trust requires explicit acknowledgement.");
    if (!this.current || this.current.id !== request.workspaceId) throw new Error("Workspace trust request is unavailable or stale.");
    const canonical = await fs.realpath(this.current.path);
    if (workspaceId(canonical) !== this.current.id) throw new Error("Workspace identity changed before trust confirmation.");
    await trustWorkspace(canonical, this.trustStorePath);
    this.current = { ...this.current, path: canonical, trusted: true };
    await this.remember(canonical);
    return this.snapshot();
  }

  private async recentSnapshot(): Promise<DesktopRecentWorkspace[]> {
    const store = await this.loadRecent();
    const items: DesktopRecentWorkspace[] = [];
    for (const record of store.workspaces.slice(0, 12)) {
      const trusted = await isWorkspaceTrusted(record.path, this.trustStorePath).catch(() => false);
      items.push({ id: record.id, name: path.basename(record.path), trusted, lastOpenedAt: record.lastOpenedAt });
    }
    return items;
  }

  private async loadRecent(): Promise<RecentWorkspaceStore> {
    try {
      const stat = await fs.lstat(this.recentStorePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe desktop workspace history path.");
      const parsed = JSON.parse(await fs.readFile(this.recentStorePath, "utf8")) as unknown;
      if (!validRecentStore(parsed)) throw new Error("Unsupported or corrupt desktop workspace history.");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
      throw error;
    }
  }

  private async remember(workspace: string): Promise<void> {
    const store = await this.loadRecent();
    const id = workspaceId(workspace);
    const workspaces = [{ id, path: workspace, lastOpenedAt: this.now().toISOString() }, ...store.workspaces.filter((item) => item.id !== id)].slice(0, 20);
    await this.saveRecent(workspaces);
  }

  private async saveRecent(workspaces: RecentWorkspaceRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.recentStorePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.recentStorePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.recentStorePath);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private safeSnapshot(snapshot: DesktopWorkspaceSnapshot): DesktopWorkspaceSnapshot {
    return { ...snapshot, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  private safeError(error: unknown): string {
    const value = redactSecrets(error instanceof Error ? error.message : String(error));
    return value.replace(/[A-Za-z]:\\[^\s"']+/g, "[path]").slice(0, 500);
  }
}
