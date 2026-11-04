import type { VerificationSummary } from "../../../../src/verification.js";

/** Historical events may be damaged. Never turn model prose or arbitrary objects into counters. */
export function verificationSummary(value: unknown): VerificationSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  for (const key of ["total", "passed", "failed", "stale", "revision"]) {
    if (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0 || Number(data[key]) > 1_000_000) return undefined;
  }
  const { total, passed, failed, stale, revision } = data as unknown as VerificationSummary;
  if (passed + failed + stale !== total) return undefined;
  const state = !total ? "not_run" : failed ? "failed" : stale ? "stale" : "passed";
  if (data.state !== state) return undefined;
  return { total, passed, failed, stale, revision, state };
}
