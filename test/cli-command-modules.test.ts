import assert from "node:assert/strict";
import test, { mock } from "node:test";
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
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore, type XiuSettings } from "../src/settings.js";
import { sharedFreeSearchBackend } from "../src/free-search.js";
import { PermissionGrantStore } from "../src/extension-permissions.js";
import { McpAuthStore } from "../src/mcp-auth-store.js";
import { McpManager } from "../src/mcp.js";

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

test("managed search selection persists across restart and doctor never launches local search", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-managed-selection-"));
  const store = new SettingsStore(path.join(directory, "settings.json"), {});
  const settings: XiuSettings = { webSearch: { enabled: true, provider: "free-search", baseURL: "https://old.example", apiKeyEnv: "OLD_KEY", proxy: "http://127.0.0.1:8080/", allowedDomains: ["example.com"], blockedDomains: ["blocked.example"], timeoutMs: 9000 } };
  let refreshes = 0;
  let diagnoses = 0;
  const ctx: WebCommandContext = {
    language: "en-US", settings, settingsStore: store,
    managedWebSearchAuth: () => undefined,
    refreshWebSearchRuntime: () => { refreshes++; }, auditCredential: async () => {},
  };
  try {
    assert.equal(await handleWebCommand("/web configure managed", ctx), true);
    assert.equal(refreshes, 1);
    const loaded = await store.load();
    assert.equal(loaded.webSearch?.provider, "searxng");
    assert.equal(loaded.webSearch?.managedAuth, "xiu-device");
    assert.equal(loaded.webSearch?.apiKeyEnv, undefined);
    assert.equal(loaded.webSearch?.proxy, settings.webSearch?.proxy);
    assert.deepEqual(loaded.webSearch?.allowedDomains, ["example.com"]);
    assert.deepEqual(loaded.webSearch?.blockedDomains, ["blocked.example"]);
    assert.equal(loaded.webSearch?.timeoutMs, 9000);
    // A stub doctor fails immediately: reaching it proves the local backend was skipped.
    const { ManagedWebSearchAuth } = await import("../src/managed-web-search-auth.js");
    const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth");
    auth.diagnose = async () => { diagnoses++; throw new Error("test managed diagnosis"); };
    ctx.settings = loaded;
    ctx.managedWebSearchAuth = () => auth;
    const localSearch = mock.method(sharedFreeSearchBackend(loaded.webSearch?.proxy), "search", async () => { throw new Error("local backend must stay idle"); });
    try {
      await handleWebCommand("/web doctor", ctx);
      assert.equal(diagnoses, 1);
      assert.equal(localSearch.mock.callCount(), 0);
    } finally { localSearch.mock.restore(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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

test("a command failure the catalog explains gets the next step and xiu doctor; any other failure keeps its one line", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-command-failures-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const userConfig = path.join(root, "mcp.json");
  await fs.writeFile(userConfig, JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs-mcp.js"] } } }));
  const permissionFile = path.join(root, "extension-permissions.json");
  await fs.mkdir(permissionFile); // a directory where the grant store should be: every approval check fails closed
  const mcpManager = new McpManager(cwd, userConfig, new McpAuthStore(path.join(root, "mcp-auth.json")), {}, new PermissionGrantStore(permissionFile));
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    const context = { language: "en-US", mcpManager, projectMcpTrusted: false, status: { start() {}, stop() {} } } as unknown as McpCommandContext;
    assert.equal(await handleMcpCommand("/mcp permissions", context), true);
    const pluginContext = { language: "zh-CN", pluginRegistry: { refresh: async () => [], list: () => [], get: () => undefined, setEnabled: async (id: string) => { throw new Error(`Plugin not found: ${id}`); } }, applyApprovedPlugins: async () => [] } as unknown as PluginCommandContext;
    assert.equal(await handlePluginCommand("/plugin enable nope", pluginContext), true);
    assert.equal(await handlePluginCommand("/plugin revoke nope", pluginContext), true);
    const skillContext = { language: "zh-CN", skillRegistry: { refresh: async () => [{ name: "nope", scope: "project" }] }, agent: { reloadInstructions() {} } } as unknown as SkillCommandContext;
    assert.equal(await handleSkillCommand("/skills uninstall nope", skillContext), true);
    assert.match(logs.join("\n"), /没有名为 nope 的已安装全局技能/);
    assert.match(logs.join("\n"), /未找到插件：nope/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  const explained = errors.join("\n");
  assert.match(explained, /^MCP permission operation failed: The extension permission record \(~\/\.xiu\/extension-permissions\.json\) cannot be read, so no plugin, skill or MCP server can be confirmed as approved\.$/m, explained);
  assert.match(explained, /^Next step: Fix its JSON or move the file away; afterwards every approved plugin, skill and MCP server needs one new approval\.$/m);
  assert.match(explained, /^Diagnose: xiu doctor$/m);
  assert.match(explained, /^Detail: config\/extension-permissions · Unable to read the extension permission store at .*extension-permissions\.json: EISDIR/m);
  const plain = logs.join("\n");
  assert.match(plain, /^插件状态修改失败：Plugin not found: nope$/m, plain);
  assert.doesNotMatch(plain, /下一步/, "an unexplained failure gets no generic next step");
});
