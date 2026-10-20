import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { TaskInputQueue } from "../src/task-queue.js";
import { handleAgentCommand, type AgentCommandContext } from "../src/commands/agent-commands.js";
import { handleBackgroundCommand, type BackgroundCommandContext } from "../src/commands/background-commands.js";
import { handleCredentialCommand, type CredentialCommandContext } from "../src/commands/credential-commands.js";
import { handleDiffCommand, type DiffCommandContext } from "../src/commands/diff-commands.js";
import { handleInspectCommand, type InspectCommandContext } from "../src/commands/inspect-commands.js";
import { handleMcpCommand, type McpCommandContext } from "../src/commands/mcp-commands.js";
import { handleMediaCommand, type MediaCommandContext } from "../src/commands/media-command.js";
import { handlePluginCommand, type PluginCommandContext } from "../src/commands/plugin-commands.js";
import { handleProjectCheckCommand, type ProjectCheckCommandContext } from "../src/commands/project-check-commands.js";
import { handleProviderCommand, type ProviderCommandContext } from "../src/commands/provider-commands.js";
import { handleReportCommand, type ReportCommandContext } from "../src/commands/report-commands.js";
import { handleRuntimeCommand, type RuntimeCommandContext } from "../src/commands/runtime-commands.js";
import { handleRunningTaskCommand, incompleteTaskMessage, type RunningTaskCommandContext } from "../src/commands/running-task-commands.js";
import { handleSessionCommand, type SessionCommandContext } from "../src/commands/session-commands.js";
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
import { captureTaskBaseline } from "../src/task-changes.js";
import { TaskRunJournal } from "../src/task-run.js";

// The interactive loop tries each handler in turn, so a handler must decline input it does not own
// without touching its context (an empty context would throw on any access).
const declining: Array<[string, (task: string) => Promise<boolean>]> = [
  ["agents", (task) => handleAgentCommand(task, {} as AgentCommandContext)],
  ["background", (task) => handleBackgroundCommand(task, {} as BackgroundCommandContext)],
  ["credentials", (task) => handleCredentialCommand(task, {} as CredentialCommandContext)],
  ["diff", (task) => handleDiffCommand(task, {} as DiffCommandContext)],
  ["mcp", (task) => handleMcpCommand(task, {} as McpCommandContext)],
  ["media", (task) => handleMediaCommand(task, {} as MediaCommandContext)],
  ["plugins", (task) => handlePluginCommand(task, {} as PluginCommandContext)],
  ["project checks", (task) => handleProjectCheckCommand(task, {} as ProjectCheckCommandContext)],
  ["providers", (task) => handleProviderCommand(task, {} as ProviderCommandContext)],
  ["reports", (task) => handleReportCommand(task, {} as ReportCommandContext)],
  ["runtime", (task) => handleRuntimeCommand(task, {} as RuntimeCommandContext)],
  ["session", (task) => handleSessionCommand(task, {} as SessionCommandContext)],
  ["skills", (task) => handleSkillCommand(task, {} as SkillCommandContext)],
  ["web", (task) => handleWebCommand(task, {} as WebCommandContext)],
];

for (const [name, handle] of declining) {
  test(`${name} command handler declines ordinary tasks and other slash commands`, async () => {
    for (const task of ["fix the failing test", "/help", "/status", "/agentsx", "/mediax", "/diffx", "/checkx", "/model", "/modelsx", "/languagex", "/pluginsx", "/mcpx", "/webx"]) {
      assert.equal(await handle(task), false, task);
    }
  });
}

test("inspect command handler declines ordinary tasks and other slash commands", async () => {
  // `/help` and `/status` belong to this handler, so the shared list above cannot be reused as is.
  for (const task of ["fix the failing test", "/helpme", "/statusx", "/models", "/modelx", "/detailsx", "/queuex", "/doctorx", "/pluginsx", "/mcpx", "/webx"]) {
    assert.equal(await handleInspectCommand(task, {} as InspectCommandContext), false, task);
  }
});

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

