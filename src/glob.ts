import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob, isDynamicPattern, type GlobOptions } from "tinyglobby";

const MAX_LENGTH = 8192;
const MAX_DEPTH = 16;
const MAX_PATTERNS = 256;

function checkComplexity(pattern: string): void {
  if (pattern.length > MAX_LENGTH) throw new Error("Glob pattern exceeds complexity limit");
  const depths = [0, 0, 0];
  let openings = 0;
  // Count delimiters conservatively, including escaped/literal ones, before any parser runs.
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    const opening = "{([".indexOf(character);
    const closing = "})]".indexOf(character);
    if (opening !== -1) {
      if (++depths[opening]! > MAX_DEPTH || ++openings > 256) throw new Error("Glob pattern exceeds nesting limit");
    } else if (closing !== -1 && pattern[index - 1] !== "\\" && (closing === 2 || depths[2] === 0)) {
      depths[closing] = Math.max(0, depths[closing]! - 1);
    }
  }
}

function prepare(pattern: string): string {
  checkComplexity(pattern);
  // Picomatch's range character classes differ from fast-glob for multi-digit,
  // padded and stepped ranges. Expand those bounded ranges into alternatives.
  const expanded = pattern.replace(/(?<!\\)\{(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?\}/g, (_match, first: string, last: string, stepText?: string) => {
    const numeric = /^-?\d+$/.test(first) && /^-?\d+$/.test(last);
    if (!numeric && (!/^[a-zA-Z]$/.test(first) || !/^[a-zA-Z]$/.test(last))) {
      throw new Error("Invalid glob range");
    }
    const start = numeric ? Number(first) : first.charCodeAt(0);
    const end = numeric ? Number(last) : last.charCodeAt(0);
    const step = Math.abs(Number(stepText ?? 1));
    if (![start, end, step].every(Number.isSafeInteger) || step === 0) throw new Error("Invalid glob range");
    const count = Math.floor(Math.abs(end - start) / step) + 1;
    if (count > MAX_PATTERNS) throw new Error("Glob range exceeds expansion limit");
    const width = /^-?0\d/.test(first) || /^-?0\d/.test(last) ? Math.max(first.replace(/^-/, "").length, last.replace(/^-/, "").length) : 0;
    const alternatives = Array.from({ length: count }, (_, index) => {
      const value = start + index * step * (start <= end ? 1 : -1);
      return numeric ? `${value < 0 ? "-" : ""}${String(Math.abs(value)).padStart(width, "0")}` : String.fromCharCode(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    });
    return alternatives.length === 1 ? alternatives[0]! : `{${alternatives.join(",")}}`;
  });
  checkComplexity(expanded);
  return expanded;
}

async function hasLinkedPrefix(pattern: string, cwd: string): Promise<boolean> {
  // A crawler can skip links encountered during traversal but still follow a
  // link selected as its static starting directory. Check that prefix first.
  if (pattern.startsWith("!") && !pattern.startsWith("!(")) return false;
  const root = path.isAbsolute(pattern) ? path.parse(pattern).root : "";
  let current = root || cwd;
  for (const component of pattern.slice(root.length).split("/")) {
    if (!component) continue;
    if (isDynamicPattern(component)) break;
    current = path.resolve(current, component.replace(/\\([()[\]{}!*+?@|])/g, "$1"));
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) break;
      throw error;
    }
  }
  return false;
}

/** Shared parser boundary; Full Access relaxes paths, never resource limits. */
export default async function safeGlob(patterns: string | string[], options: GlobOptions & { unique?: boolean } = {}): Promise<string[]> {
  const inputs = typeof patterns === "string" ? [patterns] : patterns;
  const ignores = typeof options.ignore === "string" ? [options.ignore] : options.ignore ?? [];
  if (inputs.length + ignores.length > MAX_PATTERNS) throw new Error("Too many glob patterns");
  const { unique: _unique, ...rest } = options;
  let prepared = inputs.map(prepare);
  const ignored = ignores.map(prepare);
  if (options.followSymbolicLinks === false) {
    const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : path.resolve(options.cwd ?? process.cwd());
    const linked = await Promise.all(prepared.map((pattern) => hasLinkedPrefix(pattern, cwd)));
    prepared = prepared.filter((_pattern, index) => !linked[index]);
  }
  const files = await glob(prepared, { ...rest, ignore: ignored, expandDirectories: false });
  return [...new Set(files)];
}
