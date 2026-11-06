import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import process from "node:process";

/** The input ended (EOF, Ctrl-D, a closed pipe) before the question was answered. */
export class InputEndedError extends Error {
  readonly code = "input/ended";
  constructor() {
    super("Input ended before the question was answered.");
    this.name = "InputEndedError";
  }
}

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Reads one line from the terminal. When the input ends before a line arrives, the promise rejects with
 * `InputEndedError` instead of staying pending: a pending question would let the process drain its event
 * loop and exit 0 as if the prompt had never been shown.
 */
export async function askQuestion(prompt: string, streams: PromptStreams = { input: process.stdin, output: process.stdout }): Promise<string> {
  const rl = readline.createInterface({ input: streams.input, output: streams.output });
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      rl.once("close", () => { if (!settled) { settled = true; reject(new InputEndedError()); } });
      // Settle synchronously with the answered line. A buffered pipe can emit
      // EOF in the same turn, before a promise question's `.then` would run.
      rl.question(prompt, (answer) => { settled = true; resolve(answer); });
    });
  } finally { rl.close(); }
}

/** Asks a `[y/N]` question; only `y`/`yes` is a yes, and an input that ends without an answer is a no. */
export async function askYesNo(prompt: string, streams?: PromptStreams): Promise<boolean> {
  try { return /^(y|yes)$/i.test((await askQuestion(prompt, streams)).trim()); }
  catch (error) {
    if (error instanceof InputEndedError) return false;
    throw error;
  }
}

/** Reads a secret with masked echo; falls back to a plain prompt when stdin is not a raw-capable TTY. */
export async function askSecret(prompt: string, streams: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input: process.stdin, output: process.stdout }): Promise<string> {
  if (!streams.input.isTTY || !streams.output.isTTY || !streams.input.setRawMode) return askQuestion(prompt, streams);
  const input = streams.input;
  if (input.destroyed || input.readableEnded) throw new InputEndedError();
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    let settled = false;
    const finish = (error?: Error, answer = ""): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      // A closed TTY may no longer accept mode changes. Keep the primary EOF
      // or cancellation error; never return an answer if normal cleanup fails.
      try { input.setRawMode(wasRaw); }
      catch { error ??= new Error("Could not restore terminal mode after secret input."); }
      if (wasPaused) input.pause();
      streams.output.write("\n");
      if (error) reject(error);
      else resolve(answer);
    };
    const onEnd = (): void => finish(new InputEndedError());
    const onError = (): void => finish(new Error("Secret input stream failed."));
    const onData = (chunk: Buffer | string): void => {
      for (const character of typeof chunk === "string" ? chunk : decoder.write(chunk)) {
        if (character === "\r" || character === "\n") { finish(undefined, value); return; }
        if (character === "\u0003") { finish(new Error("API key entry cancelled")); return; }
        if (character === "\u0004") { onEnd(); return; }
        if (character === "\b" || character === "\u007f") {
          const characters = [...value];
          if (characters.length) {
            characters.pop();
            value = characters.join("");
            streams.output.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          value += character;
          streams.output.write("*");
        }
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
    try {
      streams.output.write(prompt);
      input.setRawMode(true);
      input.resume();
    } catch { finish(new Error("Could not start masked secret input.")); }
  });
}
