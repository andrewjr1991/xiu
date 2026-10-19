/**
 * A command-line option, script-command argument or environment variable Xiu cannot accept (`--max-turns 0`,
 * `--stall-timeout-seconds -1`, `--json` with no task). The message is the whole explanation and is shown as one
 * line; the explanation catalog never classifies it by its words, so an option named "timeout" is not reported as a
 * network timeout with "check network and proxy settings" as the next step.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
