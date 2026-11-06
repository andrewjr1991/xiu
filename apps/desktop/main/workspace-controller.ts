import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listSessionsWithIssues, unreadableSessionsNote } from "../../../src/session.js";
import { redactSecrets } from "../../../src/secret-redaction.js";
import { unreadableRunsNote } from "../../../src/history-notices.js";
import { TaskRunJournal } from "../../../src/task-run.js";
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
  const normalized = process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
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
    const current = this.current;
    const recent = await this.recentSnapshot();
    if (current !== this.current) return this.snapshot();
    if (!current) return this.safeSnapshot({ bridgeVersion: DESKTOP_BRIDGE_VERSION, trust: "none", recent, tasks: [] });
    if (!current.trusted) {
      return this.safeSnapshot({
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        trust: "required",
        workspace: { id: current.id, name: current.name, lock: "available" },
        recent,
        tasks: [],
      });
    }

    try {
      const journal = new TaskRunJournal(current.path, this.taskRunRoot);
      const [runListing, listing, lock] = await Promise.all([journal.scan(100), listSessionsWithIssues(current.path), journal.lockStatus()]);
      if (current !== this.current) return this.snapshot();
      const runs = runListing.records;
      const { sessions, unreadable, directoryIssues } = listing;
      const historyWarning = [unreadableRunsNote(runListing.unreadable, "zh-CN"), unreadableSessionsNote(unreadable, "zh-CN", sessions, directoryIssues)].filter(Boolean).join(" ") || undefined;
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
          title: boundedTitle(session?.firstTask || run?.taskPreview || "未命名任务"),
          updatedAt: [session?.updatedAt, run?.updatedAt].filter((value): value is string => Boolean(value)).sort().at(-1)!,
          status,
          manualAccepted: run?.manualAcceptance?.decision === "passed",
        };
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100);
      this.lastError = undefined;
      const recoverable = runs.some((run) => (run.status === "running" && !lock.live) || run.status === "paused");
      return this.safeSnapshot({
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        trust: "trusted",
        workspace: {
          id: current.id,
          name: current.name,
          path: current.path,
          lock: lock.active && lock.live ? "active-elsewhere" : recoverable ? "recoverable" : "available",
        },
        recent,
        tasks,
        ...(historyWarning ? { error: historyWarning } : {}),
      });
    } catch (error) {
      if (current !== this.current) return this.snapshot();
      this.lastError = this.safeError(error);
      return this.safeSnapshot({
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        trust: "trusted",
        workspace: { id: current.id, name: current.name, path: current.path, lock: "available" },
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
    const current = this.current;
    if (!current || current.id !== request.workspaceId) throw new Error("Workspace trust request is unavailable or stale.");
    const canonical = await fs.realpath(current.path);
    if (current !== this.current || workspaceId(canonical) !== current.id) throw new Error("Workspace selection or identity changed before trust confirmation.");
    await trustWorkspace(canonical, this.trustStorePath);
    if (current !== this.current) throw new Error("Workspace selection changed while trust was saved; the decision was not applied to the current selection.");
    this.current = { ...current, path: canonical, trusted: true };
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
      // Recent entries retain their canonical paths, so display identifiers can be
      // upgraded without rewriting the store or reusing a case-folded POSIX ID.
      const seen = new Set<string>();
      return { version: 1, workspaces: parsed.workspaces.map((record) => ({ ...record, id: workspaceId(record.path) })).filter((record) => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
      }) };
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
