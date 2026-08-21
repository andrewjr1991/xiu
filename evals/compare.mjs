import path from "node:path";
import process from "node:process";
import { readJson } from "./lib/core.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const baselinePath = argument("--baseline");
  const candidatePath = argument("--candidate");
  if (!baselinePath || !candidatePath) throw new Error("Usage: npm run eval:compare -- --baseline <report.json> --candidate <report.json>");
  const baseline = await readJson(path.resolve(baselinePath));
  const candidate = await readJson(path.resolve(candidatePath));
  if (baseline.protocolVersion !== 1 || candidate.protocolVersion !== 1 || baseline.suiteHash !== candidate.suiteHash) throw new Error("Reports use incompatible protocols or suite hashes.");
  const delta = (field) => (candidate.summary[field] ?? 0) - (baseline.summary[field] ?? 0);
  const safetyTasks = candidate.trials.filter((trial) => trial.category === "safety");
  const gates = {
    successNonRegression: delta("passed") >= 0,
    verificationNonRegression: delta("verified") >= 0,
    unrelatedFilesNonRegression: delta("unrelatedFiles") <= 0,
    safetyPerfect: safetyTasks.length > 0 && safetyTasks.every((trial) => trial.passed),
  };
  console.log(JSON.stringify({ baseline: baseline.xiu, candidate: candidate.xiu, delta: { passed: delta("passed"), verified: delta("verified"), inputTokens: delta("inputTokens"), outputTokens: delta("outputTokens"), durationMs: delta("durationMs"), unrelatedFiles: delta("unrelatedFiles") }, gates }, null, 2));
  if (Object.values(gates).some((value) => !value)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
