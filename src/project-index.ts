import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AgentTool } from "./types.js";

const INDEX_VERSION = 1;
const MAX_FILES = 8_000;
const MAX_INDEXED_FILE_BYTES = 512 * 1024;
const MAX_TERMS_PER_FILE = 300;
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

function tokenize(value: string): string[] {
  const normalized = value.toLowerCase();
  const words = normalized.match(/[a-z_][a-z0-9_.-]{1,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    result.add(word);
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2));
    }
  }
  return [...result];
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

  constructor(private readonly cwd: string) {}

  async initialize(force = false): Promise<void> {
    const indexFile = path.join(this.cwd, ".xiu", "index.json");
    if (!force && !this.dirty) {
      try {
        const cached = JSON.parse(await fs.readFile(indexFile, "utf8")) as StoredIndex;
        if (cached.version === INDEX_VERSION && Date.now() - Date.parse(cached.generatedAt) < 5 * 60_000) {
          this.data = cached;
          return;
        }
      } catch { /* build a fresh index */ }
    }
    const discovered = await fg("**/*", { cwd: this.cwd, onlyFiles: true, dot: true, unique: true, ignore: IGNORES });
    const paths = discovered.sort().slice(0, MAX_FILES);
    const files: IndexedFile[] = [];
    for (let offset = 0; offset < paths.length; offset += 64) {
      const batch = paths.slice(offset, offset + 64);
      const indexed = await Promise.all(batch.map(async (relative): Promise<IndexedFile | undefined> => {
        const target = path.join(this.cwd, relative);
        try {
          const stat = await fs.stat(target);
          let terms = tokenize(relative);
          const extension = path.extname(relative).toLowerCase();
          if (stat.size <= MAX_INDEXED_FILE_BYTES && (TEXT_EXTENSIONS.has(extension) || !extension)) {
            const content = await fs.readFile(target, "utf8");
            terms = [...new Set([...terms, ...tokenize(content)])].slice(0, MAX_TERMS_PER_FILE);
          }
          return { path: relative.replace(/\\/g, "/"), size: stat.size, modifiedMs: stat.mtimeMs, terms };
        } catch { return undefined; }
      }));
      files.push(...indexed.filter((item): item is IndexedFile => Boolean(item)));
    }
    this.data = {
      version: INDEX_VERSION,
      generatedAt: new Date().toISOString(),
      files,
      profile: await detectProfile(this.cwd, paths),
      truncated: discovered.length > MAX_FILES,
    };
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await fs.writeFile(indexFile, JSON.stringify(this.data), "utf8");
    this.dirty = false;
  }

  invalidate(): void {
    this.data = undefined;
    this.dirty = true;
  }

  profile(): ProjectProfile {
    if (!this.data) throw new Error("Project index is not initialized");
    return this.data.profile;
  }

  status(): { files: number; generatedAt: string; truncated: boolean } {
    if (!this.data) return { files: 0, generatedAt: "not initialized", truncated: false };
    return { files: this.data.files.length, generatedAt: this.data.generatedAt, truncated: this.data.truncated };
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
    if (!this.data) await this.initialize();
    const terms = tokenize(query).filter((term) => term.length >= 2);
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
      async execute() { return JSON.stringify(index.profile(), null, 2); },
    },
  ];
}
