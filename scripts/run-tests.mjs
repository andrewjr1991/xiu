import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testDirectory = path.resolve("test");
const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort((left, right) => left.localeCompare(right, "en"));

if (testFiles.length === 0) {
  console.error("No test files were found in the test directory.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--test", "--import", "tsx", ...testFiles], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  child.once("error", (error) => {
    console.error(`Unable to start the test runner: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      console.error(`Test runner stopped by signal ${signal}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}
