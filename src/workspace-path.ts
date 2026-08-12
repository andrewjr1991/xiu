import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

function outside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function canonicalExisting(value: string): string {
  const resolved = realpathSync.native(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Resolve a path only when its nearest existing real ancestor stays in the workspace. */
export function resolveWorkspacePath(cwd: string, requested: string): string {
  if (!requested || requested.includes("\0")) throw new Error("Path must be a non-empty workspace-relative path");
  const root = path.resolve(cwd);
  const target = path.resolve(root, requested);
  if (outside(root, target)) throw new Error(`Path escapes workspace: ${requested}`);

  const realRoot = canonicalExisting(root);
  let existing = target;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`Unable to validate workspace path: ${requested}`);
      existing = parent;
    }
  }

  let realExisting: string;
  try { realExisting = canonicalExisting(existing); }
  catch { throw new Error(`Path contains an unresolved symbolic link or reparse point: ${requested}`); }
  if (outside(realRoot, realExisting)) throw new Error(`Path resolves outside workspace: ${requested}`);
  return target;
}

export function validateWorkspaceGlob(pattern: string): string {
  if (!pattern || pattern.includes("\0") || path.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || path.posix.isAbsolute(pattern)) {
    throw new Error("Glob must stay inside workspace");
  }
  if (pattern.split(/[\\/]+/).some((segment) => segment === "..")) throw new Error("Glob must stay inside workspace");
  return pattern;
}
