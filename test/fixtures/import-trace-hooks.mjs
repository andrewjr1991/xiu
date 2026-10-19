// Module-resolution hook for the startup test: records every bare package specifier the CLI
// resolves (not relative or node: ones) in the file named by XIU_TEST_IMPORT_TRACE.
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !specifier.startsWith("file:") && process.env.XIU_TEST_IMPORT_TRACE) {
    appendFileSync(process.env.XIU_TEST_IMPORT_TRACE, `${specifier}\n`);
  }
  return next(specifier, context);
}
