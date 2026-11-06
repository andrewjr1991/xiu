import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";

function unsafe(code = "SESSION_STORAGE_UNSAFE"): Error {
  return Object.assign(new Error("Session storage is unavailable or unsafe; no log data was written."), { code });
}

function parents(file: string): string[] {
  const directory = path.dirname(path.resolve(file));
  // Flat legacy storage belongs directly to the selected workspace root,
  // whose user-chosen alias may itself be named .xiu or .forge.
  if (path.basename(directory) === ".forge_sessions") return [directory];
  const parent = path.dirname(directory);
  return [".xiu", ".forge"].includes(path.basename(parent)) ? [parent, directory] : [directory];
}

/** Workspace root aliases are allowed; application-owned storage directories are not links. */
export async function assertSessionStorageParents(file: string, allowMissing = false): Promise<void> {
  for (const directory of parents(file)) {
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw unsafe("ELOOP");
    if (!stat.isDirectory()) throw unsafe("ENOTDIR");
  }
}

export function sameSessionFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

function assertRegular(stat: Stats): void {
  if (stat.isSymbolicLink()) throw unsafe("ELOOP");
  if (!stat.isFile()) throw unsafe(stat.isDirectory() ? "EISDIR" : "EINVAL");
}

export async function validateSessionDestination(cwd: string, file: string, allowMissingParents = false): Promise<Stats | undefined> {
  const relative = path.relative(path.resolve(cwd), path.resolve(file));
  const parts = relative.split(path.sep);
  const valid = parts.length === 3 && ((parts[0] === ".xiu" && /^[A-Za-z0-9_-]+$/.test(parts[1]!))
    || (parts[0] === ".forge" && parts[1] === "sessions"))
    || parts.length === 2 && parts[0] === ".forge_sessions";
  if (!valid || !parts.at(-1)?.endsWith(".jsonl")) throw unsafe();
  await assertSessionStorageParents(file, allowMissingParents);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat) assertRegular(stat);
  return stat;
}

export async function prepareSessionStorage(cwd: string, file: string): Promise<void> {
  await validateSessionDestination(cwd, file, true);
  for (const directory of parents(file)) {
    // Never recursively traverse an existing application-owned directory link.
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertSessionStorageParents(file, true);
  }
  await validateSessionDestination(cwd, file);
}

export async function appendSessionLog(cwd: string, file: string, serialized: string): Promise<void> {
  const before = await validateSessionDestination(cwd, file);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    const opened = await handle.stat();
    assertRegular(opened);
    const current = await fs.lstat(file);
    assertRegular(current);
    if (!sameSessionFile(opened, current) || before && !sameSessionFile(before, opened)) throw unsafe();
    await assertSessionStorageParents(file);
    // Change only the verified open file, never a pathname that may have been replaced.
    if (process.platform === "win32") await handle.chmod(0o600).catch(() => undefined);
    else if ((opened.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    await handle.appendFile(serialized, "utf8");
  } finally { await handle.close(); }
}
