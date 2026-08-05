import assert from "node:assert/strict";
import test from "node:test";
import { renderWelcome } from "../src/welcome.js";

test("startup screen includes quick start, session details, and skill count", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 40);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Quick start/);
  assert.match(output, /Session/);
  assert.match(output, /40 installed/);
  assert.match(output, /command palette/);
});

test("wide startup screen places branding and quick start on the same row", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 3);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  assert.match(lines[1] ?? "", /__  __.*Quick start/);
  assert.ok(lines.length < 18, `expected compact output, received ${lines.length} lines`);
});

test("narrow startup screen falls back to stacked layout", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalColumns = process.stdout.columns;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 70 });
  try {
    renderWelcome({ provider: "agnes", model: "agnes-2.5-flash", cwd: "C:\\project", maxTurns: 30, autoApprove: true }, "0.4.0", 0);
  } finally {
    console.log = originalLog;
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
  }
  assert.doesNotMatch(lines[1] ?? "", /Quick start/);
  assert.ok(lines.some((line) => line.includes("Quick start")));
});
