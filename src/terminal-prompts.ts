import readline from "node:readline/promises";
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
      rl.question(prompt).then((answer) => { settled = true; resolve(answer); }, (error: unknown) => { settled = true; reject(error); });
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
export async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) return askQuestion(prompt);
  const input = process.stdin;
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("API key entry cancelled"));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          const characters = [...value];
          if (characters.length) {
            characters.pop();
            value = characters.join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}
