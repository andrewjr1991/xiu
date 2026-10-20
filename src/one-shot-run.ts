import chalk from "chalk";
import type { Agent } from "./agent.js";
import type { WorkspaceChangeNotice } from "./change-summary.js";
import { localize, type UiLanguage } from "./i18n.js";
import { type JsonEventStream, oneShotExitCode } from "./json-event-stream.js";

export interface OneShotRunContext {
  task: string;
  language: UiLanguage;
  agent: Pick<Agent, "status" | "recordReplayTurn">;
  /** The `--json` stream when the run was started with `--json`; its `result` line carries the exit code. */
  jsonStream?: Pick<JsonEventStream, "started" | "result">;
  /** The `session.started` payload written first on a `--json` run. */
  started: Parameters<JsonEventStream["started"]>[0];
  /** Runs the task; `onStarted` is called once the run has a record and an outcome of its own. */
  run: (onStarted: () => void) => Promise<unknown>;
  /** The workspace changes the run reported, for the session history. */
  changes: () => WorkspaceChangeNotice[];
  /** The question the model is waiting on, if the run ended waiting for the user. */
  pendingQuestion: () => string | undefined;
  redact: (value: string) => string;
  emitLine: (value: string) => void;
  io?: OneShotRunIo;
}

export interface OneShotRunIo {
  error: (line: string) => void;
  now: () => number;
}

const realIo: OneShotRunIo = {
  error: (line) => console.error(line),
  now: () => Date.now(),
};

/**
 * Runs the one-shot task (`xiu <task>`, with or without `--json`) and returns the process exit code: 0 completed,
 * 2 unverified, 3 waiting for an answer, 1 failed, cancelled or paused. With `--json` the `result` line is written
 * here and decides the code. A failure before the task started is rethrown without `--json` so that `main()` explains
 * it; once the task started, its own outcome decides the code and the turn is saved to the session history, whose
 * failure is reported in one line and never changes the result.
 */
export async function runOneShotTask(ctx: OneShotRunContext): Promise<number> {
  const io = ctx.io ?? realIo;
  const { agent, jsonStream, language, task: initialTask } = ctx;
  let taskStarted = false;
  const taskStartedAt = io.now();
  jsonStream?.started(ctx.started);
  try {
    await ctx.run(() => { taskStarted = true; });
  } catch (error) {
    const message = ctx.redact(error instanceof Error ? error.message : String(error));
    if (!jsonStream) {
      // Before the task started this is a startup problem and main() explains it. Once it started (and was then
      // cancelled, interrupted or stopped by a signal), the run already has a record and an outcome: say that the task
      // stopped and exit with the one-shot code for the outcome, the same way --json does, instead of "could not start".
      if (!taskStarted) throw error;
      io.error(chalk.red(`${localize(language, "任务已停止", "Task stopped")}: ${message}\n`));
      return oneShotExitCode(agent.status().outcome);
    }
    return jsonStream.result({ outcome: taskStarted ? agent.status().outcome : "not_started", error: message, durationMs: io.now() - taskStartedAt });
  } finally {
    if (taskStarted) await agent.recordReplayTurn({
      task: initialTask,
      inputKind: "task",
      supplements: [],
      changes: ctx.changes(),
      receipts: [],
      completion: {
        message: agent.status().outcome,
        success: agent.status().outcome === "completed",
      },
      diagnostics: agent.status().diagnostics,
      exact: true,
    }).catch((error: unknown) => {
      // Session history is a convenience, never a gate on the task result, but a
      // one-shot run must still say when this turn will be missing from /resume.
      ctx.emitLine(chalk.dim(ctx.redact(localize(language,
        `未能保存本轮会话记录：${error instanceof Error ? error.message : String(error)}。任务结果不受影响，但 /resume 不会看到这一轮。`,
        `Could not save this turn to the session history: ${error instanceof Error ? error.message : String(error)}. The task result is unaffected, but /resume will not show this turn.`))));
    });
  }
  if (jsonStream) {
    const finished = agent.status();
    const { modelCalls, toolCalls, inputTokens, outputTokens, estimatedTokens } = finished.stats;
    return jsonStream.result({
      outcome: finished.outcome,
      failureReason: finished.failureReason,
      completionIssues: finished.completionIssues?.length ? finished.completionIssues : undefined,
      pendingQuestion: ctx.pendingQuestion(),
      stats: { modelCalls, toolCalls, inputTokens, outputTokens, estimatedTokens },
      durationMs: io.now() - taskStartedAt,
    });
  }
  // Same contract as --json: 0 completed, 2 unverified, 3 waiting for an answer, 1 failed, cancelled or paused.
  return oneShotExitCode(agent.status().outcome);
}
