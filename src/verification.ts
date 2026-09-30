import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { captureTaskBaseline } from "./task-changes.js";
import { toolCallSignature } from "./loop-guard.js";
import { resolveWorkspacePath } from "./workspace-path.js";

export function isVerificationCommand(command: string): boolean {
  // Do not infer evidence from text printed by shell snippets or informational modes.
  if (/[\r\n;&|<>`]/.test(command) || /\$\(/.test(command)) return false;
  const args = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g)?.map((s) => s.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  const program = path.win32.basename(args.shift() ?? "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  const flags = args.map((argument) => argument.split("=", 1)[0]!);
  if (flags.some(flag => /^(?:--(?:version|help|dry-run|list(?:Tests|-tests)?|collect-only|showConfig|print-config|env-info|inspect-config|fixtures(?:-per-test)?|markers|trace-config|watch(?:All)?)|-h)$/i.test(flag))) return false;
  // Short flags are program-specific: pytest/go/cargo use -v for verbosity and
  // pytest -c selects its config. These are real checks, not version/inline code.
  if (["tsc", "node", "nodejs", "npm", "pnpm", "yarn", "bun", "npx", "eslint", "jest", "vitest", "deno"].includes(program)
    && flags.includes("-v")) return false;
  if (/^python\d*(?:\.\d+)?$/.test(program) && flags.includes("-V")) return false;
  if (["node", "nodejs", "tsx"].includes(program) && flags.some(flag => ["-e", "--eval", "-p", "--print"].includes(flag))) return false;
  if (program === "tsc" && flags.some(flag => /^-+(?:all|listFilesOnly|showConfig|init|help|version|watch|w)$/i.test(flag))) return false;
  if (program === "eslint" && flags.includes("--init")) return false;
  if (program === "vitest" && ["list", "init", "watch"].includes(args[0] ?? "")) return false;
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    if (args[0] === "run" || args[0] === "run-script") args.shift();
    return /^(?:test|tests|lint|check|typecheck|build|verify|validate)(?::[\w-]+)?$/.test(args[0] ?? "");
  }
  if (program === "npx") {
    while (["--yes", "-y", "--no-install", "--offline"].includes(args[0] ?? "")) args.shift();
    return isVerificationCommand(args.join(" "));
  }
  if (["tsc", "eslint", "pytest", "jest", "vitest"].includes(program)) return true;
  if (["cargo", "go", "deno"].includes(program)) return ["test", "check", "build", "vet", "lint"].includes(args[0] ?? "");
  if (["node", "nodejs"].includes(program) && args.includes("--test")) return true;
  if (/^python\d*(?:\.\d+)?$/.test(program)) {
    if (args[0] === "-c") return false;
    if (args[0] === "-m") {
      if (args[1] === "pytest") return isVerificationCommand(args.slice(1).join(" "));
      return args[1] === "unittest";
    }
  }
  const target = /^(?:node|nodejs|tsx|python\d*|pwsh|powershell|sh|bash)$/.test(program) ? args[0] : program;
  return /(?:^|[\\/])(?:[\w.-]*[-_])?(?:test|tests|check|verify|validate)(?:[-_][\w.-]+)?\.(?:py|mjs|cjs|js|ts|ps1|sh|bat|cmd)$/i.test(target ?? "");
}

/** A retry with a longer deadline is still the same required check. */
export function verificationCheckKey(name: string, input: Record<string, unknown>): string {
  const executionControls = new Set(["timeout_ms", "output_encoding", "max_output_chars", "max_output_bytes"]);
  return toolCallSignature(name, Object.fromEntries(Object.entries(input).filter(([key]) => !executionControls.has(key))));
}

function stringExpectations(input: Record<string, unknown>, key: "required_substrings" | "forbidden_substrings"): Set<string> {
  return new Set(Array.isArray(input[key]) ? input[key].filter((value): value is string => typeof value === "string") : []);
}

function normalizedVerificationPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Tool inputs may come from a different host style than the current runner.
  // Normalize separators before applying POSIX dot-segment rules so the same
  // workspace-relative artifact has one ledger identity on every platform.
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, "/"));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** A successful verify_output may replace an older check only when it proves at
 * least the same facts about the same artifact. This prevents a weaker or
 * unrelated check from erasing required verification evidence. */
export function verifyOutputSupersedes(current: Record<string, unknown>, previous: Record<string, unknown>): boolean {
  const currentPath = normalizedVerificationPath(current.path);
  if (!currentPath || currentPath !== normalizedVerificationPath(previous.path)) return false;
  const currentRequired = stringExpectations(current, "required_substrings");
  const currentForbidden = stringExpectations(current, "forbidden_substrings");
  // Requiring a longer string also proves every substring within it exists.
  if ([...stringExpectations(previous, "required_substrings")]
    .some((previousValue) => ![...currentRequired].some((currentValue) => currentValue.includes(previousValue)))) return false;
  // For forbidden strings the implication is reversed: proving a shorter token
  // absent also proves that a longer string containing it is absent.
  if ([...stringExpectations(previous, "forbidden_substrings")]
    .some((previousValue) => ![...currentForbidden].some((currentValue) => previousValue.includes(currentValue)))) return false;
  const currentMinimum = typeof current.min_bytes === "number" ? current.min_bytes : 0;
  const previousMinimum = typeof previous.min_bytes === "number" ? previous.min_bytes : 0;
  if (currentMinimum < previousMinimum) return false;
  const currentMaximum = typeof current.max_bytes === "number" ? current.max_bytes : Number.POSITIVE_INFINITY;
  const previousMaximum = typeof previous.max_bytes === "number" ? previous.max_bytes : Number.POSITIVE_INFINITY;
  return currentMaximum <= previousMaximum;
}

export class VerificationLedger {
  private checks = new Map<string, { passed: boolean; name?: string; input?: Record<string, unknown> }>();
  private revision = 0;
  invalidate(): void {
    this.revision++;
    for (const [key, value] of this.checks) this.checks.set(key, { ...value, passed: false });
  }
  record(check: string, passed: boolean): void { this.checks.set(check, { passed }); }
  recordTool(name: string, input: Record<string, unknown>, passed: boolean): void {
    const check = verificationCheckKey(name, input);
    if (passed && name === "verify_output") {
      for (const [key, previous] of this.checks) {
        if (previous.name === "verify_output" && previous.input && verifyOutputSupersedes(input, previous.input)) this.checks.delete(key);
      }
    }
    this.checks.set(check, { passed, name, input: structuredClone(input) });
  }
  get passed(): boolean { return this.checks.size > 0 && [...this.checks.values()].every((value) => value.passed); }
  get failed(): boolean { return [...this.checks.values()].some((value) => !value.passed); }
  snapshot(): { revision: number; checks: Array<{ check: string; passed: boolean }> } {
    return { revision: this.revision, checks: [...this.checks].map(([check, value]) => ({ check, passed: value.passed })) };
  }
}

const MAX_EXPLICIT_PATHS = 64;
const MAX_EXPLICIT_BYTES = 256 * 1024;

async function explicitFileStamp(root: string, requested: string): Promise<unknown[]> {
  // Unlike the general coding diff, an explicitly verified artifact may be Git
  // ignored. Read only its digest; never retain text or bypass real-path checks.
  const target = resolveWorkspacePath(root, requested);
  const relative = path.relative(root, target).replace(/\\/g, "/");
  if (!relative) throw new Error("Explicit verification target must be a file.");
  try {
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep)) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Explicit verification target cannot contain links.");
    }
    const before = await fs.lstat(target);
    if (!before.isFile()) throw new Error("Explicit verification target is not a regular file.");
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      resolveWorkspacePath(root, requested);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("Explicit verification target changed while opening.");
      const data = Buffer.alloc(Math.min(before.size, MAX_EXPLICIT_BYTES));
      let position = 0;
      while (position < data.length) {
        const { bytesRead } = await handle.read(data, position, data.length - position, position);
        if (!bytesRead) break;
        position += bytesRead;
      }
      const after = await handle.stat();
      if (position !== data.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new Error("Explicit verification target changed while reading.");
      }
      const digest = createHash("sha256").update(data).digest("hex");
      const partial = before.size > MAX_EXPLICIT_BYTES;
      return [relative, "present", before.size, digest, before.mode, partial ? "bounded-prefix-and-metadata" : "full-content",
        ...(partial ? [before.mtimeMs, before.ctimeMs] : [])];
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [relative, "missing"];
    throw error;
  }
}

/** Bounded freshness evidence, not an exhaustive repository proof. Explicit
 * artifacts include ignored files; large artifacts use a 256 KiB prefix plus
 * size/mtime/ctime. Unsafe/unreadable explicit paths fail closed. */
export async function captureVerificationStamp(cwd: string, explicitPaths: readonly string[] = []): Promise<string> {
  const snapshot = await captureTaskBaseline(cwd);
  const files = [...snapshot.files].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) =>
    [name, file.state, file.digest, file.bytes, file.digest ? undefined : file.modifiedAt, file.mode, file.omitted]);
  const paths = [...new Set(explicitPaths)].sort();
  if (paths.length > MAX_EXPLICIT_PATHS) throw new Error("Explicit verification target limit exceeded.");
  const explicit = [];
  for (const target of paths) explicit.push(await explicitFileStamp(snapshot.root, target));
  return createHash("sha256").update(JSON.stringify([snapshot.head, snapshot.complete, files, explicit])).digest("hex");
}
