import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  analyzeSource,
  MAX_IMPORTS_PER_FILE,
  MAX_REFERENCES_PER_FILE,
  MAX_SIGNATURE_CHARACTERS,
  MAX_SYMBOLS_PER_FILE,
  resolveModuleSpecifier,
  sourceLanguage,
  type ImportBindingKind,
  type IndexedImport,
  type IndexedReference,
  type IndexedReferenceKind,
  type IndexedSymbol,
  type IndexedSymbolKind,
} from "./code-intelligence.js";
import type { AgentTool } from "./types.js";

const INDEX_VERSION = 3;
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
  language: string;
  analyzed: boolean;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  references: IndexedReference[];
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
  analyzedModules: number;
  symbols: number;
  dependencies: number;
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

const SYMBOL_KINDS = new Set<IndexedSymbolKind>(["function", "class", "interface", "type", "enum", "namespace", "variable", "method", "property"]);
const REFERENCE_KINDS = new Set<IndexedReferenceKind>(["reference", "call", "construct", "tag"]);
const BINDING_KINDS = new Set<ImportBindingKind>(["named", "default", "namespace"]);

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function positivePosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validateSymbol(value: unknown): IndexedSymbol | undefined {
  if (!isRecord(value) || !boundedString(value.name, 200) || !SYMBOL_KINDS.has(value.kind as IndexedSymbolKind)) return undefined;
  if (!positivePosition(value.line) || !positivePosition(value.column) || typeof value.exported !== "boolean" || typeof value.defaultExport !== "boolean" || !boundedString(value.signature, MAX_SIGNATURE_CHARACTERS)) return undefined;
  if (value.container !== undefined && !boundedString(value.container, 300)) return undefined;
  return { name: value.name, kind: value.kind as IndexedSymbolKind, line: value.line, column: value.column, ...(value.container ? { container: value.container as string } : {}), exported: value.exported, defaultExport: value.defaultExport, signature: value.signature };
}

function validateImport(value: unknown): IndexedImport | undefined {
  if (!isRecord(value) || !boundedString(value.specifier, 1_000) || !positivePosition(value.line) || !Array.isArray(value.bindings) || value.bindings.length > MAX_SYMBOLS_PER_FILE) return undefined;
  const bindings = value.bindings.map((binding): IndexedImport["bindings"][number] | undefined => {
    if (!isRecord(binding) || !boundedString(binding.imported, 200) || !boundedString(binding.local, 200) || !BINDING_KINDS.has(binding.kind as ImportBindingKind)) return undefined;
    if (!positivePosition(binding.line) || !positivePosition(binding.column)) return undefined;
    return { imported: binding.imported, local: binding.local, kind: binding.kind as ImportBindingKind, line: binding.line, column: binding.column };
  });
  if (bindings.some((binding) => !binding)) return undefined;
  return { specifier: value.specifier, line: value.line, bindings: bindings as IndexedImport["bindings"] };
}

function validateReference(value: unknown): IndexedReference | undefined {
  if (!isRecord(value) || !boundedString(value.name, 200) || !REFERENCE_KINDS.has(value.kind as IndexedReferenceKind)) return undefined;
  if (!positivePosition(value.line) || !positivePosition(value.column)) return undefined;
  if (value.qualifier !== undefined && !boundedString(value.qualifier, 80)) return undefined;
  if (value.container !== undefined && !boundedString(value.container, 300)) return undefined;
  return { name: value.name, line: value.line, column: value.column, kind: value.kind as IndexedReferenceKind, ...(value.qualifier ? { qualifier: value.qualifier as string } : {}), ...(value.container ? { container: value.container as string } : {}) };
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
    if (!boundedString(raw.language, 100) || typeof raw.analyzed !== "boolean") return undefined;
    if (!Array.isArray(raw.symbols) || raw.symbols.length > MAX_SYMBOLS_PER_FILE || !Array.isArray(raw.imports) || raw.imports.length > MAX_IMPORTS_PER_FILE || !Array.isArray(raw.references) || raw.references.length > MAX_REFERENCES_PER_FILE) return undefined;
    const symbols = raw.symbols.map(validateSymbol);
    const imports = raw.imports.map(validateImport);
    const references = raw.references.map(validateReference);
    if (symbols.some((item) => !item) || imports.some((item) => !item) || references.some((item) => !item)) return undefined;
    seen.add(cachedPath);
    files.push({ path: cachedPath, size: raw.size, modifiedMs: raw.modifiedMs, terms: [...raw.terms], language: raw.language, analyzed: raw.analyzed, symbols: symbols as IndexedSymbol[], imports: imports as IndexedImport[], references: references as IndexedReference[] });
  }
  return {
    version: INDEX_VERSION,
    generatedAt: value.generatedAt,
    files,
    profile: { stacks: [...profile.stacks], packageManager: profile.packageManager as string | undefined, checks, markers: [...profile.markers] },
    truncated: value.truncated,
  };
}

