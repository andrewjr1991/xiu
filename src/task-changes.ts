import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isSecretField, redactSecrets } from "./secret-redaction.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LIMITS = { maxFiles: 2_000, maxFileBytes: 256 * 1024, maxTotalBytes: 8 * 1024 * 1024 };
const EXCLUDED_DIRECTORIES = new Set([".git", ".xiu", "node_modules"]);

export interface TaskChangeOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  sensitiveValues?: readonly string[];
}

export interface TaskFileSnapshot {
  state: "present" | "missing" | "unavailable";
  bytes: number;
  digest?: string;
  content?: string;
  modifiedAt?: number;
  mode?: number;
  omitted?: "binary" | "size-limit" | "total-limit" | "link" | "unreadable" | "non-file" | "ignored";
}

/** Ephemeral task state. Never serialize this object into session/run/audit logs. */
export interface TaskChangeSnapshot {
  root: string;
  capturedAt: string;
  git: boolean;
  head?: string;
  files: Map<string, TaskFileSnapshot>;
  index: Map<string, string>;
  preExisting: string[];
  staged: string[];
  complete: boolean;
  warnings: string[];
}

export interface TaskChangeEntry {
  path: string;
  kind: "created" | "modified" | "deleted" | "index-only" | "unknown";
  source: "unknown";
  preExisting: boolean;
  staged: boolean;
  preview?: string;
  limitations: string[];
}

export interface TaskChangeReport {
  view: "task" | "workspace" | "staged";
  git: boolean;
  capturedAt?: string;
  changes: TaskChangeEntry[];
  preExisting: string[];
  complete: boolean;
  warnings: string[];
}

function limits(options: TaskChangeOptions) {
  const bounded = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && value! > 0 ? Math.min(Math.floor(value!), fallback) : fallback;
  return {
    maxFiles: bounded(options.maxFiles, DEFAULT_LIMITS.maxFiles),
    maxFileBytes: bounded(options.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: bounded(options.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
  };
}

function sensitiveValues(options: TaskChangeOptions): string[] {
  return [...(options.sensitiveValues ?? []), ...Object.entries(process.env)
    .filter(([key, value]) => isSecretField(key) && value).map(([, value]) => value!)];
}

function eligible(relative: string): boolean {
  const parts = relative.replace(/\\/g, "/").split("/");
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || parts.some((part) => part === ".." || EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return false;
  // These files are unnecessary for a coding diff and often contain credentials.
  return !parts.some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.ssh|\.aws|\.azure|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(part))
    && !/\.(?:pem|key|p12|pfx|keystore)$/i.test(relative);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
  });
  return stdout;
}

const names = (value: string) => value.split("\0").filter(Boolean).filter(eligible);

interface Inventory {
  git: boolean;
  head?: string;
  paths: string[];
  index: Map<string, string>;
  preExisting: string[];
  staged: string[];
  ignored: string[];
  complete: boolean;
  warnings: string[];
}

