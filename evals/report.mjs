import path from "node:path";
import process from "node:process";
import { readJson, redact, summarize, validateResult, writeJson } from "./lib/core.mjs";

const inputIndex = process.argv.indexOf("--input");
if (inputIndex < 0 || !process.argv[inputIndex + 1]) {
  console.error("Usage: npm run eval:report -- --input <run.json> [--output <report.json>]");
  process.exitCode = 1;
} else {
  try {
    const input = path.resolve(process.argv[inputIndex + 1]);
    const run = validateResult(await readJson(input));
    const report = redact({ protocolVersion: 1, kind: "evaluation-report", sourceRunId: run.runId, mode: run.mode, suite: run.suite, suiteHash: run.suiteHash, xiu: run.xiu, environment: run.environment, startedAt: run.startedAt, finishedAt: run.finishedAt, trials: run.trials, summary: summarize(run.trials) });
    const outputIndex = process.argv.indexOf("--output");
    const output = outputIndex >= 0 && process.argv[outputIndex + 1] ? path.resolve(process.argv[outputIndex + 1]) : input.replace(/\.json$/i, ".report.json");
    await writeJson(output, report);
    console.log(`Report: ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
