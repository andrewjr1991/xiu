import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AgentTool } from "./types.js";

const INDEX_VERSION = 2;
const MAX_FILES = 8_000;
const MAX_INDEXED_FILE_BYTES = 512 * 1024;
const MAX_TERMS_PER_FILE = 300;
const MAX_TERM_CHARACTERS = 160;
const IGNORES = [
  "**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**", "**/.xiu/**", "**/vendor/**",
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*", "**/*secrets*",
];
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".scss", ".html", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".rb", ".swift", ".sql", ".yaml", ".yml", ".toml", ".xml",
  ".sh", ".ps1", ".txt", ".env", ".graphql", ".proto",
]);

interface IndexedFile {
  path: string;
  size: number;
  modifiedMs: number;
  terms: string[];
}

export interface ProjectProfile {
  stacks: string[];
  packageManager?: string;
  checks: Record<string, string>;
  markers: string[];
}

interface StoredIndex {
  version: number;
  generatedAt: string;
  files: IndexedFile[];
  profile: ProjectProfile;
  truncated: boolean;
}

export type IndexRefreshMode = "none" | "full" | "incremental" | "cache";

export interface ProjectIndexStatus {
  files: number;
  generatedAt: string;
  truncated: boolean;
  dirty: boolean;
  mode: IndexRefreshMode;
  durationMs: number;
  discovered: number;
  reused: number;
  indexed: number;
  added: number;
  updated: number;
  removed: number;
  cachePersisted: boolean;
}

interface FileMetadata {
  path: string;
  size: number;
  modifiedMs: number;
}

function tokenize(value: string, maximum = MAX_TERMS_PER_FILE): string[] {
  const normalized = value.toLowerCase();
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[a-z_][a-z0-9_.-]{1,}|[\u3400-\u9fff]{2,}/g)) {
    const word = match[0];
    if (word.length <= MAX_TERM_CHARACTERS) result.add(word);
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let index = 0; index < word.length - 1 && result.size < maximum; index++) result.add(word.slice(index, index + 2));
    }
    if (result.size >= maximum) break;
  }
  return [...result];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validStringArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string" && item.length <= 2_000);
}

function safeCachedPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) return undefined;
  const normalized = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) return undefined;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
  return normalized;
}

function validateStoredIndex(cwd: string, value: unknown): StoredIndex | undefined {
  if (!isRecord(value) || value.version !== INDEX_VERSION || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) return undefined;
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES || typeof value.truncated !== "boolean" || !isRecord(value.profile)) return undefined;
  const profile = value.profile;
  if (!validStringArray(profile.stacks, 100) || !validStringArray(profile.markers, 1_000) || !isRecord(profile.checks)) return undefined;
  if (profile.packageManager !== undefined && (typeof profile.packageManager !== "string" || profile.packageManager.length > 100)) return undefined;
  const checks: Record<string, string> = {};
  for (const [name, command] of Object.entries(profile.checks)) {
    if (name.length > 100 || typeof command !== "string" || command.length > 2_000) return undefined;
    checks[name] = command;
  }
  const files: IndexedFile[] = [];
  const seen = new Set<string>();
  for (const raw of value.files) {
    if (!isRecord(raw)) return undefined;
    const cachedPath = safeCachedPath(cwd, raw.path);
    if (!cachedPath || seen.has(cachedPath) || typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0) return undefined;
    if (typeof raw.modifiedMs !== "number" || !Number.isFinite(raw.modifiedMs) || raw.modifiedMs < 0) return undefined;
    if (!Array.isArray(raw.terms) || raw.terms.length > MAX_TERMS_PER_FILE || !raw.terms.every((term) => typeof term === "string" && term.length <= MAX_TERM_CHARACTERS)) return undefined;
    seen.add(cachedPath);
    files.push({ path: cachedPath, size: raw.size, modifiedMs: raw.modifiedMs, terms: [...raw.terms] });
  }
  return {
    version: INDEX_VERSION,
    generatedAt: value.generatedAt,
    files,
    profile: { stacks: [...profile.stacks], packageManager: profile.packageManager as string | undefined, checks, markers: [...profile.markers] },
    truncated: value.truncated,
  };
}

async function detectProfile(cwd: string, files: string[]): Promise<ProjectProfile> {
  const set = new Set(files.map((file) => file.replace(/\\/g, "/")));
  const stacks = new Set<string>();
  const checks: Record<string, string> = {};
  const markers = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "*.sln"]
    .flatMap((marker) => marker.includes("*") ? files.filter((file) => file.endsWith(marker.slice(1))) : set.has(marker) ? [marker] : []);
  let packageManager: string | undefined;

  if (set.has("package.json")) {
    stacks.add("Node.js");
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown };
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      if (dependencies.typescript) stacks.add("TypeScript");
      if (dependencies.react) stacks.add("React");
      if (dependencies.next) stacks.add("Next.js");
      if (dependencies.vue) stacks.add("Vue");
      if (dependencies.svelte) stacks.add("Svelte");
      if (dependencies.express) stacks.add("Express");
      if (dependencies["@nestjs/core"]) stacks.add("NestJS");
      if (dependencies.vite) stacks.add("Vite");
      if (pkg.workspaces) stacks.add("JavaScript monorepo");
      for (const name of ["test", "typecheck", "lint", "build"]) if (pkg.scripts?.[name]) checks[name] = `npm run ${name}`;
    } catch { /* malformed package metadata is reported by project tools */ }
    packageManager = set.has("pnpm-lock.yaml") ? "pnpm" : set.has("yarn.lock") ? "yarn" : set.has("bun.lockb") || set.has("bun.lock") ? "bun" : "npm";
    for (const [name, command] of Object.entries(checks)) checks[name] = command.replace(/^npm/, packageManager);
  }
  if (set.has("pyproject.toml") || set.has("requirements.txt")) {
    stacks.add("Python");
    checks.test ??= "python -m pytest";
  }
  if (set.has("Cargo.toml")) { stacks.add("Rust"); checks.test ??= "cargo test"; checks.build ??= "cargo build"; }
  if (set.has("go.mod")) { stacks.add("Go"); checks.test ??= "go test ./..."; checks.build ??= "go build ./..."; }
  if (set.has("pom.xml")) { stacks.add("Java/Maven"); checks.test ??= "mvn test"; checks.build ??= "mvn package"; }
  if (set.has("build.gradle") || set.has("build.gradle.kts")) { stacks.add("Java/Gradle"); checks.test ??= "gradle test"; checks.build ??= "gradle build"; }
  if (files.some((file) => file.endsWith(".sln") || file.endsWith(".csproj"))) { stacks.add(".NET"); checks.test ??= "dotnet test"; checks.build ??= "dotnet build"; }
  return { stacks: [...stacks], packageManager, checks, markers };
}

