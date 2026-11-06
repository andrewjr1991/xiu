import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { askSecret, InputEndedError } from "../src/terminal-prompts.js";

function fixture(t: test.TestContext, raw = false) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (enabled: boolean) => void };
  input.isTTY = true;
  input.isRaw = raw;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  input.pause();
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  output.isTTY = true;
  let written = "";
  output.on("data", (chunk) => { written += String(chunk); });
  t.after(() => { input.destroy(); output.destroy(); });
  return { input, output, streams: { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream }, written: () => written };
}
async function outcome(pending: Promise<string>) {
  let state: { kind: string; value?: string; error?: unknown } = { kind: "pending" };
  void pending.then((value) => { state = { kind: "answer", value }; }, (error: unknown) => { state = { kind: "error", error }; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return state;
}
for (const ending of ["end", "close", "ctrl-d", "already-closed"] as const) {
  test(`masked secret input rejects ${ending} without returning a partial credential or retaining raw input`, async (t) => {
    const f = fixture(t);
    if (ending === "already-closed") { f.input.destroy(); await new Promise<void>((resolve) => setImmediate(resolve)); }
    const pending = askSecret("Secret: ", f.streams);
    if (ending !== "already-closed") f.input.write("private-canary");
    if (ending === "end") f.input.end();
    if (ending === "close") f.input.destroy();
    if (ending === "ctrl-d") f.input.write("\u0004");
    const result = await outcome(pending);
    assert.equal(result.kind, "error", "EOF must reject rather than leave an unanswered prompt pending");
    assert.ok(result.error instanceof InputEndedError);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount("data"), 0);
    assert.equal(f.input.listenerCount("end"), 0);
    assert.equal(f.input.listenerCount("close"), 0);
    assert.doesNotMatch(f.written(), /private-canary/);
  });
}
for (const raw of [false, true]) {
  test(`masked input preserves Unicode/backspace and restores original raw mode ${raw} after an answer`, async (t) => {
    const f = fixture(t, raw), pending = askSecret("Secret: ", f.streams);
    f.input.end("a密\u007f钥\n");
    assert.equal(await pending, "a钥");
    assert.equal(f.input.isRaw, raw);
    assert.equal(f.input.isPaused(), true);
    assert.equal(f.input.listenerCount("data"), 0);
    assert.doesNotMatch(f.written(), /[a密钥]/);
  });
}
test("masked Ctrl-C cancellation restores input without exposing a partial secret", async (t) => {
  const f = fixture(t), pending = askSecret("Secret: ", f.streams);
  f.input.write("private-canary\u0003");
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.isPaused(), true);
  assert.doesNotMatch(f.written(), /private-canary/);
});

test("masked input stream errors use a fixed message and clear prompt listeners", async (t) => {
  const f = fixture(t), pending = askSecret("Secret: ", f.streams);
  f.input.write("private-canary");
  f.input.emit("error", new Error("private-canary stream details"));
  await assert.rejects(pending, { message: "Secret input stream failed." });
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.isPaused(), true);
  assert.equal(f.input.listenerCount("error"), 0);
  assert.doesNotMatch(f.written(), /private-canary/);
});
for (const ending of ["answer", "end"] as const) {
  test(`terminal restoration failure after ${ending} cannot return a secret or replace the primary EOF error`, async (t) => {
    const f = fixture(t), pending = askSecret("Secret: ", f.streams);
    f.input.setRawMode = () => { throw new Error("private-canary terminal detail"); };
    f.input.end(ending === "answer" ? "private-canary\n" : "private-canary");
    const result = await outcome(pending);
    assert.equal(result.kind, "error");
    if (ending === "end") assert.ok(result.error instanceof InputEndedError);
    else assert.equal((result.error as Error).message, "Could not restore terminal mode after secret input.");
    assert.equal(f.input.listenerCount("data"), 0);
    assert.equal(f.input.listenerCount("end"), 0);
    assert.equal(f.input.listenerCount("close"), 0);
    assert.doesNotMatch(f.written(), /private-canary/);
  });
}

test("masked input decodes a Unicode credential split across raw byte chunks", async (t) => {
  const f = fixture(t), pending = askSecret("Secret: ", f.streams);
  const bytes = Buffer.from("密钥");
  for (const byte of bytes) f.input.write(Buffer.from([byte]));
  f.input.write("\n");
  assert.equal(await pending, "密钥");
  assert.equal(f.input.isRaw, false);
  assert.doesNotMatch(f.written(), /密钥/);
});