function workspaceFilter(value: unknown, field: string): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 4_096 || value.includes("\0")) throw new Error(`${field} must be a workspace-relative path`);
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized.split("/").some((part) => part === "..")) throw new Error(`${field} must be a workspace-relative path`);
  return normalized;
}

function matchesPath(filename: string, filter: string): boolean {
  return !filter || filename === filter || filename.startsWith(`${filter}/`);
}

function integerInput(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function jsonPage(base: Record<string, unknown>, items: unknown[], offset: number, limit: number, key: string): string {
  const available = Math.max(0, items.length - offset);
  let count = Math.min(limit, available);
  while (count >= 0) {
    const returned = items.slice(offset, offset + count);
    const result = { ...base, offset, returned_count: returned.length, next_offset: offset + returned.length < items.length ? offset + returned.length : null, [key]: returned };
    const encoded = JSON.stringify(result, null, 2);
    if (encoded.length <= 60_000) return encoded;
    count--;
  }
  throw new Error("Result metadata exceeds the output limit");
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
    analyzedModules: 0,
    symbols: 0,
    dependencies: 0,
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
    let intelligence = { language: sourceLanguage(metadata.path), analyzed: false, symbols: [] as IndexedSymbol[], imports: [] as IndexedImport[], references: [] as IndexedReference[] };
    const extension = path.extname(metadata.path).toLowerCase();
    if (metadata.size <= MAX_INDEXED_FILE_BYTES && (TEXT_EXTENSIONS.has(extension) || !extension)) {
      try {
        const content = await fs.readFile(path.join(this.cwd, metadata.path), "utf8");
        const contentTerms = tokenize(content);
        terms = [...new Set([...terms, ...contentTerms])].slice(0, MAX_TERMS_PER_FILE);
        intelligence = analyzeSource(metadata.path, content);
      } catch { /* retain path-only terms when a file changes during refresh */ }
    }
    return { ...metadata, terms, ...intelligence };
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
      analyzedModules: files.filter((file) => file.analyzed).length,
      symbols: files.reduce((total, file) => total + file.symbols.length, 0),
      dependencies: files.reduce((total, file) => total + file.imports.length, 0),
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

  private availablePaths(): Set<string> {
    return new Set(this.data?.files.map((file) => file.path) ?? []);
  }

  private definitionRows(query: string, kind?: string, pathFilter = ""): Array<IndexedSymbol & { path: string }> {
    if (!this.data) return [];
    const normalized = query.toLowerCase();
    return this.data.files.flatMap((file) => matchesPath(file.path, pathFilter)
      ? file.symbols.filter((symbol) => !kind || symbol.kind === kind).map((symbol) => ({ ...symbol, path: file.path }))
      : [])
      .map((definition) => {
        const name = definition.name.toLowerCase();
        const rank = definition.name === query ? 0 : name === normalized ? 1 : name.startsWith(normalized) ? 2 : name.includes(normalized) ? 3 : 4;
        return { definition, rank };
      })
      .filter((item) => item.rank < 4)
      .sort((left, right) => left.rank - right.rank || left.definition.name.localeCompare(right.definition.name) || left.definition.path.localeCompare(right.definition.path) || left.definition.line - right.definition.line)
      .map((item) => item.definition);
  }

  async repositoryMap(input: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const pathFilter = workspaceFilter(input.path, "path");
    const offset = integerInput(input.offset, 0, 0, 1_000_000, "offset");
    const limit = integerInput(input.limit, 30, 1, 100, "limit");
    const files = this.data!.files.filter((file) => matchesPath(file.path, pathFilter));
    const available = this.availablePaths();
    const dependentCounts = new Map<string, number>();
    const dependenciesByPath = new Map<string, string[]>();
    for (const file of this.data!.files) {
      const dependencies = [...new Set(file.imports.map((item) => resolveModuleSpecifier(file.path, item.specifier, available)).filter((item): item is string => Boolean(item)))];
      dependenciesByPath.set(file.path, dependencies);
      for (const dependency of dependencies) dependentCounts.set(dependency, (dependentCounts.get(dependency) ?? 0) + 1);
    }
    const modules = files.map((file) => ({
      path: file.path,
      language: file.language,
      analyzed: file.analyzed,
      symbols: file.symbols.filter((symbol) => symbol.exported || !symbol.container).sort((left, right) => Number(right.exported) - Number(left.exported) || left.line - right.line).slice(0, 12).map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line, ...(symbol.container ? { container: symbol.container } : {}), exported: symbol.exported, default_export: symbol.defaultExport })),
      symbols_truncated: file.symbols.filter((symbol) => symbol.exported || !symbol.container).length > 12,
      dependencies: (dependenciesByPath.get(file.path) ?? []).slice(0, 20),
      dependencies_truncated: (dependenciesByPath.get(file.path)?.length ?? 0) > 20,
      dependents: dependentCounts.get(file.path) ?? 0,
    }));
    const directories = new Map<string, number>();
    for (const file of files) {
      const directory = file.path.includes("/") ? file.path.split("/", 1)[0] : ".";
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
    const directoryRows = [...directories]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, moduleCount]) => ({ name, modules: moduleCount }));
    return jsonPage({
      tool: "repository_map",
      path: pathFilter || ".",
      module_count: files.length,
      analyzed_module_count: files.filter((file) => file.analyzed).length,
      symbol_count: files.reduce((total, file) => total + file.symbols.length, 0),
      dependency_count: files.reduce((total, file) => total + (dependenciesByPath.get(file.path)?.length ?? 0), 0),
      directories: directoryRows.slice(0, 100),
      directories_truncated: directoryRows.length > 100,
    }, modules, offset, limit, "modules");
  }

  async findSymbols(input: Record<string, unknown>): Promise<string> {
    await this.initialize();
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) throw new Error("query must be a non-empty symbol name up to 200 characters");
    const kind = input.kind === undefined ? undefined : String(input.kind);
    if (kind && !SYMBOL_KINDS.has(kind as IndexedSymbolKind)) throw new Error(`Unknown symbol kind: ${kind}`);
    const pathFilter = workspaceFilter(input.path, "path");
    const offset = integerInput(input.offset, 0, 0, 1_000_000, "offset");
    const limit = integerInput(input.limit, 20, 1, 100, "limit");
    const definitions = this.definitionRows(input.query.trim(), kind, pathFilter);
    return jsonPage({ tool: "find_symbol", query: input.query.trim(), match_count: definitions.length }, definitions, offset, limit, "definitions");
  }

  private selectedDefinition(symbol: string, definedIn: string): { definitions: Array<IndexedSymbol & { path: string }>; selected?: IndexedSymbol & { path: string }; ambiguous: boolean } {
    const definitions = this.definitionRows(symbol).filter((definition) => definition.name.toLowerCase() === symbol.toLowerCase() && (!definedIn || definition.path === definedIn));
    return { definitions, selected: definitions.length === 1 ? definitions[0] : undefined, ambiguous: definitions.length > 1 };
  }

  private relationshipRows(target: IndexedSymbol & { path: string }, callsOnly: boolean): Array<Record<string, unknown>> {
    const available = this.availablePaths();
    const results: Array<Record<string, unknown>> = [];
    const addReference = (file: IndexedFile, reference: IndexedReference): void => {
      if (callsOnly && reference.kind === "reference") return;
      results.push({ path: file.path, line: reference.line, column: reference.column, name: reference.name, relation: callsOnly ? "call" : "reference", ...(reference.kind !== "reference" ? { call_kind: reference.kind } : {}), ...(reference.qualifier ? { qualifier: reference.qualifier } : {}), ...(reference.container ? { container: reference.container } : {}) });
    };
    for (const file of this.data!.files) {
      if (file.path === target.path) {
        for (const reference of file.references.filter((item) => item.name === target.name)) addReference(file, reference);
        continue;
      }
      const imports = file.imports.map((item) => ({ item, resolved: resolveModuleSpecifier(file.path, item.specifier, available) })).filter((entry) => entry.resolved === target.path);
      if (!imports.length) continue;
      const localNames = new Set<string>();
      const namespaces = new Set<string>();
      for (const { item } of imports) {
        for (const binding of item.bindings) {
          if (binding.kind === "namespace") namespaces.add(binding.local);
          else if (binding.imported === target.name || (binding.imported === "default" && target.defaultExport)) {
            localNames.add(binding.local);
            if (!callsOnly) results.push({ path: file.path, line: binding.line, column: binding.column, name: binding.local, relation: "import", imported: binding.imported });
          }
        }
      }
      const member = target.kind === "method" || target.kind === "property";
      for (const reference of file.references) {
        if (localNames.has(reference.name)) addReference(file, reference);
        else if (reference.name === target.name && reference.qualifier && namespaces.has(reference.qualifier)) addReference(file, reference);
        else if (member && reference.name === target.name) addReference(file, reference);
      }
    }
    const seen = new Set<string>();
    return results.filter((item) => {
      const key = `${item.path}:${item.line}:${item.column}:${item.relation}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => String(left.path).localeCompare(String(right.path)) || Number(left.line) - Number(right.line) || Number(left.column) - Number(right.column));
  }

  async findRelationships(input: Record<string, unknown>, callsOnly: boolean): Promise<string> {
    await this.initialize();
    if (typeof input.symbol !== "string" || !input.symbol.trim() || input.symbol.length > 200) throw new Error("symbol must be a non-empty name up to 200 characters");
    const definedIn = workspaceFilter(input.defined_in, "defined_in");
    const offset = integerInput(input.offset, 0, 0, 1_000_000, "offset");
    const limit = integerInput(input.limit, 30, 1, 100, "limit");
    const selection = this.selectedDefinition(input.symbol.trim(), definedIn);
    const tool = callsOnly ? "find_callers" : "find_references";
    if (!selection.selected) return JSON.stringify({ tool, symbol: input.symbol.trim(), defined_in: definedIn || null, ambiguous: selection.ambiguous, definitions: selection.definitions.slice(0, 20), match_count: 0, offset: 0, returned_count: 0, next_offset: null, [callsOnly ? "calls" : "references"]: [] }, null, 2);
    const rows = this.relationshipRows(selection.selected, callsOnly);
    return jsonPage({ tool, symbol: selection.selected.name, defined_in: selection.selected.path, ambiguous: false, definitions: [selection.selected], match_count: rows.length }, rows, offset, limit, callsOnly ? "calls" : "references");
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
    {
      name: "repository_map",
      description: "Read a compact paginated map of workspace modules, major symbols, internal dependencies, and dependent counts. JavaScript and TypeScript modules include AST-derived details.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional workspace-relative file or directory prefix." },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      describe: (input) => `map repository modules${input.path ? ` under ${String(input.path)}` : ""}`,
      async execute(input) { return await index.repositoryMap(input); },
    },
    {
      name: "find_symbol",
      description: "Find JavaScript or TypeScript symbol definitions by exact, prefix, or substring name, with file, line, kind, container, export state, and signature.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: [...SYMBOL_KINDS] },
          path: { type: "string", description: "Optional workspace-relative file or directory prefix." },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      describe: (input) => `find symbol ${String(input.query)}`,
      async execute(input) { return await index.findSymbols(input); },
    },
    {
      name: "find_references",
      description: "Find static JavaScript or TypeScript imports and references for one symbol definition. Use defined_in when same-name definitions are ambiguous.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          defined_in: { type: "string", description: "Optional workspace-relative definition file used to disambiguate." },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["symbol"],
        additionalProperties: false,
      },
      describe: (input) => `find references to ${String(input.symbol)}`,
      async execute(input) { return await index.findRelationships(input, false); },
    },
    {
      name: "find_callers",
      description: "Find direct static JavaScript or TypeScript calls or constructor uses for one symbol definition. Use defined_in when same-name definitions are ambiguous.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          defined_in: { type: "string", description: "Optional workspace-relative definition file used to disambiguate." },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["symbol"],
        additionalProperties: false,
      },
      describe: (input) => `find callers of ${String(input.symbol)}`,
      async execute(input) { return await index.findRelationships(input, true); },
    },
  ];
}
