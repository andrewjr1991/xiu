// Type declarations for real-resume.mjs, used when TypeScript tests import it.
import type { EvalResult, EvalSuite, EvalSuiteReference, LoadedEvalTask } from "./core.mjs";
import type { RealEvalConfig, RealEvalGlobalBudget } from "./real-policy.mjs";

export interface TrialSlot {
  taskId: string;
  revision: number;
  trial: number;
}

export interface RealResumeBinding {
  resultSha256: string;
  sourceRunId: string;
  recordedTrials: number;
  nextSlot: TrialSlot;
}

export interface RealResumeContext {
  config: RealEvalConfig;
  configHash: string;
  suite: EvalSuite;
  suiteHash: string;
  executionHash: string;
  metadata: { packageName: string; version: string; integrity: string };
  loadedTasks: readonly LoadedEvalTask[];
}

export interface RealResume {
  file: string;
  digest: string;
  result: EvalResult;
  slots: TrialSlot[];
  nextSlot: TrialSlot;
  remainingBudget: RealEvalGlobalBudget;
  requiredBudget: RealEvalGlobalBudget;
  binding: RealResumeBinding;
}

export declare function realConfigHash(config: RealEvalConfig): string;
export declare function realExecutionHash(loadedTasks: ReadonlyArray<Pick<LoadedEvalTask, "directory">>): Promise<string>;
export declare function trialSlots(suite: { tasks: readonly EvalSuiteReference[] }, trialsPerTask: number): TrialSlot[];
export declare function loadRealResume(input: string, context: RealResumeContext): Promise<RealResume>;
