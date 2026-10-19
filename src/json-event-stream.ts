import type { AgentFailureReason, AgentRunOutcome } from "./agent.js";
import type { RuntimeEvent } from "./runtime/protocol.js";
import { XIU_RUNTIME_SCHEMA_VERSION } from "./runtime/protocol.js";
import { sanitizeSecrets } from "./secret-redaction.js";
import type { SessionStats } from "./session.js";

/**
 * `xiu --json <task>` writes one JSON object per line to stdout and nothing
 * else: a `session.started` line, every runtime event of the task in order,
 * and a final `result` line. Human-readable output moves to stderr so a
 * script can parse stdout without filtering.
 */

export const JSON_STREAM_SCHEMA_VERSION = XIU_RUNTIME_SCHEMA_VERSION;

/** Exit codes of a one-shot task; `--json` reports the same code it exits with. */
export const ONE_SHOT_EXIT_CODES = {
  completed: 0,
  /** Usage error, provider not configured, untrusted workspace, or a task that failed/was cancelled/paused. */
  failed: 1,
  unverified: 2,
  /** The model asked a question; a non-interactive run cannot answer it. */
  waiting_user: 3,
} as const;

export interface JsonSessionStartedLine {
  schemaVersion: typeof JSON_STREAM_SCHEMA_VERSION;
  type: "session.started";
  timestamp: string;
  payload: { version: string; provider: string; model: string; workspace: string; language: string };
}

export interface JsonResultLine {
  schemaVersion: typeof JSON_STREAM_SCHEMA_VERSION;
  type: "result";
  timestamp: string;
  payload: {
    /** `not_started` means the task never reached the model (usage error, trust, provider). */
    outcome: AgentRunOutcome | "not_started";
    success: boolean;
    exitCode: number;
    error?: string;
    failureReason?: AgentFailureReason;
    completionIssues?: string[];
    pendingQuestion?: string;
    stats?: Pick<SessionStats, "modelCalls" | "toolCalls" | "inputTokens" | "outputTokens" | "estimatedTokens">;
    durationMs?: number;
  };
}

export type JsonStreamLine = JsonSessionStartedLine | RuntimeEvent | JsonResultLine;

export function oneShotExitCode(outcome: AgentRunOutcome | "not_started"): number {
  if (outcome === "completed") return ONE_SHOT_EXIT_CODES.completed;
  if (outcome === "unverified") return ONE_SHOT_EXIT_CODES.unverified;
  if (outcome === "waiting_user") return ONE_SHOT_EXIT_CODES.waiting_user;
  return ONE_SHOT_EXIT_CODES.failed;
}

/** JSON Lines: one object per line; JSON.stringify never emits a raw newline inside a string. */
export function formatJsonLine(line: JsonStreamLine): string {
  return `${JSON.stringify(line)}\n`;
}

export interface JsonEventStream {
  started(payload: JsonSessionStartedLine["payload"]): void;
  event(event: RuntimeEvent): void;
  /** Writes the final line once; later calls are ignored so an error path cannot emit two results. */
  result(payload: Omit<JsonResultLine["payload"], "exitCode" | "success"> & { exitCode?: number }): number;
  readonly finished: boolean;
}

export function createJsonEventStream(write: (text: string) => void, now: () => Date = () => new Date(), sanitize: (value: string) => string = (value) => value): JsonEventStream {
  let finished = false;
  return {
    get finished() { return finished; },
    started(payload) {
      write(formatJsonLine({ schemaVersion: JSON_STREAM_SCHEMA_VERSION, type: "session.started", timestamp: now().toISOString(), payload: sanitizeSecrets(payload) }));
    },
    event(event) {
      if (finished) return;
      write(formatJsonLine(event));
    },
    result(payload) {
      const exitCode = payload.exitCode ?? oneShotExitCode(payload.outcome);
      if (finished) return exitCode;
      finished = true;
      const line: JsonResultLine = {
        schemaVersion: JSON_STREAM_SCHEMA_VERSION,
        type: "result",
        timestamp: now().toISOString(),
        payload: sanitizeSecrets({ ...payload, error: payload.error === undefined ? undefined : sanitize(payload.error), exitCode, success: exitCode === ONE_SHOT_EXIT_CODES.completed }),
      };
      write(formatJsonLine(line));
      return exitCode;
    },
  };
}

/**
 * Routes `console.log`/`console.info` and direct `process.stdout.write` calls to
 * stderr so stdout carries only the JSON stream. Returns the untouched stdout
 * writer for the stream itself, plus a restore function.
 */
export function redirectHumanOutputToStderr(stdout: NodeJS.WriteStream = process.stdout, stderr: NodeJS.WriteStream = process.stderr): { writeStdout: (text: string) => void; restore: () => void } {
  const originalWrite = stdout.write.bind(stdout);
  const originalLog = console.log;
  const originalInfo = console.info;
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof stdout.write;
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  return {
    writeStdout: (text) => { originalWrite(text); },
    restore: () => {
      stdout.write = originalWrite as typeof stdout.write;
      console.log = originalLog;
      console.info = originalInfo;
    },
  };
}
