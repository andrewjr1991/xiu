import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { localize, type UiLanguage } from "./i18n.js";
import { legacyTaskRunWorkspaceId } from "./task-run.js";

export const IDENTITY_PREVIEW_ENTRY_LIMIT = 10_000;
type IdentityRole = "current-legacy" | "canonical-legacy" | "proposed";
export interface IdentitySlotPreview {
  id: string;
  roles: IdentityRole[];
  state: "absent" | "scanned" | "unsafe" | "unreadable";
  entries: number;
  regularFiles: number;
  bytes: number;
  jsonFiles: number;
  nonRegularEntries: number;
  /** null when enumeration could not establish presence or absence; never means process liveness. */
  lockPresent: boolean | null;
  truncated: boolean;
  issues: Array<{ reason: string; count: number }>;
}
export interface WorkspaceIdentityPreview {
  schemaVersion: 1;
  generatedAt: string;
  platform: NodeJS.Platform;
  currentLegacyId: string;
  canonicalLegacyId: string;
  proposedId: string;
  identityChangeProposed: boolean;
  entryLimitPerSlot: number;
  metadataComplete: boolean;
  ownershipVerified: false;
  contentValidated: false;
  migrationSupported: false;
  changesApplied: false;
  slots: IdentitySlotPreview[];
}

export function identityPreviewReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? code : "unreadable";
}

async function directoryState(directory: string): Promise<{ state: "ready" | "absent" | "unsafe" | "unreadable"; reason?: string }> {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() ? { state: "ready" } : { state: "unsafe", reason: "UNSAFE_DIRECTORY" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable", reason: identityPreviewReason(error) };
  }
}

function addIssue(slot: IdentitySlotPreview, reason: string): void {
  const existing = slot.issues.find((issue) => issue.reason === reason);
  if (existing) existing.count++;
  else slot.issues.push({ reason, count: 1 });
}

/** Caller must establish workspace trust. Metadata only; never reads records/locks or changes active identities. */
export async function previewWorkspaceIdentity(cwd: string, options: { taskRunRoot?: string; entryLimit?: number; platform?: NodeJS.Platform } = {}): Promise<WorkspaceIdentityPreview> {
  const limit = options.entryLimit ?? IDENTITY_PREVIEW_ENTRY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > IDENTITY_PREVIEW_ENTRY_LIMIT) throw Object.assign(new Error("Invalid identity preview entry limit."), { code: "INVALID_LIMIT" });
  const canonical = await fs.realpath(cwd);
  const platform = options.platform ?? process.platform;
  const root = path.resolve(options.taskRunRoot ?? path.join(os.homedir(), ".xiu", "task-runs"));
  // Keep the operational lexical-path legacy slot visible too: a CLI --cwd alias may differ from its canonical path.
  const currentLegacyId = legacyTaskRunWorkspaceId(cwd);
  const canonicalLegacyId = legacyTaskRunWorkspaceId(canonical);
  const proposedId = platform === "win32" ? currentLegacyId : createHash("sha256").update(`xiu-workspace-identity-v2\0${canonical}`).digest("hex").slice(0, 24);
  const grouped = new Map<string, IdentityRole[]>();
  for (const [id, role] of [[currentLegacyId, "current-legacy"], [canonicalLegacyId, "canonical-legacy"], [proposedId, "proposed"]] as const) {
    grouped.set(id, [...(grouped.get(id) ?? []), role]);
  }
  let rootState = await directoryState(path.dirname(root));
  if (rootState.state === "ready") rootState = await directoryState(root);
  const slots: IdentitySlotPreview[] = [];
  for (const [id, roles] of grouped) {
    const slot: IdentitySlotPreview = { id, roles, state: "absent", entries: 0, regularFiles: 0, bytes: 0, jsonFiles: 0, nonRegularEntries: 0, lockPresent: false, truncated: false, issues: [] };
    slots.push(slot);
    const directory = path.join(root, id);
    const state = rootState.state === "ready" ? await directoryState(directory) : rootState;
    if (state.state !== "ready") {
      slot.state = state.state;
      if (state.reason) { addIssue(slot, state.reason); slot.lockPresent = null; }
      continue;
    }
    slot.state = "scanned";
    slot.lockPresent = null;
    try {
      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (slot.entries >= limit) { slot.truncated = true; break; }
        slot.entries++;
        if (entry.name === ".active.lock") slot.lockPresent = true;
        try {
          const stat = await fs.lstat(path.join(directory, entry.name));
          if (!stat.isFile() || stat.isSymbolicLink()) slot.nonRegularEntries++;
          else { slot.regularFiles++; slot.bytes += stat.size; if (entry.name.endsWith(".json")) slot.jsonFiles++; }
        } catch (error) { addIssue(slot, identityPreviewReason(error)); }
      }
      if (!slot.truncated && slot.lockPresent === null) slot.lockPresent = false;
    } catch (error) { slot.state = "unreadable"; addIssue(slot, identityPreviewReason(error)); }
  }
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), platform,
    currentLegacyId, canonicalLegacyId, proposedId, identityChangeProposed: proposedId !== currentLegacyId,
    entryLimitPerSlot: limit,
    metadataComplete: slots.every((slot) => ["absent", "scanned"].includes(slot.state) && !slot.truncated && !slot.nonRegularEntries && !slot.issues.length),
    ownershipVerified: false, contentValidated: false, migrationSupported: false, changesApplied: false, slots,
  };
}

