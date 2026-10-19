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

    // Collect the YAML diagnostic block, including the indented continuation lines of
    // multi-line values (`error: |-`, `actual: |-`), so the annotation carries the real
    // assertion message and the compared text instead of just the key names.
    const details = [];
    let budget = 3_500;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 400) && budget > 0; cursor += 1) {
      const line = lines[cursor];
      if (/^(?:not )?ok \d+ - /u.test(line) || /^\s*\.\.\.\s*$/u.test(line)) break;
      if (/^\s*(?:duration_ms|type):/u.test(line)) continue;
      const text = line.trim();
      if (!text || text === "---") continue;
      details.push(text.slice(0, budget));
      budget -= text.length + 1;
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
