import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundProcessOutput,
  listBackgroundProcesses,
  startBackgroundProcess,
  stopAllBackgroundProcesses,
  stopBackgroundProcess,
} from "../src/background.js";

test("background commands can be listed, inspected, and stopped", async (t) => {
  t.after(async () => { await stopAllBackgroundProcesses(); });
  const command = "node -e \"console.log('ready'); setInterval(() => {}, 1000)\"";
  const started = startBackgroundProcess(command, process.cwd());
  for (let attempt = 0; attempt < 20 && !backgroundProcessOutput(started.id).includes("ready"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = listBackgroundProcesses().find((item) => item.id === started.id);
  assert.ok(record);
  assert.equal(record.running, true);
  assert.match(backgroundProcessOutput(started.id), /ready/);
  await stopBackgroundProcess(started.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listBackgroundProcesses().find((item) => item.id === started.id)?.running, false);
});
