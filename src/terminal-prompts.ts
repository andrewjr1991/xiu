import readline from "node:readline/promises";
import process from "node:process";

/** Reads one line from the terminal. */
export async function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); }
  finally { rl.close(); }
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
