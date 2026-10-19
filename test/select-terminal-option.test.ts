import assert from "node:assert/strict";
import test from "node:test";
import { selectTerminalOption } from "../src/interactive-ui.js";

/** Without a TTY a menu cannot be answered, so by default it must fail closed instead of taking the first entry. */
function withoutTty<T>(run: () => Promise<T>): Promise<T> {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  return run().finally(() => {
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });
}

function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  return run().then((result) => ({ result, stderr })).finally(() => { process.stderr.write = original; });
}

const options = [
  { label: "Approve current manifest", value: true },
  { label: "Cancel", value: false },
];

test("a menu without a TTY is cancelled by default and says why", async () => {
  const { result, stderr } = await withoutTty(() => captureStderr(() => selectTerminalOption("Authorize plugin demo?\nSignature: unsigned", options, "en-US")));
  assert.equal(result, undefined);
  assert.match(stderr, /^.*Authorize plugin demo\? There is no interactive terminal to choose from, so this counts as cancelled/);
  assert.doesNotMatch(stderr, /Signature/);
});

test("a menu without a TTY takes the first option only when the caller opts in", async () => {
  const { result, stderr } = await withoutTty(() => captureStderr(() => selectTerminalOption("Provider type", [{ label: "Agnes", value: "agnes" }, { label: "Custom", value: "custom" }], "zh-CN", { nonInteractive: "first" })));
  assert.equal(result, "agnes");
  assert.equal(stderr, "");
});

test("an empty menu returns nothing without printing", async () => {
  const { result, stderr } = await withoutTty(() => captureStderr(() => selectTerminalOption("Nothing", [], "en-US")));
  assert.equal(result, undefined);
  assert.equal(stderr, "");
});
