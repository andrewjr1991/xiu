import assert from "node:assert/strict";
import test from "node:test";
import { TaskInputQueue } from "../src/task-queue.js";
import { handleBackgroundCommand, type BackgroundCommandContext } from "../src/commands/background-commands.js";
import { handleCredentialCommand, type CredentialCommandContext } from "../src/commands/credential-commands.js";
import { handleMcpCommand, type McpCommandContext } from "../src/commands/mcp-commands.js";
import { handlePluginCommand, type PluginCommandContext } from "../src/commands/plugin-commands.js";
import { handleProviderCommand, type ProviderCommandContext } from "../src/commands/provider-commands.js";
import { handleReportCommand, type ReportCommandContext } from "../src/commands/report-commands.js";
import { handleRunningTaskCommand, incompleteTaskMessage, type RunningTaskCommandContext } from "../src/commands/running-task-commands.js";
import { handleSkillCommand, type SkillCommandContext } from "../src/commands/skill-commands.js";
import { handleWebCommand, type WebCommandContext } from "../src/commands/web-commands.js";

// The interactive loop tries each handler in turn, so a handler must decline input it does not own
// without touching its context (an empty context would throw on any access).
const declining: Array<[string, (task: string) => Promise<boolean>]> = [
  ["background", (task) => handleBackgroundCommand(task, {} as BackgroundCommandContext)],
  ["credentials", (task) => handleCredentialCommand(task, {} as CredentialCommandContext)],
  ["mcp", (task) => handleMcpCommand(task, {} as McpCommandContext)],
  ["plugins", (task) => handlePluginCommand(task, {} as PluginCommandContext)],
  ["providers", (task) => handleProviderCommand(task, {} as ProviderCommandContext)],
  ["reports", (task) => handleReportCommand(task, {} as ReportCommandContext)],
  ["skills", (task) => handleSkillCommand(task, {} as SkillCommandContext)],
  ["web", (task) => handleWebCommand(task, {} as WebCommandContext)],
];

for (const [name, handle] of declining) {
  test(`${name} command handler declines ordinary tasks and other slash commands`, async () => {
    for (const task of ["fix the failing test", "/help", "/status", "/pluginsx", "/mcpx", "/webx"]) {
      assert.equal(await handle(task), false, task);
    }
  });
}

test("a handled command reports that it consumed the input", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const context = { language: "en-US" } as PluginCommandContext;
    assert.equal(await handlePluginCommand("/plugin install", context), true);
    assert.equal(await handleBackgroundCommand("/background bogus", { language: "en-US" } as BackgroundCommandContext), true);
  } finally {
    console.log = original;
  }
  assert.match(lines.join("\n"), /Usage: \/plugin install/);
  assert.match(lines.join("\n"), /Usage: \/background/);
});

test("web status and proxy commands print the current settings", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const context = {
      language: "en-US",
      managedWebSearchAuth: () => undefined,
      settings: {},
    } as unknown as WebCommandContext;
    assert.equal(await handleWebCommand("/web status", context), true);
    assert.equal(await handleWebCommand("/web proxy", context), true);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Native web search: disabled/);
  assert.match(output, /Managed search credential: not applicable/);
  assert.match(output, /Independent web tools proxy: direct/);
});

test("steering prompt commands leave cancel, exit and ordinary steering to the running-task loop", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  const queue = new TaskInputQueue();
  const context = { language: "en-US", queue } as unknown as RunningTaskCommandContext;
  try {
    for (const task of ["/cancel", "/exit", "/quit", "also update the docs", "/queuex", "/webx"]) assert.equal(await handleRunningTaskCommand(task, context), false, task);
    assert.equal(await handleRunningTaskCommand("/queue add a changelog entry", context), true);
    assert.equal(queue.size, 1);
    assert.equal(await handleRunningTaskCommand("/queue /check", context), true);
    assert.equal(queue.size, 1);
    assert.equal(await handleRunningTaskCommand("/clear-queue", context), true);
    assert.equal(queue.size, 0);
    assert.equal(await handleRunningTaskCommand("/web configure", context), true);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Scheduled next/);
  assert.match(output, /Use check and diff commands directly/);
  assert.match(output, /Cleared 1 queued follow-up/);
  assert.match(output, /after the current task finishes/);
});

test("incomplete task messages name the failure reason", () => {
  assert.match(incompleteTaskMessage("verification_failed", "en-US"), /verification/);
  assert.match(incompleteTaskMessage("plan_incomplete", "en-US"), /task plan/);
  assert.match(incompleteTaskMessage("web_evidence", "en-US"), /web evidence/);
  assert.match(incompleteTaskMessage("model_incomplete", "en-US"), /model response/);
  assert.match(incompleteTaskMessage("tool_failed", "en-US"), /tool batch/);
  assert.match(incompleteTaskMessage(undefined, "en-US"), /runtime error/);
  assert.match(incompleteTaskMessage("tool_failed", "zh-CN"), /目标尚未完成/);
});
