import type { ChildProcessWithoutNullStreams } from "node:child_process";

type Exit = { code: number | null; error?: Error };

/** Own a disposable test child immediately after spawn, before writing or waiting. */
export class FixtureProcess {
  private readonly exit: Promise<Exit>;
  private readonly closed: Promise<Exit>;
  private terminal = false;
  private failure?: Error;
  private stopping?: Promise<void>;

  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly deadlines = { stop: 2_000, force: 5_000 }) {
    this.exit = new Promise((resolve) => {
      child.once("exit", (code) => { this.terminal = true; resolve({ code }); });
      child.on("error", (error) => {
        // A failed signal can emit error without terminating an existing child.
        if (child.pid === undefined) { this.failure = error; this.terminal = true; resolve({ code: null, error }); }
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        this.terminal = true;
        resolve({ code: child.exitCode });
      }
    });
    this.closed = new Promise((resolve) => {
      child.once("close", (code) => resolve({ code, error: this.failure }));
    });
    // A child can exit between a prompt assertion and its next input write.
    child.stdin.on("error", () => undefined);
  }

  get exited(): boolean { return this.terminal; }
  get spawnError(): Error | undefined { return this.failure; }

  private async observeExit(timeout: number, drainOutput = false): Promise<Exit | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([drainOutput ? this.closed : this.exit, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeout); })]);
    } finally { clearTimeout(timer); }
  }

  async waitForExit(timeout: number): Promise<number | null> {
    // close follows exit and delivery of the child's remaining stdout/stderr.
    const result = await this.observeExit(timeout, true);
    if (!result) throw new Error(`Fixture child did not exit within ${timeout}ms (pid ${this.child.pid ?? "unassigned"})`);
    if (result.error) throw result.error;
    return result.code;
  }

  stop(): Promise<void> {
    return this.stopping ??= this.stopOwnedChild();
  }

  private async stopOwnedChild(): Promise<void> {
    const deadline = Date.now() + this.deadlines.stop + this.deadlines.force;
    const remaining = () => Math.max(0, deadline - Date.now());
    try {
      if (!this.terminal) {
        this.child.stdin.end();
        try { this.child.kill("SIGTERM"); } catch { /* Confirm exit, then escalate below. */ }
        if (!await this.observeExit(this.deadlines.stop)) {
          try { this.child.kill("SIGKILL"); } catch { /* The confirmation deadline still applies. */ }
          if (!await this.observeExit(remaining())) {
            throw new Error(`Fixture child termination was not confirmed after SIGKILL (pid ${this.child.pid ?? "unassigned"})`);
          }
        }
      }
      if (!await this.observeExit(remaining(), true)) {
        throw new Error(`Fixture child exited but output closure was not confirmed (pid ${this.child.pid ?? "unassigned"})`);
      }
    } finally {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      // A failed termination remains a test failure, but cannot pin the worker.
      if (!this.terminal) this.child.unref();
    }
  }
}

export async function stopFixtureProcesses(processes: FixtureProcess[]): Promise<void> {
  const results = await Promise.allSettled(processes.map((process) => process.stop()));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Fixture child cleanup failed");
}

export async function cleanupFixtureProcesses(processes: FixtureProcess[], remove: () => Promise<void>): Promise<void> {
  await stopFixtureProcesses(processes);
  await remove();
}
