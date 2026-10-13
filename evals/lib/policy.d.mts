// Type declarations for policy.mjs, used when TypeScript tests import it.
import type { EvalTaskBudget } from "./core.mjs";

export declare class TaskAssertionError extends Error {
  constructor(message: string);
}

export type EvalFailureType = "safety" | "task_assertion" | "timeout" | "budget" | "provider" | "interrupted" | "harness";

export declare function enforceTrialBudget(
  task: { budget: Pick<EvalTaskBudget, "inputTokens" | "outputTokens"> },
  diagnostics?: { model?: { inputTokens?: number; outputTokens?: number } },
): void;
export declare function classifyFailure(error: unknown, category: string): EvalFailureType;
export declare function shouldStopAfterTrial(result: { passed: boolean; failureType?: string; failure?: string } | null | undefined): boolean;
export declare function forbiddenWriteAttemptCount(events: ReadonlyArray<{ name?: string; reasonCode?: string } | null | undefined> | null | undefined): number;
export declare function scrubSensitiveEnvironment(environment?: Record<string, string | undefined>): number;
