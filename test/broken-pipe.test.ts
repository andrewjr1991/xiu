import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installBrokenPipeHandling, outputPipeBroken, resetBrokenPipeState, setBrokenPipeHandler } from "../src/broken-pipe.js";

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
}

function install() {
  resetBrokenPipeState();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  installBrokenPipeHandling({ stdout, stderr, exit: (code) => { exits.push(code); } });
  return { stdout, stderr, exits };
}

test("a broken stdout pipe with nothing running exits quietly with the current exit code", () => {
  const { stdout, exits } = install();
  const previous = process.exitCode;
  process.exitCode = 3;
  try {
    assert.doesNotThrow(() => stdout.emit("error", epipe()));
  } finally {
    process.exitCode = previous;
  }
  assert.deepEqual(exits, [3]);
  assert.equal(outputPipeBroken(), true);
});

test("a broken stderr pipe is handled the same way and defaults to exit code 0", () => {
  const { stderr, exits } = install();
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    stderr.emit("error", epipe());
  } finally {
    process.exitCode = previous;
  }
  assert.deepEqual(exits, [0]);
});

test("when the handler starts stopping work the process is left to end the run itself", () => {
  const { stdout, stderr, exits } = install();
  let calls = 0;
  setBrokenPipeHandler(() => { calls += 1; return true; });
  stdout.emit("error", epipe());
  assert.deepEqual(exits, []);
  assert.equal(calls, 1);
  assert.equal(outputPipeBroken(), true);
  // The destroyed stream reports every later write; those are not new events.
  stdout.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }));
  stderr.emit("error", epipe());
  assert.deepEqual(exits, []);
  assert.equal(calls, 1);
});

test("a handler that finds nothing to stop still exits", () => {
  const { stdout, exits } = install();
  setBrokenPipeHandler(() => false);
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    stdout.emit("error", epipe());
  } finally {
    process.exitCode = previous;
  }
  assert.deepEqual(exits, [0]);
});

test("other stream errors are not swallowed", () => {
  const { stdout, exits } = install();
  const other = Object.assign(new Error("boom"), { code: "EIO" });
  assert.throws(() => stdout.emit("error", other), /boom/);
  assert.deepEqual(exits, []);
  assert.equal(outputPipeBroken(), false);
});

test("resetBrokenPipeState clears the handler and the broken flag", () => {
  const { stdout, exits } = install();
  setBrokenPipeHandler(() => true);
  stdout.emit("error", epipe());
  assert.equal(outputPipeBroken(), true);
  resetBrokenPipeState();
  assert.equal(outputPipeBroken(), false);
  stdout.emit("error", epipe());
  assert.deepEqual(exits, [0]);
});
