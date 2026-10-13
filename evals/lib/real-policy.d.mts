// Type declarations for real-policy.mjs, used when TypeScript tests import it.
import type { EvalTaskBudget } from "./core.mjs";
import type { RealResumeBinding } from "./real-resume.mjs";

export interface RealEvalGlobalBudget {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface RealEvalConfig {
  protocolVersion: 1;
  id: string;
  target: { package: string; version: string };
  suite: string;
  trials: number;
  provider: { id: string; model: string; baseURL: string; apiKeyEnv: string };
  billing: {
    mode: string;
    currency: string;
    authorizationLimitUsd: number;
    estimatedInputUsdPerMillionTokens: number;
    estimatedOutputUsdPerMillionTokens: number;
    attestedByUserOn: string;
    reference: string;
  };
  globalBudget: RealEvalGlobalBudget;
}

export interface RealEvalLedgerTotals extends RealEvalGlobalBudget {
  estimatedCostUsd: number;
}

export interface RealEvalLedgerSnapshot extends RealEvalLedgerTotals {
  authorizationLimitUsd: number;
}

/** Validates an approved real-evaluation configuration and returns the same object. */
export declare function validateRealConfig(config: unknown): RealEvalConfig;
export declare function realConfirmationToken(
  config: RealEvalConfig,
  suiteHash: string,
  artifactIntegrity: string,
  executionHash: string,
  resumeBinding?: RealResumeBinding | null,
): string;
export declare function validateSuiteBudget(config: RealEvalConfig, tasks: ReadonlyArray<{ budget: EvalTaskBudget }>): RealEvalGlobalBudget;

export declare class RealEvaluationLedger {
  constructor(config: RealEvalConfig, now?: () => number, initial?: Partial<RealEvalLedgerTotals>);
  assertCanStartModelCall(): void;
  recordModelTurn(turn: { usage?: { inputTokens?: number; outputTokens?: number }; raw?: unknown }): void;
  recordTools(count: number): void;
  estimatedCostUsd(): number;
  assertWithinBudget(): void;
  snapshot(): RealEvalLedgerSnapshot;
}
