import fs from "node:fs/promises";

/** Why a workspace path cannot be used, named for the explanation catalog (`workspace/<problem>`). */
export type WorkspaceDirectoryProblem = "missing" | "not-directory" | "unreadable";

/**
 * The workspace path (`--cwd`, or the directory Xiu was started in) is not a directory Xiu can use. Every command
 * but `xiu doctor` stops on it before trust, plugins or records are looked at: `xiu --cwd <file> report runs` used
 * to answer "no task run to report yet" and a task said `Error: Workspace does not exist` for a file as well as for
 * a missing directory. `message` keeps the raw English text scripts match on (`Workspace does not exist: <path>`);
 * `code` carries the system error code when there was one.
 */
export class WorkspaceDirectoryError extends Error {
  readonly code?: string;

  constructor(readonly problem: WorkspaceDirectoryProblem, readonly directory: string, options: { code?: unknown; cause?: unknown } = {}) {
    const code = typeof options.code === "string" && options.code ? options.code : undefined;
    super(problem === "missing" ? `Workspace does not exist: ${directory}`
      : problem === "not-directory" ? `Workspace is not a directory: ${directory}`
        : `Workspace could not be read${code ? ` (${code})` : ""}: ${directory}`,
    options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspaceDirectoryError";
    this.code = code;
  }
}

/**
 * Resolves once the path is an existing directory; otherwise throws a `WorkspaceDirectoryError`. A missing path and
 * a path that runs through a file (`ENOTDIR`) both count as missing; a path that exists but is a file, a socket or a
 * device is `not-directory`; any other failure (no permission, an unavailable volume) is `unreadable`.
 */
export async function assertWorkspaceDirectory(directory: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceDirectoryError("missing", directory, { code, cause: error });
    throw new WorkspaceDirectoryError("unreadable", directory, { code, cause: error });
  }
  if (!stat.isDirectory()) throw new WorkspaceDirectoryError("not-directory", directory);
}