// For a non-Git directory, honor positive .gitignore rules conservatively. Negation
// does not re-include excluded files: omitting detail is preferable to reading secrets.
function ignorePattern(line: string, base: string): RegExp | undefined {
  if (!line || line.startsWith("#") || line.startsWith("!")) return undefined;
  const anchored = line.startsWith("/");
  const raw = line.replace(/^\//, "").replace(/\/$/, "");
  const pattern = raw.split("**").map((part) => part.split("*")
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]"))
    .join("[^/]*")).join(".*");
  const prefix = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${prefix}${anchored || raw.includes("/") ? "" : "(?:.*/)?"}${pattern}(?:/|$)`);
}

async function nonGitFiles(root: string, maximum: number): Promise<{ paths: string[]; ignored: string[]; complete: boolean }> {
  const paths: string[] = [];
  const ignored: string[] = [];
  let complete = true;
  let visited = 0;
  async function walk(directory: string, rules: RegExp[]): Promise<void> {
    if (!complete) return;
    const inherited = [...rules];
    const base = directory ? `${directory}/` : "";
    try {
      const ignore = resolveWorkspacePath(root, `${base}.gitignore`);
      const stat = await fs.lstat(ignore);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32_768) {
        for (const line of (await fs.readFile(ignore, "utf8")).split(/\r?\n/)) {
          const pattern = ignorePattern(line.trim(), base);
          if (pattern) inherited.push(pattern);
        }
      }
    } catch { /* absent or unsafe ignore file */ }
    let entries;
    try { entries = await fs.opendir(resolveWorkspacePath(root, directory || ".")); }
    catch { complete = false; return; }
    for await (const entry of entries) {
      if (++visited > maximum * 10 || paths.length >= maximum) { complete = false; break; }
      const relative = `${base}${entry.name}`;
      if (!eligible(relative)) continue;
      if (inherited.some((rule) => rule.test(relative))) { ignored.push(relative); continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(relative, inherited);
      else paths.push(relative);
      if (!complete) break;
    }
  }
  await walk("", []);
  return { paths, ignored, complete };
}

async function inventory(root: string, maximum: number): Promise<Inventory> {
  const empty = { index: new Map<string, string>(), preExisting: [], staged: [], ignored: [], warnings: [] };
  let isGit = false;
  try { isGit = (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true"; } catch { /* no Git */ }
  if (!isGit) {
    const found = await nonGitFiles(root, maximum);
    return { ...empty, git: false, ...found, warnings: ["non-git: ignore rules are conservative; existing changes cannot be compared with HEAD."] };
  }
  try {
    const [listed, ignored, indexed, unstaged, staged, untracked, head] = await Promise.all([
      git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]),
      git(root, ["ls-files", "-z", "--cached", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "--", "."]),
      git(root, ["ls-files", "-z", "--stage", "--", "."]),
      git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--relative", "--no-renames", "-z", "--", "."]),
      git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--relative", "--no-renames", "-z", "--", "."]),
      git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]),
      git(root, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => undefined),
    ]);
    const excluded = new Set(names(ignored).map((file) => file.replace(/\/$/, "")));
    const isExcluded = (file: string) => [...excluded].some((item) => file === item || file.startsWith(`${item}/`));
    const filter = (list: string[]) => list.filter((file) => !isExcluded(file));
    const index = new Map<string, string>();
    for (const line of indexed.split("\0")) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
      if (match && eligible(match[4]!) && !isExcluded(match[4]!)) index.set(match[4]!, `${match[1]} ${match[2]} ${match[3]}`);
    }
    const paths = filter([...new Set(names(listed))]);
    return {
      git: true, head, paths, index, complete: paths.length <= maximum, warnings: [],
      preExisting: filter([...new Set([...names(unstaged), ...names(staged), ...names(untracked)])]).sort(),
      staged: filter(names(staged)), ignored: [...excluded],
    };
  } catch {
    // Do not reinterpret a failed/oversized Git listing as an empty worktree.
    return { ...empty, git: true, paths: [], complete: false, warnings: ["git-inventory-unavailable: file listing failed or exceeded its limit."] };
  }
}

interface CaptureBudget { remaining: number; maxFileBytes: number; secrets: string[] }

function bytesSnapshot(data: Buffer, budget: CaptureBudget): Partial<TaskFileSnapshot> {
  budget.remaining -= data.length;
  const digest = createHash("sha256").update(data).digest("hex");
  try {
    if (data.includes(0)) return { digest, omitted: "binary" };
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return { digest, content: redactSecrets(content, budget.secrets) };
  } catch { return { digest, omitted: "binary" }; }
}

async function captureFile(root: string, relative: string, budget: CaptureBudget): Promise<TaskFileSnapshot> {
  try {
    const target = resolveWorkspacePath(root, relative);
    // Reject links at every component, including in-workspace links and junctions.
    const segments = path.relative(root, target).split(path.sep);
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) return { state: "unavailable", bytes: 0, omitted: "link" };
    }
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return { state: "unavailable", bytes: 0, omitted: "non-file" };
    const entry: TaskFileSnapshot = { state: "present", bytes: stat.size, modifiedAt: stat.mtimeMs, mode: stat.mode };
    if (stat.size > budget.maxFileBytes) return { ...entry, omitted: "size-limit" };
    if (stat.size > budget.remaining) return { ...entry, omitted: "total-limit" };
    // A fixed-size read prevents a growing file from exceeding the memory budget.
    const handle = await fs.open(resolveWorkspacePath(root, relative), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // Recheck resolution and file identity after open, before consuming bytes.
      resolveWorkspacePath(root, relative);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return { ...entry, omitted: "unreadable" };
      const data = Buffer.alloc(Math.min(budget.maxFileBytes, budget.remaining) + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > budget.maxFileBytes || bytesRead > budget.remaining) return { ...entry, omitted: "size-limit" };
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) return { ...entry, omitted: "unreadable" };
      return { ...entry, ...bytesSnapshot(data.subarray(0, bytesRead), budget) };
    } finally { await handle.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing", bytes: 0, content: "" }
      : { state: "unavailable", bytes: 0, omitted: "unreadable" };
  }
}

async function capture(cwd: string, options: TaskChangeOptions, preferred: string[] = []): Promise<TaskChangeSnapshot> {
  const root = await fs.realpath(cwd);
  const limit = limits(options);
  const info = await inventory(root, limit.maxFiles);
  const paths = [...new Set([...preferred.filter(eligible), ...info.paths])];
  const files = new Map<string, TaskFileSnapshot>();
  const budget = { remaining: limit.maxTotalBytes, maxFileBytes: limit.maxFileBytes, secrets: sensitiveValues(options) };
  for (const file of paths.slice(0, limit.maxFiles)) {
    const ignored = info.ignored.some((item) => file === item || file.startsWith(`${item}/`));
    files.set(file, ignored ? { state: "unavailable", bytes: 0, omitted: "ignored" } : await captureFile(root, file, budget));
  }
  const warnings = [...info.warnings];
  if (paths.length > limit.maxFiles || !info.complete) warnings.push("file-limit: coverage is partial; absence does not prove deletion.");
  const omitted = [...files.values()].filter((file) => file.omitted).length;
  if (omitted) warnings.push(`detail-omitted: ${omitted} file(s) are binary, too large, ignored, linked or unreadable; content comparison may be incomplete.`);
  return { root, capturedAt: new Date().toISOString(), ...info, files, complete: info.complete && paths.length <= limit.maxFiles, warnings };
}

export async function captureTaskBaseline(cwd: string, options: TaskChangeOptions = {}): Promise<TaskChangeSnapshot> {
  return capture(cwd, options);
}

function preview(before: TaskFileSnapshot | undefined, after: TaskFileSnapshot | undefined): string | undefined {
  if ((before && before.state !== "missing" && before.content === undefined)
    || (after && after.state !== "missing" && after.content === undefined)) return undefined;
  const textLines = (content: string) => {
    if (!content) return [];
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const oldLines = textLines(before?.content ?? "");
  const newLines = textLines(after?.content ?? "");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  if (start === oldLines.length && start === newLines.length) return undefined;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const clip = (line: string) => line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 180);
  return [`@@ -${oldLines.length ? start + 1 : 0},${oldEnd - start} +${newLines.length ? start + 1 : 0},${newEnd - start} @@ (preview)`,
    ...oldLines.slice(start, Math.min(start + 4, oldEnd)).map((line) => `- ${clip(line)}`),
    ...newLines.slice(start, Math.min(start + 4, newEnd)).map((line) => `+ ${clip(line)}`),
    ...(oldEnd - start > 4 || newEnd - start > 4 ? ["... (preview truncated)"] : [])].join("\n");
}

function changed(before: TaskFileSnapshot | undefined, after: TaskFileSnapshot | undefined): boolean {
  if (!before && !after) return false;
  if (!before || !after) return before?.state !== "missing" || after?.state !== "missing";
  if (before.state !== after.state) return true;
  if (before.digest && after.digest) return before.digest !== after.digest || before.mode !== after.mode;
  return before.bytes !== after.bytes || before.modifiedAt !== after.modifiedAt || before.mode !== after.mode || before.omitted !== after.omitted;
}

function entry(file: string, before: TaskFileSnapshot | undefined, after: TaskFileSnapshot | undefined, preExisting: boolean, staged: boolean, incomplete = false): TaskChangeEntry {
  const uncertain = incomplete || before?.state === "unavailable" || after?.state === "unavailable";
  const kind = uncertain ? "unknown" : (!before || before.state === "missing") ? "created"
    : (!after || after.state === "missing") ? "deleted" : "modified";
  return {
    path: file, kind, source: "unknown", preExisting, staged, preview: preview(before, after),
    limitations: [...new Set([before?.omitted, after?.omitted].filter((value): value is NonNullable<typeof value> => !!value)), ...(incomplete ? ["incomplete-inventory"] : [])],
  };
}

export async function inspectTaskChanges(cwd: string, baseline: TaskChangeSnapshot, options: TaskChangeOptions = {}): Promise<TaskChangeReport> {
  if (await fs.realpath(cwd) !== baseline.root) throw new Error("Task baseline belongs to another workspace.");
  const current = await capture(cwd, options, [...baseline.files.keys()]);
  const changes: TaskChangeEntry[] = [];
  for (const file of new Set([...baseline.files.keys(), ...current.files.keys(), ...baseline.index.keys(), ...current.index.keys()])) {
    const before = baseline.files.get(file), after = current.files.get(file);
    const indexChanged = baseline.index.get(file) !== current.index.get(file);
    const contentChanged = changed(before, after);
    if (!contentChanged && !indexChanged) continue;
    const item = entry(file, before, after, baseline.preExisting.includes(file), current.staged.includes(file),
      (!before && !baseline.complete) || (!after && !current.complete));
    if (!contentChanged && indexChanged) item.kind = "index-only";
    changes.push(item);
  }
  return {
    view: "task", git: current.git, capturedAt: baseline.capturedAt, changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
    preExisting: baseline.preExisting, complete: baseline.complete && current.complete,
    warnings: [...new Set([...baseline.warnings, ...current.warnings,
      ...(baseline.head !== current.head ? ["head-changed: HEAD changed during this task; attribution is unknown."] : [])])],
  };
}

async function blob(root: string, descriptor: string | undefined, budget: CaptureBudget): Promise<TaskFileSnapshot> {
  if (!descriptor) return { state: "missing", bytes: 0, content: "" };
  const [mode, hash, stage = "0"] = descriptor.split(" ");
  if (stage !== "0" || mode === "120000" || mode === "160000" || !/^[a-f0-9]{40,64}$/.test(hash ?? "")) return { state: "unavailable", bytes: 0, omitted: "non-file" };
  try {
    const size = Number((await git(root, ["cat-file", "-s", hash!])).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid blob size");
    if (size > budget.maxFileBytes || size > budget.remaining) return { state: "present", bytes: size, omitted: "size-limit" };
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "cat-file", "blob", hash!], { cwd: root, encoding: "buffer", windowsHide: true, timeout: 10_000, maxBuffer: budget.maxFileBytes + 1 });
    return { state: "present", bytes: size, ...bytesSnapshot(stdout, budget) };
  } catch { return { state: "unavailable", bytes: 0, omitted: "unreadable" }; }
}

/** Workspace includes staged + unstaged + untracked; staged compares HEAD to index. */
export async function getWorkspaceDiff(cwd: string, view: "workspace" | "staged" = "workspace", options: TaskChangeOptions = {}): Promise<TaskChangeReport> {
  const root = await fs.realpath(cwd);
  const limit = limits(options);
  const info = await inventory(root, limit.maxFiles);
  const report: TaskChangeReport = { view, git: info.git, changes: [], preExisting: [], complete: info.complete, warnings: [...info.warnings] };
  if (!info.git) {
    report.warnings.push("no-git-baseline: use the task view after starting a task to inspect changes in this directory.");
    return report;
  }
  const before = new Map<string, string>();
  if (info.head) {
    try {
      for (const line of (await git(root, ["ls-tree", "-r", "-z", info.head, "--", "."])).split("\0")) {
        const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        if (match && eligible(match[3]!)) before.set(match[3]!, `${match[1]} ${match[2]}`);
      }
    } catch { report.complete = false; report.warnings.push("git-head-unavailable: cannot compare file contents with HEAD."); return report; }
  }
  const budget = { remaining: limit.maxTotalBytes, maxFileBytes: limit.maxFileBytes, secrets: sensitiveValues(options) };
  const selected = view === "staged" ? info.staged : info.preExisting;
  if (selected.length > limit.maxFiles) { report.complete = false; report.warnings.push("file-limit: coverage is partial."); }
  for (const file of selected.slice(0, limit.maxFiles).sort()) {
    const previous = await blob(root, before.get(file), budget);
    const current = view === "staged" ? await blob(root, info.index.get(file), budget) : await captureFile(root, file, budget);
    // A worktree edit can cancel a staged edit, leaving HEAD and the file identical.
    if (view === "workspace" && previous.digest && current.digest && previous.digest === current.digest) {
      report.changes.push({ path: file, kind: info.staged.includes(file) ? "index-only" : "modified", source: "unknown", preExisting: false, staged: info.staged.includes(file), limitations: ["content-unchanged: index or file metadata differs"] });
      continue;
    }
    report.changes.push(entry(file, previous, current, false, info.staged.includes(file)));
  }
  return report;
}

export function formatTaskChanges(report: TaskChangeReport, language = "zh-CN"): string {
  const zh = language.startsWith("zh");
  const title = zh ? { task: "本任务期间的改动", workspace: "工作区改动（相对 HEAD，含暂存和未跟踪）", staged: "暂存区改动（相对 HEAD）" }
    : { task: "Changes during this task", workspace: "Workspace changes (against HEAD, including staged and untracked)", staged: "Staged changes (against HEAD)" };
  const labels = zh ? { created: "新增", modified: "修改", deleted: "删除", "index-only": "暂存状态变化", unknown: "变化待核实" }
    : { created: "created", modified: "modified", deleted: "deleted", "index-only": "index change", unknown: "uncertain change" };
  const lines = [title[report.view], zh ? "来源未知：此视图记录时间范围内的变化，可能包含用户或其他进程的修改。" : "Source unknown: changes may include edits by the user or other processes."];
  if (report.capturedAt) lines.push(`${zh ? "任务起点" : "Task baseline"}: ${report.capturedAt}`);
  if (report.view === "task" && report.preExisting.length) {
    lines.push(`${zh ? "开始前已有改动" : "Pre-existing changes"}: ${report.preExisting.length}`);
    lines.push(...report.preExisting.slice(0, 30).map((file) => `  ${JSON.stringify(file)}`));
    if (report.preExisting.length > 30) lines.push("  ...");
  }
  if (!report.changes.length) lines.push(report.complete
    ? (zh ? "在已覆盖的文件中未发现变化。" : "No changes found in covered files.")
    : (zh ? "覆盖不完整，无法断言没有变化。" : "Coverage is incomplete; cannot assert there are no changes."));
  for (const item of report.changes.slice(0, 100)) {
    lines.push(`${labels[item.kind]} ${JSON.stringify(item.path)}${item.preExisting ? (zh ? " [开始前已有改动]" : " [pre-existing]") : ""}${item.staged ? (zh ? " [已暂存]" : " [staged]") : ""}`);
    if (item.preview) lines.push(item.preview);
    if (item.limitations.length) {
      const descriptions: Record<string, string> = { binary: "二进制内容", "size-limit": "单文件大小超限", "total-limit": "快照总大小超限", link: "链接不读取", unreadable: "不可读或读取期间变化", "non-file": "非普通文件或冲突索引", ignored: "已忽略", "incomplete-inventory": "文件枚举不完整", "content-unchanged: index or file metadata differs": "文本内容未变，索引或文件元数据有变化" };
      lines.push(`  ${zh ? "详情限制" : "Detail limitations"}: ${item.limitations.map((value) => zh ? descriptions[value] ?? value : value).join(", ")}`);
    }
  }
  if (report.changes.length > 100) lines.push(zh ? "显示上限为 100 个文件；其余文件未展示。" : "Display limit: 100 files; additional files not shown.");
  const warningDescriptions: Record<string, string> = {
    "non-git": "不是 Git 仓库；保守应用忽略规则，无法与 HEAD 比较原有改动。",
    "no-git-baseline": "无 Git 基线；开始任务后可使用 /diff task 查看任务期间的变化。",
    "git-inventory-unavailable": "Git 文件枚举失败或超出上限，覆盖范围不完整。",
    "file-limit": "文件枚举或数量达到上限，覆盖不完整；未收录不能证明文件已删除。",
    "head-changed": "任务期间 HEAD 已变化，改动来源无法确定。",
    "git-head-unavailable": "无法读取 HEAD，不能比较文件内容。",
    "detail-omitted": "部分文件为二进制、超限、链接、已忽略或不可读，内容比较可能不完整。",
  };
  lines.push(...report.warnings.map((warning) => `${zh ? "注意" : "Note"}: ${zh ? warningDescriptions[warning.split(":")[0]!] ?? warning : warning}`));
  const output = redactSecrets(lines.join("\n"), sensitiveValues({}));
  return output.length > 64_000 ? `${output.slice(0, 64_000)}\n${zh ? "显示已截断。" : "Display truncated."}` : output;
}