export class ProjectIndex {
  private data?: StoredIndex;
  private dirty = false;
  private refreshPromise?: Promise<void>;
  private refreshStatus: ProjectIndexStatus = {
    files: 0,
    generatedAt: "not initialized",
    truncated: false,
    dirty: false,
    mode: "none",
    durationMs: 0,
    discovered: 0,
    reused: 0,
    indexed: 0,
    added: 0,
    updated: 0,
    removed: 0,
    cachePersisted: false,
  };

  constructor(private readonly cwd: string) {}

  async initialize(force = false): Promise<void> {
    if (!force && this.data && !this.dirty) return;
    if (this.refreshPromise) return await this.refreshPromise;
    const refresh = this.refresh(force);
    this.refreshPromise = refresh;
    try { await refresh; }
    finally { if (this.refreshPromise === refresh) this.refreshPromise = undefined; }
  }

  private async loadCache(indexFile: string): Promise<StoredIndex | undefined> {
    try {
      return validateStoredIndex(this.cwd, JSON.parse(await fs.readFile(indexFile, "utf8")));
    } catch { return undefined; }
  }

  private async discover(): Promise<{ discovered: number; paths: string[]; metadata: FileMetadata[] }> {
    const found = await fg("**/*", { cwd: this.cwd, onlyFiles: true, dot: true, unique: true, followSymbolicLinks: false, ignore: IGNORES });
    const paths = found.map((relative) => relative.replace(/\\/g, "/")).sort().slice(0, MAX_FILES);
    const metadata: FileMetadata[] = [];
    for (let offset = 0; offset < paths.length; offset += 128) {
      const batch = await Promise.all(paths.slice(offset, offset + 128).map(async (relative): Promise<FileMetadata | undefined> => {
        try {
          const stat = await fs.lstat(path.join(this.cwd, relative));
          if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
          return { path: relative, size: stat.size, modifiedMs: stat.mtimeMs };
        } catch { return undefined; }
      }));
      metadata.push(...batch.filter((item): item is FileMetadata => Boolean(item)));
    }
    return { discovered: found.length, paths: metadata.map((item) => item.path), metadata };
  }

