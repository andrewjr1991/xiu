import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { askQuestion, askYesNo, InputEndedError } from "../src/terminal-prompts.js";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += String(chunk); });
  return { input, output, written: () => written };
}

test("askQuestion returns the typed line and shows the prompt", async () => {
  const io = streams();
  const pending = askQuestion("Select [1]: ", io);
  io.input.write("2\n");
  assert.equal(await pending, "2");
  assert.match(io.written(), /Select \[1\]: /);
});

test("askQuestion rejects with InputEndedError when the input ends before an answer, instead of staying pending", async () => {
  const io = streams();
  const pending = askQuestion("Select [1]: ", io);
  io.input.end();
  await assert.rejects(pending, (error: unknown) => error instanceof InputEndedError && error.code === "input/ended");
});

test("askQuestion still answers a line that arrives together with the end of the input", async () => {
  const io = streams();
  const pending = askQuestion("Select [1]: ", io);
  io.input.end("yes\n");
  assert.equal(await pending, "yes");
});

test("askYesNo accepts only y/yes and treats an ended input as no", async () => {
  for (const [answer, expected] of [["y\n", true], ["YES\n", true], ["\n", false], ["no\n", false], ["1\n", false]] as const) {
    const io = streams();
    const pending = askYesNo("Restore? [y/N] ", io);
    io.input.write(answer);
    assert.equal(await pending, expected, `answer ${JSON.stringify(answer)}`);
  }
  const ended = streams();
  const pending = askYesNo("Restore? [y/N] ", ended);
  ended.input.end();
  assert.equal(await pending, false);
});