test("/mcp sampling shows the per-server state and toggles a user-level server without granting the changed manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-sampling-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(path.join(cwd, ".xiu"), { recursive: true });
  const userConfig = path.join(root, "mcp.json");
  await fs.writeFile(userConfig, JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs-mcp.js"] }, strict: { command: "node", permissions: ["process:execute", "external:write"] } } }));
  await fs.writeFile(path.join(cwd, ".xiu", "mcp.json"), JSON.stringify({ mcpServers: { team: { command: "node", sampling: true } } }));
  const mcpManager = new McpManager(cwd, userConfig, new McpAuthStore(path.join(root, "mcp-auth.json")), {}, new PermissionGrantStore(path.join(root, "extension-permissions.json")));
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  let attached = 0;
  try {
    const context = { language: "en-US", mcpManager, projectMcpTrusted: true, attachMcpTools: () => { attached += 1; }, status: { start() {}, stop() {} } } as unknown as McpCommandContext;
    assert.equal(await handleMcpCommand("/mcp sampling", context), true);
    assert.match(logs.join("\n"), /docs: sampling off\n.*strict: sampling off\n.*team: sampling on \(confirmed per request\) \(project configuration; change it in its own file\)/s);
    assert.equal(await handleMcpCommand("/mcp sampling docs maybe", context), true);
    assert.match(logs.at(-1) ?? "", /Usage: \/mcp sampling <name> on\|off/);
    assert.equal(await handleMcpCommand("/mcp sampling docs on", context), true);
    assert.match(logs.at(-1) ?? "", /Model sampling for MCP docs is now on: .*run \/mcp permissions approve docs/);
    assert.equal(JSON.parse(await fs.readFile(userConfig, "utf8")).mcpServers.docs.sampling, true);
    assert.equal(attached, 1);
    const manifests = await mcpManager.permissionManifests(true);
    assert.ok(manifests.find((item) => item.name === "docs")?.permissions.includes("model:sampling"));
    assert.equal(manifests.find((item) => item.name === "docs")?.approved, false, "the toggle never approves the changed manifest");
    assert.equal(await handleMcpCommand("/mcp sampling docs off", context), true);
    assert.equal(JSON.parse(await fs.readFile(userConfig, "utf8")).mcpServers.docs.sampling, undefined);
    assert.equal(await handleMcpCommand("/mcp sampling team on", context), true);
    assert.match(errors.at(-1) ?? "", /MCP sampling change failed: MCP server team is not in the user configuration/);
    assert.equal(await handleMcpCommand("/mcp sampling strict on", context), true);
    assert.match(errors.at(-1) ?? "", /declares its permissions explicitly/);
    assert.equal(JSON.parse(await fs.readFile(userConfig, "utf8")).mcpServers.strict.sampling, undefined);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("session, plan and checkpoint commands keep their output and never restore without a selection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-session-commands-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  const calls: string[] = [];
  let planMode = false;
  let compactFailure: Error | undefined;
  let journalFailure: Error | undefined;
  let interrupted: { runId: string; sessionId: string; taskPreview: string } | undefined;
  const checkpoints: Array<{ id: string; createdAt: string; tool: string; description: string; files: Array<{ path: string; existed: boolean }> }> = [];
  const context: SessionCommandContext = {
    agent: {
      status: () => ({ sessionId: undefined }) as unknown as ReturnType<SessionCommandContext["agent"]["status"]>,
      compact: async (focus?: string) => { calls.push(`compact:${focus ?? "<none>"}`); if (compactFailure) throw compactFailure; return "Compacted 3 turns."; },
      plan: () => "1. [ ] write tests",
      setPlanMode: async (enabled: boolean) => { planMode = enabled; calls.push(`plan:${enabled}`); },
      restoreSession: () => { calls.push("restore-session"); },
      setRecoverySource: () => { calls.push("recovery-source"); },
    },
    checkpointManager: {
      list: async () => checkpoints.map((checkpoint) => ({ ...checkpoint })),
      restore: async (id: string) => { calls.push(`restore:${id}`); return checkpoints[0]!; },
    },
    config: { cwd: root, providerId: "office" },
    language: "en-US",
    onCheckpointRestored: () => { calls.push("index-invalidated"); },
    onSessionRestored: (source) => { calls.push(`session-restored:${source}`); },
    providerRegistry: { get: () => undefined },
    renderReplay: () => { calls.push("replay"); },
    runTaskSequence: async () => { calls.push("run-task"); return false; },
    status: { stop: () => { calls.push("status-stop"); } },
    switchProviderProfile: async () => { calls.push("switch-provider"); return true; },
    taskRunJournal: {
      interrupted: async () => { calls.push("journal-read"); if (journalFailure) throw journalFailure; return interrupted as unknown as Awaited<ReturnType<SessionCommandContext["taskRunJournal"]["interrupted"]>>; },
      abandon: async (runId: string) => { calls.push(`abandon:${runId}`); },
    },
    confirmRestore: async () => { calls.push("confirm"); return true; },
  };
  try {
    assert.equal(await handleSessionCommand("/historyx", context), false);
    assert.equal(await handleSessionCommand("/history", context), true);
    assert.match(logs.at(-1) ?? "", /No conversation history\./);
    assert.equal(await handleSessionCommand("/history sessions", context), true);
    assert.match(logs.at(-1) ?? "", /No saved sessions\./);
    assert.equal(await handleSessionCommand("/compact", context), true);
    assert.match(logs.at(-1) ?? "", /Compacted 3 turns\./);
    assert.equal(await handleSessionCommand("/compact tests and failures", context), true);
    assert.deepEqual(calls.filter((call) => call.startsWith("compact:")), ["compact:<none>", "compact:tests and failures"]);
    compactFailure = new Error("context too small");
    assert.equal(await handleSessionCommand("/compact", context), true);
    assert.match(errors.at(-1) ?? "", /Error: context too small/);
    assert.ok(calls.includes("status-stop"), "the status line stops after a compaction failure");
    compactFailure = undefined;
    assert.equal(await handleSessionCommand("/plan", context), true);
    assert.match(logs.at(-1) ?? "", /write tests/);
    assert.equal(await handleSessionCommand("/plan on", context), true);
    assert.equal(planMode, true);
    assert.match(logs.at(-1) ?? "", /Plan mode enabled \(read-only\)\./);
    assert.equal(await handleSessionCommand("/plan off", context), true);
    assert.equal(planMode, false);
    assert.match(logs.at(-1) ?? "", /Plan mode disabled\./);
    assert.equal(await handleSessionCommand("/checkpoints", context), true);
    assert.match(logs.at(-1) ?? "", /No checkpoints in the current session\./);
    assert.equal(await handleSessionCommand("/rewind", context), true);
    assert.match(logs.at(-1) ?? "", /No checkpoints in the current session\./);
    checkpoints.push({ id: "cp-1", createdAt: "2026-10-20T08:00:00.000Z", tool: "write_file", description: "before edit", files: [{ path: "src/a.ts", existed: true }] });
    assert.equal(await handleSessionCommand("/checkpoints", context), true);
    assert.match(logs.at(-1) ?? "", /cp-1 {2}write_file {2}src\/a\.ts/);
    // Without an interactive terminal the checkpoint selector counts as cancelled, so nothing is restored or confirmed.
    assert.equal(await handleSessionCommand("/rewind", context), true);
    assert.match(logs.at(-1) ?? "", /Restore cancelled\./);
    assert.equal(calls.some((call) => call.startsWith("restore:") || call === "confirm" || call === "index-invalidated"), false);

    // /resume: an empty workspace has no sessions to pick from.
    assert.equal(await handleSessionCommand("/resume", context), true);
    assert.match(logs.at(-1) ?? "", /No session selected\./);
    // /recover: an unreadable journal is reported; no interrupted task is a plain note.
    journalFailure = new Error("journal locked");
    assert.equal(await handleSessionCommand("/recover", context), true);
    assert.match(errors.at(-1) ?? "", /Could not read the task recovery journal/);
    assert.match(errors.at(-1) ?? "", /journal locked/);
    journalFailure = undefined;
    assert.equal(await handleSessionCommand("/recover", context), true);
    assert.match(logs.at(-1) ?? "", /There is no interrupted task in this workspace\./);
    // With an interrupted task but no terminal the action selector counts as cancelled: nothing is abandoned, restored or replayed.
    interrupted = { runId: "run-7", sessionId: "ses-7", taskPreview: "refactor parser" };
    const before = calls.length;
    assert.equal(await handleSessionCommand("/recover", context), true);
    assert.deepEqual(calls.slice(before), ["journal-read"]);
    assert.equal(calls.some((call) => call.startsWith("abandon:") || call === "restore-session" || call === "recovery-source" || call === "run-task" || call.startsWith("session-restored:")), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("inspection commands keep their output, read live state and never alter it", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  const calls: string[] = [];
  const config = { apiKey: "sk-test", cwd: "/work/demo", provider: "openai", providerId: "office" } as InspectCommandContext["config"];
  const profile = { id: "office", model: "gpt-4.1" } as InspectCommandContext["startupProfile"];
  const activityRecords: Array<{ id: string; kind: string; state: string; title: string; description: string; startedAt: string; detail?: string; summary?: string }> = [];
  let doctorFailure: Error | undefined;
  const context: InspectCommandContext = {
    activities: {
      list: () => activityRecords.map((record) => ({ ...record })) as unknown as ReturnType<InspectCommandContext["activities"]["list"]>,
      get: (id: string) => { calls.push(`activity:${id}`); return activityRecords.find((record) => record.id === id) as unknown as ReturnType<InspectCommandContext["activities"]["get"]>; },
    },
    agent: {
      status: () => ({
        sessionId: "ses-1", model: "gpt-4.1-mini", messages: 7,
        stats: { modelCalls: 3, toolCalls: 5, inputTokens: 1200, outputTokens: 340, estimatedTokens: 2048, compactions: 1, activeMs: 4567 },
        contextLimit: 100000, contextWindow: 128000, contextWindowSource: "official", contextLimitMode: "auto",
        index: { mode: "cache", files: 42, truncated: false, analyzedModules: 10, symbols: 300, dependencies: 55, durationMs: 12, dirty: true },
        planMode: true, outcome: "completed", turn: 2, maxTurns: 40, pendingSteering: 0,
      }) as unknown as ReturnType<InspectCommandContext["agent"]["status"]>,
    },
    background: { list: () => [{ running: true }, { running: false }] as unknown as ReturnType<InspectCommandContext["background"]["list"]> },
    capabilityProbeSummary: (candidate, model) => `probe ${candidate.id}/${model ?? candidate.model}`,
    config,
    coordinator: { list: () => [{ status: "running" }, { status: "completed" }, { status: "failed" }] as unknown as ReturnType<InspectCommandContext["coordinator"]["list"]> },
    featureNames: (candidate, model) => `features ${candidate.id}/${model ?? candidate.model}`,
    language: "en-US",
    mcpManager: {
      status: () => [{ state: "connected" }, { state: "failed" }] as unknown as ReturnType<InspectCommandContext["mcpManager"]["status"]>,
      tools: () => [{}, {}, {}] as unknown as ReturnType<InspectCommandContext["mcpManager"]["tools"]>,
    },
    providerRegistry: { get: (id: string) => (id === "office" ? profile : undefined) } as unknown as InspectCommandContext["providerRegistry"],
    settings: {},
    startupProfile: profile,
    status: { start: (label: string) => { calls.push(`status-start:${label}`); }, stop: () => { calls.push("status-stop"); } },
    version: "0.20.14",
    collectDoctor: async () => {
      calls.push("doctor");
      if (doctorFailure) throw doctorFailure;
      return { version: "0.20.14", generatedAt: "2026-10-20T09:00:00.000Z", status: "pass", sections: [{ id: "installation", titleZh: "安装", titleEn: "Installation", items: [{ id: "version", level: "pass", labelZh: "版本", labelEn: "Version", summaryZh: "0.20.14", summaryEn: "0.20.14" }] }] };
    },
  };
  try {
    assert.equal(await handleInspectCommand("/model", context), true);
    assert.match(logs.at(-1) ?? "", /Use \/models to choose a model\. Current provider\/model: office\/gpt-4\.1-mini/);
    assert.equal(await handleInspectCommand("/model gpt-5", context), true);
    config.providerId = "lab";
    assert.equal(await handleInspectCommand("/model", context), true);
    assert.match(logs.at(-1) ?? "", /lab\/gpt-4\.1-mini/, "/model reads the provider that is current when it runs");
    config.providerId = "office";

    assert.equal(await handleInspectCommand("/details", context), true);
    assert.match(logs.at(-1) ?? "", /No tool or Agent activity has been recorded yet\./);
    activityRecords.push({ id: "act-1", kind: "tool", state: "completed", title: "read_file", description: "src/a.ts", startedAt: "2026-10-20T08:00:00.000Z", detail: "12 lines" });
    // Without an interactive terminal the activity selector counts as cancelled, so no record is opened.
    assert.equal(await handleInspectCommand("/details", context), true);
    assert.equal(calls.some((call) => call.startsWith("activity:")), false);

    for (const word of ["/queue", "/queue add tests", "/clear-queue", "/cancel"]) {
      assert.equal(await handleInspectCommand(word, context), true, word);
      assert.ok((logs.at(-1) ?? "").startsWith(`${word.split(" ")[0]} is available while a task is running.`), logs.at(-1));
    }

    assert.equal(await handleInspectCommand("/status", context), true);
    const status = logs.at(-1) ?? "";
    for (const line of [
      "Session: ses-1", "Provider: office (openai)", "Model: gpt-4.1-mini", "Capabilities: features office/gpt-4.1-mini", "Capability probe: probe office/gpt-4.1-mini",
      "Language: English", "Plan mode: ON (read-only)", "Last outcome: completed", "Turn: 2/40", "Pending steering: 0", "Messages: 7",
      "Context estimate: ~2,048 tokens", "Auto compact: 100,000 tokens (automatic)", "Model window: 128,000 tokens (official)", "API tokens: 1,200 in / 340 out",
      "Calls: 3 model / 5 tool", "Compactions: 1", "Active time: 4.6s", "Latest task diagnostics: none",
      "Index: 42 files · 10 analyzed modules · 300 symbols · 55 dependencies · cache reused · 12ms · refresh pending",
      "MCP: 1 servers / 3 tools", "Agents: 1 running / 3 saved runs", "Background: 1 running", "Activities: 1 recorded (/details)",
    ]) assert.ok(status.includes(line), `status line missing: ${line}\n${status}`);
    assert.equal(await handleInspectCommand("/status", { ...context, language: "zh-CN" }), true);
    assert.match(logs.at(-1) ?? "", /规划模式：开启（只读）/);
    assert.match(logs.at(-1) ?? "", /索引：42 个文件 · 10 个已分析模块 · 300 个符号 · 55 条依赖 · 缓存复用 · 12 毫秒 · 等待刷新/);

    assert.equal(await handleInspectCommand("/doctor", context), true);
    assert.deepEqual(calls.filter((call) => call.startsWith("status") || call === "doctor"), ["status-start:Collecting diagnostics", "doctor", "status-stop"]);
    assert.match(logs.at(-1) ?? "", /Installation/);
    doctorFailure = new Error("registry unreadable");
    assert.equal(await handleInspectCommand("/doctor", context), true);
    assert.match(errors.at(-1) ?? "", /Could not build the diagnostics report/);
    assert.match(errors.at(-1) ?? "", /registry unreadable/);
    assert.equal(calls.at(-1), "status-stop", "the status line stops after a doctor failure");
    doctorFailure = undefined;

    assert.equal(await handleInspectCommand("/help", context), true);
    assert.match(logs.at(-1) ?? "", /\/status/);
    assert.equal(await handleInspectCommand("/help doctor", context), true);
    assert.match(logs.at(-1) ?? "", /\/doctor/);
    assert.doesNotMatch(logs.at(-1) ?? "", /\/rewind/);
    assert.equal(await handleInspectCommand("/help nosuchcommand", context), true);
    assert.match(logs.at(-1) ?? "", /nosuchcommand/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("the agents command lists, cancels, retries and integrates only after the explicit write confirmation", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  const calls: string[] = [];
  const task = { id: "t1", role: "implementer", mode: "worktree", title: "add tests", status: "completed", dependencies: [], createdAt: "2026-10-20T08:00:00.000Z", startedAt: "2026-10-20T08:00:00.000Z", completedAt: "2026-10-20T08:00:05.000Z", stats: { inputTokens: 100, outputTokens: 20, activeMs: 5000 } };
  const run = { id: "run-1", goal: "cover the parser", status: "completed", createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:05.000Z", concurrency: 1, tasks: [task] };
  const runs: Array<typeof run> = [];
  let canIntegrate = false;
  let confirmAnswer = false;
  const plan = () => ({
    runId: "run-1", taskId: "t1", blockers: canIntegrate ? [] : ["A completed reviewer is required"], canIntegrate,
    analysis: { patch: "diff --git a/src/a.ts b/src/a.ts", changedFiles: ["src/a.ts"], mainChangesSinceBase: [], dirtyMainFiles: [], conflicts: [], canIntegrate: true },
    evidence: { reviewers: canIntegrate ? ["t2"] : [], testers: canIntegrate ? ["t3"] : [], blockers: canIntegrate ? [] : ["A completed reviewer is required"] },
  });
  const context: AgentCommandContext = {
    coordinator: {
      list: () => runs as unknown as ReturnType<AgentCommandContext["coordinator"]["list"]>,
      get: (id: string) => { const found = runs.find((item) => item.id === id); if (!found) throw new Error(`Unknown run ${id}`); return found as unknown as ReturnType<AgentCommandContext["coordinator"]["get"]>; },
      cancel: async (runId: string, taskId: string) => { calls.push(`cancel:${runId}/${taskId}`); return { ...task, status: "cancelled" } as unknown as Awaited<ReturnType<AgentCommandContext["coordinator"]["cancel"]>>; },
      retry: async (runId: string, taskId: string) => { calls.push(`retry:${runId}/${taskId}`); return run as unknown as Awaited<ReturnType<AgentCommandContext["coordinator"]["retry"]>>; },
      analyzeIntegration: async (runId: string, taskId: string) => { calls.push(`analyze:${runId}/${taskId}`); return plan() as unknown as Awaited<ReturnType<AgentCommandContext["coordinator"]["analyzeIntegration"]>>; },
      integrate: async (runId: string, taskId: string) => { calls.push(`integrate:${runId}/${taskId}`); return "Integrated 1 file."; },
    },
    cwd: "/work/demo",
    language: "en-US",
    onIntegrated: () => { calls.push("index-invalidated"); },
    confirmIntegrate: async (prompt: string) => { calls.push(`confirm:${prompt.includes("/work/demo") ? "names-workspace" : "no-workspace"}`); return confirmAnswer; },
  };
  try {
    assert.equal(await handleAgentCommand("/agents", context), true);
    assert.match(logs.at(-1) ?? "", /No multi-agent runs\./);
    runs.push(run);
    assert.equal(await handleAgentCommand("/agents", context), true);
    assert.match(logs.at(-1) ?? "", /Run run-1 - completed - cover the parser/);
    assert.match(logs.at(-1) ?? "", /\[completed\] t1 \(implementer, worktree\) add tests - 5\.0s, 120 tokens/);
    assert.equal(await handleAgentCommand("/agents run-1", context), true);
    assert.match(logs.at(-1) ?? "", /Total: 120 tokens, 5\.0s agent time/);
    assert.equal(await handleAgentCommand("/agents run-9", context), true);
    assert.match(errors.at(-1) ?? "", /Agent command failed/);
    assert.match(errors.at(-1) ?? "", /Unknown run run-9/);
    assert.equal(await handleAgentCommand("/agents cancel run-1", context), true);
    assert.match(logs.at(-1) ?? "", /Usage: \/agents \[run-id\]/);
    assert.equal(await handleAgentCommand("/agents cancel run-1 t1", context), true);
    assert.match(logs.at(-1) ?? "", /Agent t1 is cancelled\./);
    assert.equal(await handleAgentCommand("/agents retry run-1 t1", context), true);
    assert.match(logs.at(-1) ?? "", /Run run-1 - completed/);
    // A blocked plan is reported and nothing is confirmed or written.
    assert.equal(await handleAgentCommand("/agents integrate run-1 t1", context), true);
    assert.match(logs.at(-2) ?? "", /Decision: blocked/);
    assert.match(logs.at(-1) ?? "", /Integration is blocked by conflicts or evidence gates/);
    canIntegrate = true;
    assert.equal(await handleAgentCommand("/agents integrate run-1 t1", context), true);
    assert.match(logs.at(-1) ?? "", /Agent integration cancelled\./);
    assert.equal(calls.some((call) => call.startsWith("integrate:") || call === "index-invalidated"), false, "nothing is written before the confirmation");
    confirmAnswer = true;
    assert.equal(await handleAgentCommand("/agents integrate run-1 t1", context), true);
    assert.match(logs.at(-1) ?? "", /Integrated 1 file\./);
    assert.deepEqual(calls.filter((call) => !call.startsWith("analyze:")), [
      "cancel:run-1/t1", "retry:run-1/t1", "confirm:names-workspace", "confirm:names-workspace", "integrate:run-1/t1", "index-invalidated",
    ]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("the models and language commands keep their output and switch nothing without a selection", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  const calls: string[] = [];
  const profile = { id: "office", model: "gpt-4.1" } as RuntimeCommandContext["startupProfile"];
  let discoveryError: string | undefined;
  let chosenLanguage: "zh-CN" | "en-US" | undefined;
  const context: RuntimeCommandContext = {
    agent: {
      listModels: async () => { calls.push("list-models"); return { models: [{ id: "gpt-4.1", source: "current" as const }, { id: "gpt-4.1-mini", name: "Mini", source: "api" as const, contextWindow: 128000 }], discoveryError }; },
      status: () => ({ model: "gpt-4.1" }) as unknown as ReturnType<RuntimeCommandContext["agent"]["status"]>,
    },
    applyRuntimeLanguage: async (selected, redraw) => { calls.push(`apply-language:${selected}:${redraw}`); },
    capabilityProbeSummary: () => "probe",
    chooseRuntimeLanguage: async (command) => { calls.push(`choose-language:${command}`); return chosenLanguage; },
    config: { providerId: "office" },
    featureNames: () => "features",
    language: "en-US",
    providerRegistry: { get: (id: string) => (id === "office" ? profile : undefined) },
    startupProfile: profile,
    status: { start: (label: string) => { calls.push(`status-start:${label}`); }, stop: () => { calls.push("status-stop"); } },
    switchProviderProfile: async (candidate, persist, model) => { calls.push(`switch:${candidate.id}:${persist}:${model ?? "<none>"}`); return true; },
  };
  try {
    // Without an interactive terminal the model selector counts as cancelled, so nothing is switched.
    assert.equal(await handleRuntimeCommand("/models", context), true);
    assert.match(logs.at(-1) ?? "", /Model selection cancelled\./);
    assert.deepEqual(calls, ["status-start:Discovering available models", "list-models", "status-stop"]);
    discoveryError = "HTTP 503";
    assert.equal(await handleRuntimeCommand("/models", context), true);
    assert.match(logs.at(-2) ?? "", /Live model discovery unavailable: HTTP 503\nShowing built-in models instead\./);
    assert.equal(calls.some((call) => call.startsWith("switch:")), false);

    assert.equal(await handleRuntimeCommand("/language", context), true);
    assert.match(logs.at(-1) ?? "", /Language selection cancelled\./);
    assert.equal(calls.at(-1), "choose-language:/language");
    chosenLanguage = "zh-CN";
    assert.equal(await handleRuntimeCommand("/language zh-CN", context), true);
    assert.deepEqual(calls.slice(-2), ["choose-language:/language zh-CN", "apply-language:zh-CN:true"]);
  } finally {
    console.log = originalLog;
  }
});

test("the media command lists records with their status and the recovery hint", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  const records: Array<{ key: string; requestId: string; kind: "image" | "video" | "audio"; providerId: string; model: string; status: "submitting" | "submitted" | "asset_ready" | "completed" | "ambiguous" | "failed"; createdAt: string; updatedAt: string; taskId?: string; savedPath?: string }> = [];
  const limits: number[] = [];
  const context: MediaCommandContext = {
    cwd: "/work/demo",
    language: "en-US",
    listRecords: async (limit) => { limits.push(limit); return records.map((record) => ({ ...record })); },
  };
  try {
    assert.equal(await handleMediaCommand("/media", context), true);
    assert.match(logs.at(-1) ?? "", /This project has no media generation records yet\./);
    records.push(
      { key: "a", requestId: "11112222-3333", kind: "image", providerId: "office", model: "gpt-image-1", status: "completed", createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:05.000Z", savedPath: "out/cat.png" },
      { key: "b", requestId: "44445555-6666", kind: "video", providerId: "lab", model: "veo", status: "submitted", createdAt: "2026-10-20T08:01:00.000Z", updatedAt: "2026-10-20T08:01:00.000Z", taskId: "task-9" },
    );
    assert.equal(await handleMediaCommand("/media", context), true);
    const output = logs.slice(-4).join("\n");
    assert.match(output, /Media generation and recovery tasks/);
    assert.match(output, /\[11112222\] image · completed · office\/gpt-image-1 · saved out\/cat\.png/);
    assert.match(output, /\[44445555\] video · generation pending · lab\/veo · task task-9/);
    assert.match(output, /resume media request <ID> to <workspace path>/);
    assert.equal(await handleMediaCommand("/media", { ...context, language: "zh-CN" }), true);
    assert.match(logs.slice(-4).join("\n"), /\[44445555\] 视频 · 等待生成 · lab\/veo · task task-9/);
    assert.deepEqual(limits, [30, 30, 30]);
  } finally {
    console.log = originalLog;
  }
});

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  return { logs, errors, restore: () => { console.log = originalLog; console.error = originalError; } };
}

test("the diff command keeps its views: usage, the session baseline, redaction and the saved run list", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-diff-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, "kept.txt"), "kept\n");
  const taskRunJournal = new TaskRunJournal(cwd, path.join(root, "task-runs"));
  const console_ = captureConsole();
  t.after(console_.restore);
  let baseline: Awaited<ReturnType<typeof captureTaskBaseline>> | undefined;
  const context: DiffCommandContext = {
    config: { cwd, apiKey: "sk-diff-secret-1234567890" },
    language: "en-US",
    latestTaskBaseline: () => baseline,
    redact: (value) => value.replaceAll("sk-diff-secret-1234567890", "[redacted]"),
    taskRunJournal,
  };
  assert.equal(await handleDiffCommand("/diff nonsense", context), true);
  assert.match(console_.logs.at(-1) ?? "", /Usage: \/diff/);
  assert.equal(await handleDiffCommand("/diff task", context), true);
  assert.match(console_.logs.at(-1) ?? "", /No task baseline is available in this session/);
  assert.equal(await handleDiffCommand("/diff runs", context), true);
  assert.doesNotMatch(console_.logs.at(-1) ?? "", /Error/);
  assert.equal(console_.errors.length, 0);
  baseline = await captureTaskBaseline(cwd);
  await fs.writeFile(path.join(cwd, "added.txt"), "token sk-diff-secret-1234567890\n");
  assert.equal(await handleDiffCommand("/diff task", context), true);
  const report = console_.logs.at(-1) ?? "";
  assert.match(report, /added\.txt/);
  assert.doesNotMatch(report, /sk-diff-secret/);
  assert.equal(await handleDiffCommand("/diff", context), true);
  assert.match(console_.logs.at(-1) ?? "", /added\.txt/);
  assert.equal(console_.errors.length, 0);
});

test("the check command lists scripts, reruns nothing on a bare /check, and runs through approval, Plan mode and cancellation tracking", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-check-command-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const console_ = captureConsole();
  t.after(console_.restore);
  const calls: string[] = [];
  let planMode = false;
  let approved = false;
  let latest: ReturnType<ProjectCheckCommandContext["latestProjectCheck"]>;
  const controllers: Array<AbortController | undefined> = [];
  const context: ProjectCheckCommandContext = {
    activities: { start: (kind, title, description) => { calls.push(`activity:${kind}:${title}:${description}`); return "activity-1"; }, finish: (id, _detail, failed) => { calls.push(`finish:${id}:${failed}`); } },
    agent: { status: () => ({ planMode }) as ReturnType<ProjectCheckCommandContext["agent"]["status"]> },
    approve: async (request) => { calls.push(`approve:${request.description}`); return approved; },
    config: { cwd, apiKey: undefined },
    language: "en-US",
    latestProjectCheck: () => latest,
    setLatestProjectCheck: (run) => { latest = run; calls.push(`record:${run.status}`); },
    setActiveCheck: (controller) => { controllers.push(controller); },
    onChecksExecuted: () => { calls.push("index:invalidate"); },
    redact: (value) => value,
    status: { start: (label) => { calls.push(`status:${label}`); }, stop: () => { calls.push("status:stop"); } },
  };
  assert.equal(await handleProjectCheckCommand("/check nonsense", context), true);
  assert.match(console_.logs.at(-1) ?? "", /Usage: \/check/);
  assert.equal(controllers.length, 0, "a usage error never starts a run");

  assert.equal(await handleProjectCheckCommand("/check", context), true);
  assert.ok(console_.logs.some((line) => /lint:.*package\.json/.test(line)), "without package.json every check says why it is unavailable");
  assert.ok(!calls.some((call) => call.startsWith("record:")), "a bare /check records nothing");
  assert.deepEqual(controllers.map((controller) => controller === undefined), [false, true], "the run is tracked while it lasts and cleared after");

  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { lint: "node -e \"process.exit(0)\"" } }));
  assert.equal(await handleProjectCheckCommand("/check lint", context), true);
  assert.ok(calls.some((call) => call.startsWith("approve:")), "running a check asks for approval");
  assert.match(console_.logs.find((line) => line.includes("lint: denied")) ?? "", /denied/);
  assert.ok(calls.includes("record:blocked") && calls.includes("index:invalidate") && calls.includes("finish:activity-1:true"));
  assert.ok(calls.some((call) => call.startsWith("status:Checking lint")) && calls.at(-1) === "status:stop");

  planMode = true;
  approved = true;
  const approvalsBefore = calls.filter((call) => call.startsWith("approve:")).length;
  assert.equal(await handleProjectCheckCommand("/check all", context), true);
  assert.equal(calls.filter((call) => call.startsWith("approve:")).length, approvalsBefore, "Plan mode never reaches the approval prompt");
  assert.ok(calls.includes("record:blocked"));
  assert.ok(console_.logs.some((line) => line.includes("lint: skipped")) && console_.logs.some((line) => line.includes("Plan mode is read-only")));

  planMode = false;
  assert.equal(await handleProjectCheckCommand("/check", context), true);
  assert.ok(console_.logs.some((line) => line.includes("Previous check record (not rerun):")));
  assert.equal(console_.errors.length, 0);
});