  private async indexFile(metadata: FileMetadata): Promise<IndexedFile> {
    let terms = tokenize(metadata.path);
    const extension = path.extname(metadata.path).toLowerCase();
    if (metadata.size <= MAX_INDEXED_FILE_BYTES && (TEXT_EXTENSIONS.has(extension) || !extension)) {
      try {
        const contentTerms = tokenize(await fs.readFile(path.join(this.cwd, metadata.path), "utf8"));
        terms = [...new Set([...terms, ...contentTerms])].slice(0, MAX_TERMS_PER_FILE);
      } catch { /* retain path-only terms when a file changes during refresh */ }
    }
    return { ...metadata, terms };
  }

  private async persist(indexFile: string, data: StoredIndex): Promise<boolean> {
    const directory = path.dirname(indexFile);
    const temporary = path.join(directory, `index.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(data), { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, indexFile);
      return true;
    } catch {
      try { await fs.unlink(temporary); } catch { /* nothing to clean */ }
      return false;
    }
  }

  private async refresh(force: boolean): Promise<void> {
    const startedAt = Date.now();
    const indexFile = path.join(this.cwd, ".xiu", "index.json");
    const previousWasInMemory = Boolean(this.data);
    const previous = force ? undefined : this.data ?? await this.loadCache(indexFile);
    const discovery = await this.discover();
    const previousByPath = new Map(previous?.files.map((file) => [file.path, file]));
    const files: IndexedFile[] = [];
    let reused = 0;
    let added = 0;
    let updated = 0;
    for (let offset = 0; offset < discovery.metadata.length; offset += 64) {
      const batch = await Promise.all(discovery.metadata.slice(offset, offset + 64).map(async (metadata): Promise<IndexedFile> => {
        const cached = previousByPath.get(metadata.path);
        if (cached && cached.size === metadata.size && cached.modifiedMs === metadata.modifiedMs) {
          reused++;
          return cached;
        }
        if (cached) updated++;
        else added++;
        return await this.indexFile(metadata);
      }));
      files.push(...batch);
    }
    const currentPaths = new Set(discovery.paths);
    const removed = previous?.files.filter((file) => !currentPaths.has(file.path)).length ?? 0;
    const changed = added + updated + removed;
    const truncated = discovery.discovered > MAX_FILES;
    const metadataChanged = Boolean(previous && previous.truncated !== truncated);
    const mode: IndexRefreshMode = !previous ? "full" : changed || metadataChanged ? "incremental" : "cache";
    const data: StoredIndex = {
      version: INDEX_VERSION,
      generatedAt: mode === "cache" ? previous!.generatedAt : new Date().toISOString(),
      files,
      profile: mode === "cache" ? previous!.profile : await detectProfile(this.cwd, discovery.paths),
      truncated,
    };
    const cachePersisted = mode === "cache" ? (previousWasInMemory ? this.refreshStatus.cachePersisted : true) : await this.persist(indexFile, data);
    this.data = data;
    this.dirty = false;
    this.refreshStatus = {
      files: files.length,
      generatedAt: data.generatedAt,
      truncated: data.truncated,
      dirty: false,
      mode,
      durationMs: Date.now() - startedAt,
      discovered: discovery.discovered,
      reused,
      indexed: files.length - reused,
      added,
      updated,
      removed,
      cachePersisted,
    };
  }

  invalidate(): void {
    this.dirty = true;
    this.refreshStatus = { ...this.refreshStatus, dirty: true };
  }

  profile(): ProjectProfile {
    if (!this.data) throw new Error("Project index is not initialized");
    return this.data.profile;
  }

  status(): ProjectIndexStatus {
    return { ...this.refreshStatus, dirty: this.dirty };
  }

  paths(query = "", limit = 200): string[] {
    if (!this.data) return [];
    const normalized = query.toLowerCase().replace(/\\/g, "/");
    return this.data.files
      .map((file) => file.path)
      .filter((file) => !normalized || file.toLowerCase().includes(normalized))
      .sort((a, b) => {
        const aPrefix = a.toLowerCase().startsWith(normalized) ? 0 : 1;
        const bPrefix = b.toLowerCase().startsWith(normalized) ? 0 : 1;
        return aPrefix - bPrefix || a.length - b.length || a.localeCompare(b);
      })
      .slice(0, Math.max(1, Math.min(limit, 1_000)));
  }

  async search(query: string, limit = 8): Promise<string> {
    if (!this.data || this.dirty) await this.initialize();
    const terms = tokenize(query, 64).filter((term) => term.length >= 2);
    if (!terms.length) return "No relevant files found.";
    const scored = this.data!.files.map((file) => {
      const pathText = file.path.toLowerCase();
      const fileTerms = new Set(file.terms);
      let score = 0;
      for (const term of terms) {
        if (pathText.includes(term)) score += 8;
        if (fileTerms.has(term)) score += 2;
      }
      return { file, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path)).slice(0, Math.min(20, Math.max(1, limit)));
    if (!scored.length) return "No relevant files found.";
    const results: string[] = [];
    for (const { file, score } of scored) {
      let excerpt = "";
      try {
        const content = await fs.readFile(path.join(this.cwd, file.path), "utf8");
        const lines = content.split(/\r?\n/);
        const match = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
        const start = Math.max(0, match < 0 ? 0 : match - 2);
        excerpt = lines.slice(start, start + 8).map((line, index) => `${start + index + 1}: ${line}`).join("\n").slice(0, 1600);
      } catch { /* metadata-only result */ }
      results.push(`### ${file.path} (relevance ${score})${excerpt ? `\n${excerpt}` : ""}`);
    }
    return results.join("\n\n");
  }
}

export function createProjectIndexTools(index: ProjectIndex): AgentTool[] {
  return [
    {
      name: "find_relevant_code",
      description: "Search Xiu's project index for files and code relevant to a concept, bug, symbol, or requested change. Prefer this before broad file scanning.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
        required: ["query"], additionalProperties: false,
      },
      describe: (input) => `find code relevant to ${String(input.query)}`,
      async execute(input) {
        if (typeof input.query !== "string" || !input.query.trim()) throw new Error("query must be a non-empty string");
        return await index.search(input.query, typeof input.limit === "number" ? input.limit : 8);
      },
    },
    {
      name: "project_profile",
      description: "Read the automatically detected project technology stack, package manager, and verification commands.",
      risk: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      describe: () => "read detected project profile",
      async execute() {
        await index.initialize();
        return JSON.stringify(index.profile(), null, 2);
      },
    },
  ];
}
