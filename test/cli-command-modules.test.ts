import assert from "node:assert/strict";
import test from "node:test";
import { handleBackgroundCommand, type BackgroundCommandContext } from "../src/commands/background-commands.js";
import { handleCredentialCommand, type CredentialCommandContext } from "../src/commands/credential-commands.js";
import { handleMcpCommand, type McpCommandContext } from "../src/commands/mcp-commands.js";
import { handlePluginCommand, type PluginCommandContext } from "../src/commands/plugin-commands.js";
import { handleProviderCommand, type ProviderCommandContext } from "../src/commands/provider-commands.js";
import { handleReportCommand, type ReportCommandContext } from "../src/commands/report-commands.js";
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