export function formatWorkspaceIdentityPreview(preview: WorkspaceIdentityPreview, language: UiLanguage): string {
  const labels: Record<IdentityRole, string> = {
    "current-legacy": localize(language, "当前旧身份", "current legacy"),
    "canonical-legacy": localize(language, "规范路径旧身份", "canonical legacy"),
    proposed: localize(language, "迁移建议（仅显示）", "migration proposal (display only)"),
  };
  return [
    localize(language, "工作区身份（只读预览）", "Workspace identity (read-only preview)"),
    ...preview.slots.map((slot) => {
      const state = { absent: "不存在", scanned: "已扫描", unsafe: "目录不安全", unreadable: "无法读取" }[slot.state];
      const prefix = `${slot.roles.map((role) => labels[role]).join(" / ")} ${slot.id}`;
      return localize(language,
        `${prefix}：${state}；${slot.regularFiles} 个普通文件，${slot.bytes} 字节，${slot.jsonFiles} 个 JSON；${slot.nonRegularEntries} 个非普通条目；锁${slot.lockPresent === null ? "未知" : slot.lockPresent ? "存在" : "不存在"}${slot.truncated ? "；已截断" : ""}${slot.issues.length ? `；${slot.issues.map((issue) => `${issue.reason} ×${issue.count}`).join("、")}` : ""}`,
        `${prefix}: ${slot.state}; ${slot.regularFiles} file(s), ${slot.bytes} bytes, ${slot.jsonFiles} JSON; non-regular ${slot.nonRegularEntries}; lock ${slot.lockPresent === null ? "unknown" : slot.lockPresent ? "present" : "absent"}${slot.truncated ? "; truncated" : ""}${slot.issues.length ? `; ${slot.issues.map((issue) => `${issue.reason} ×${issue.count}`).join(", ")}` : ""}`);
    }),
    localize(language,
      `元数据扫描${preview.metadataComplete ? "完成" : "不完整"}；每个身份最多检查 ${preview.entryLimitPerSlot} 个目录条目。只统计普通文件长度，不读取正文；锁存在不代表进程存活。`,
      `Metadata scan ${preview.metadataComplete ? "complete" : "incomplete"}; at most ${preview.entryLimitPerSlot} entries per identity. File lengths only; contents are not read. Lock presence does not prove process liveness.`),
    localize(language,
      "所有权未核实，尚不支持迁移，当前运行身份未改动。没有改动记录或锁，没有重放操作，也未放宽恢复检查。",
      "Ownership is unverified; migration is not implemented and the active identity was not changed. No records or locks were changed, no operation replayed, and recovery checks were not relaxed."),
  ].join("\n");
}
