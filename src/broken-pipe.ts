import process from "node:process";

/**
 * The reader of stdout or stderr went away: `xiu report | head -1`, `xiu --json <task> | jq -c ... | head -1`, a
 * consumer that exited. Node answers the next write with an `error` event, and with nobody listening the process
 * dies with "Unhandled 'error' event: write EPIPE" and a stack trace, in the middle of whatever it was doing.
 *
 * `installBrokenPipeHandling()` listens on both streams. The first broken pipe calls the handler set with
 * `setBrokenPipeHandler()`: when it returns false (nothing is running) the process exits with its current exit
 * code, like a program killed by SIGPIPE but quietly; when it returns true (a task was asked to stop) the run ends
 * on its own and records its end. Later writes to the broken stream are dropped by the stream itself.
 */

export interface BrokenPipeStreams {
  stdout: NodeJS.EventEmitter;
  stderr: NodeJS.EventEmitter;
  exit: (code: number) => void;
}

let handler: () => boolean = () => false;
let broken = false;

/** `next` runs once, on the first broken pipe; it returns true when it started stopping work that will end the run by itself. */
export function setBrokenPipeHandler(next: (() => boolean) | undefined): void {
  handler = next ?? (() => false);
}

/** True once stdout or stderr has lost its reader. */
export function outputPipeBroken(): boolean {
  return broken;
}

export function installBrokenPipeHandling(streams: BrokenPipeStreams = { stdout: process.stdout, stderr: process.stderr, exit: (code) => process.exit(code) }): void {
  const onError = (error: NodeJS.ErrnoException): void => {
    // Only a lost reader is handled here; any other stream error stays as fatal as it was.
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
    if (broken) return;
    broken = true;
    if (!handler()) streams.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  };
  streams.stdout.on("error", onError);
  streams.stderr.on("error", onError);
}

/** Test seam: forgets a broken pipe seen earlier in the same process. */
export function resetBrokenPipeState(): void {
  broken = false;
  handler = () => false;
}
