import { spawn } from "node:child_process";
import process from "node:process";

const outputLimit = 2_000_000;
let output = "";

const child = spawn(process.execPath, ["scripts/run-tests.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

function forward(stream, destination) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    destination.write(chunk);
    output = `${output}${chunk}`.slice(-outputLimit);
  });
}

forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
});

if (result.code !== 0) {
  const lines = output.split(/\r?\n/u);
  const failures = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^not ok \d+ - (.+)$/u.exec(lines[index]);
    if (!match) continue;

    const details = [];
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 30); cursor += 1) {
      if (/^(?:not )?ok \d+ - /u.test(lines[cursor])) break;
      if (/^\s*(?:error|code|failureType|location|stack|actual|expected):/u.test(lines[cursor])) {
        details.push(lines[cursor].trim());
      }
    }
    failures.push({ title: match[1], details });
  }

  if (failures.length === 0) {
    failures.push({
      title: "Test process failed",
      details: [result.error?.message ?? (result.signal ? `signal: ${result.signal}` : `exit code: ${result.code}`)],
    });
  }

  for (const failure of failures.slice(0, 10)) {
    const title = escapeProperty(failure.title.slice(0, 200));
    const message = escapeData((failure.details.join(" | ") || "See the test log for details.").slice(0, 4000));
    console.error(`::error title=${title}::${message}`);
  }
}

process.exitCode = result.code;

function escapeProperty(value) {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function escapeData(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
