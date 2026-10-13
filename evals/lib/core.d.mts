// Type declarations for core.mjs, used when TypeScript tests import it.
// Keep in sync with the exports the tests use.

export declare const evalRoot: string;
export declare const resultsRoot: string;

export interface EvalTaskBudget {
  timeoutMs: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface EvalTask {
  protocolVersion: 1;
  id: string;
  revision: number;
  category: string;
  prompt: string;
  engine: string;
  fixtureHash: string;
  allowedChanges: string[];
  allowedRisks: string[];
  forbiddenSideEffects: string[];
  budget: EvalTaskBudget;
  simulation: { turns: unknown[] };
}

export interface LoadedEvalTask {
  task: EvalTask;
  directory: string;
  actualHash: string;
}

export interface EvalSuiteReference {
  id: string;
  revision: number;
}

export interface EvalSuite {
  protocolVersion: 1;
  id: string;
  tasks: EvalSuiteReference[];
}

export interface LoadedEvalSuite {
  suite: EvalSuite;
  hash: string;
}

export interface EvalToolEvent {
  name: string;
  status: "succeeded" | "failed";
  reasonCode?: string;
}

export interface EvalTrialResult {
  taskId: string;
  revision: number;
  trial: number;
  category?: string;
  passed: boolean;
  verified: boolean;
  failureType?: string;
  failure?: string;
  metrics: Record<string, number>;
  toolEvents?: EvalToolEvent[];
  changedFiles?: string[];
  unrelatedFiles?: string[];
  approvals?: Array<{ risk: string; approved: boolean; description: string }>;
  startedAt?: string;
  finishedAt?: string;
}

export interface EvalSummary {
  trials: number;
  eligibleTrials: number;
  passed: number;
  verified: number;
  safetyTrials: number;
  safetyPassed: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  approvals: number;
  durationMs: number;
  unrelatedFiles: number;
  failures: Record<string, number>;
}

export interface EvalResult {
  protocolVersion: 1;
  runId: string;
  mode: "simulated" | "real";
  state: "running" | "completed" | "stopped" | "interrupted";
  suite: string;
  suiteHash: string;
  executionHash?: string;
  configHash?: string;
  startedAt: string;
  finishedAt: string;
  xiu: { version: string; package?: string; integrity?: string };
  environment: { node: string; provider?: string; model?: string };
  trials: EvalTrialResult[];
  summary: EvalSummary;
  ledger?: Record<string, number>;
  globalBudget?: Record<string, number>;
  lineage?: Array<{ runId: string; resultSha256: string; state: "stopped" | "interrupted"; finishedAt: string }>;
}

export declare function removeTemporaryDirectory(root: string, prefix: string): Promise<void>;
export declare function loadTask(id: string, expectedRevision?: number): Promise<LoadedEvalTask>;
export declare function loadSuite(name: string): Promise<LoadedEvalSuite>;
export declare function validateAll(): Promise<Array<{ id: string; tasks: number; hash: string }>>;
export declare function safeWorkspacePath(workspace: string, relative: string): string;
/** Returns a copy with credential-like fields and bearer values replaced; the shape is otherwise preserved. */
export declare function redact<T>(value: T, key?: string): T;
export declare function summarize(trials: ReadonlyArray<Pick<EvalTrialResult, "passed" | "verified" | "category" | "failureType"> & { metrics?: Record<string, number> }>): EvalSummary;
/** Validates the result's structure at runtime and returns the same object. */
export declare function validateResult<T>(result: T): T;
