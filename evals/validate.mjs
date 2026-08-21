import { validateAll } from "./lib/core.mjs";

try {
  const suites = await validateAll();
  for (const suite of suites) console.log(`Validated ${suite.id}: ${suite.tasks} task(s), ${suite.hash.slice(0, 12)}.`);
  console.log("Evaluation validation passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
