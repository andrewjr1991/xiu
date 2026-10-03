const { contextBridge } = require("electron");

const now = () => new Date().toISOString();
const workspace = {
  bridgeVersion: 1,
  trust: "trusted",
  workspace: { id: "smoke-workspace", name: "G5C 验收工作区", path: "C:\\Xiu UI Smoke", lock: "available" },
  recent: [{ id: "smoke-workspace", name: "G5C 验收工作区", trusted: true, lastOpenedAt: now() }],
  tasks: [],
};
let sequence = 0;
let task;
let approvalMode = "ask";
let managedWeb = false;
let planMode = false;
let modeContextRevision = 1;
let activeProviderId = "openai";
let activeModel = "gpt-5";
const activeCapabilityModels = {
  openai: { vision: "gpt-5", image: "gpt-image-1", video: "sora-2", audio: "gpt-4o-mini-tts" },
  agnes: { vision: "agnes-2.5-flash", image: "agnes-image-2.1-flash", video: "agnes-video-v2.0" },
};
let terminal = { state: "idle" };
let recoveryActive = false;
const workspaceListeners = new Set();
const runtimeListeners = new Set();
const terminalListeners = new Set();
const browserListeners = new Set();
const calls = [];
let onboardingSnapshot;
let providerRecoveryConfirm = false;
let providerRecoveryState = { contextId: "fixture-recovery-context", restartRequired: false,
  diagnostics: { supportedVersion: 5, sourceVersion: null, state: "invalid", backups: [{ id: "12345678-1234-1234-1234-123456789abc", sourceVersion: 4, reason: "upgrade", createdAt: "2026-10-01T00:00:00.000Z" }], issues: ["invalid-settings"], compatibilityNotice: "Upgrade CLI and desktop together." } };
const providerRecoveryView = () => JSON.parse(JSON.stringify(providerRecoveryState));
let mcp = { servers: [
  { name: "smoke", origin: "user:smoke", transport: "stdio", state: "permission-required", tools: 0, approved: false, permissions: ["process:execute", "external:write"], added: ["process:execute", "external:write"], fingerprint: "a".repeat(64), removable: true, editable: { name: "smoke", fingerprint: "a".repeat(64), transport: "stdio", command: "node", args: [], risk: "execute" } },
  { name: "secure", origin: "user:secure", transport: "streamable-http", state: "auth-required", tools: 0, approved: true, permissions: ["network:access", "credentials:access"], added: [], fingerprint: "b".repeat(64), oauth: true },
] };
const mcpView = () => JSON.parse(JSON.stringify(mcp));

const runtime = () => ({ runtime: { snapshot: { schemaVersion: 1, sequence, generatedAt: now(), planMode, ...(task ? { task } : {}) }, events: [], resyncRequired: false }, conversationId: task?.id, provider: { id: activeProviderId, label: activeProviderId === "openai" ? "OpenAI" : "Agnes", model: activeModel }, writer: "available", approvalMode, modeContextId: `smoke-mode-context-${modeContextRevision}` });
const emit = (type, payload) => {
  sequence += 1;
  const event = { schemaVersion: 1, eventId: `event-${sequence}`, taskId: task.id, sequence, timestamp: now(), type, payload };
  for (const listener of runtimeListeners) listener(event);
};
const report = { view: "workspace", git: true, capturedAt: now(), changes: [{ path: "src/example.ts", kind: "modified", source: "unknown", preExisting: false, staged: false, preview: "@@ -1 +1 @@\n-old\n+new", limitations: [] }], preExisting: [], complete: true, warnings: [] };
const compactReview = { tools: [{ id: "data-tool-1", name: "read_file", status: "succeeded", durationMs: 31, evidence: "compact-detail-canary\n" + "saved detail\n".repeat(50) }], validations: [{ id: "data-verify-1", name: "verify_output", status: "succeeded", evidence: "verification-canary" }], background: [{ id: "data-process-1", command: "node dev-server.mjs", state: "running", elapsedMs: 1200, outputBytes: 40 }], artifacts: [{ path: "src/example.ts", kind: "modified" }] };
const review = () => ({ generatedAt: now(), changeView: "workspace", changes: report, files: [{ path: "src/example.ts", kind: "text", bytes: 8 }], commands: [], ...compactReview, checkpoints: [{ id: "checkpoint-1", createdAt: now(), tool: "write_file", description: "修改前恢复点", files: [{ path: "src/example.ts", existed: true }] }], ...(recoveryActive ? { recovery: { runId: "recovery-1", taskPreview: "异常中断任务", status: "recoverable", recommendation: "先核验未知副作用，再决定是否恢复。", unknownOperations: [{ id: "op-unknown", kind: "command", name: "external command", status: "unknown", sideEffect: "unknown", startedAt: now() }] } } : {}) });
const providers = () => onboardingSnapshot ?? ({ activeProviderId, activeModel, modelProviderId: activeProviderId, profiles: [
  { id: "openai", name: "OpenAI", kind: "openai", defaultModel: "gpt-5", selectedModel: activeProviderId === "openai" ? activeModel : "gpt-5", builtin: true, apiKeyEnv: "OPENAI_API_KEY", credential: { source: "environment", configured: true, editable: false }, capabilityModels: { ...activeCapabilityModels.openai }, features: { tools: true, vision: true, image: true, video: true, audio: true } },
  { id: "agnes", name: "Agnes", kind: "agnes", defaultModel: "agnes-3.0-flash", selectedModel: "agnes-3.0-flash", builtin: true, apiKeyEnv: "AGNES_API_KEY", credential: { source: "environment", configured: true, editable: false }, capabilityModels: { ...activeCapabilityModels.agnes }, features: { tools: true, vision: true, image: true, video: true, audio: false } },
], models: [{ id: activeModel, source: "current", contextWindow: 128000 }], modelsByProvider: { openai: [{ id: "gpt-5", source: "builtin", contextWindow: 128000 }], agnes: [{ id: "agnes-3.0-flash", source: "builtin", contextWindow: 128000 }] }, capabilityModelsByProvider: { openai: { vision: [{ id: "gpt-5", source: "builtin" }], image: [{ id: "gpt-image-1", source: "builtin" }], video: [{ id: "sora-2", source: "builtin" }], audio: [{ id: "gpt-4o-mini-tts", source: "builtin" }] }, agnes: { vision: [{ id: "agnes-2.5-flash", source: "builtin" }], image: [{ id: "agnes-image-2.1-flash", source: "builtin" }], video: [{ id: "agnes-video-v2.0", source: "builtin" }], audio: [] } } });

const bridge = {
  browser: async (request) => { calls.push(`browser:${request.action}`); if (request.action === "layout") calls.push(`browser:visible:${request.visible}`); return { url: request.action === "navigate" ? request.url : "", title: "新网页", loading: false, canGoBack: false, canGoForward: false }; },
  onBrowserState: (listener) => { browserListeners.add(listener); return () => browserListeners.delete(listener); },
  mcpSnapshot: async () => mcpView(),
  managementSnapshot: async () => ({ revision: "fixture-revision", providers: [{ id: "openai", name: "OpenAI", fallback: [] }, { id: "agnes", name: "Agnes", fallback: [] }], routing: { enabled: false, phases: {} }, web: { enabled: false, provider: "searxng", endpoint: managedWeb ? "https://search.jingran.vip" : "https://search.example.test", managed: managedWeb }, skills: [{ name: "fixture-skill", description: "Local fixture", scope: "global", permissions: ["instructions:load"], warnings: [] }] }),
  changeManagement: async (request) => {
    calls.push(`management:${request.action}`);
    if (request.action === "web") {
      if (request.mode === "managed" && (request.endpoint !== "https://search.jingran.vip" || request.provider !== "searxng" || request.apiKeyEnv)) throw new Error("Invalid managed search request");
      managedWeb = request.mode === "managed";
      calls.push(`management:web:${request.mode}`);
    }
    approvalMode = "ask"; return runtime();
  },
  prepareSkillInstallation: async (kind) => { calls.push(`skill-prepare:${kind}`); return { revision: "fixture-revision", token: "fixture-preview", digest: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z", skills: [{ name: "new-fixture", permissions: ["instructions:load"] }] }; },
  cancelSkillInstallation: async () => { calls.push("skill:cancel"); },
  taskDiagnostics: async () => ({ report: "本机执行报告 fixture", diagnostics: "本机诊断 fixture" }),
  approveMcp: async ({ name, fingerprint, confirmed }) => { const server=mcp.servers.find(s=>s.name===name); if (!confirmed || fingerprint !== server?.fingerprint) throw new Error("bad confirmation"); calls.push(`mcp:approve:${name}`); server.approved=true; server.added=[]; server.state="disconnected"; return mcpView(); },
  reloadMcp: async () => { calls.push("mcp:reload"); for (const server of mcp.servers) if(server.approved && !server.oauth) { server.state="connected"; server.tools=2; } return mcpView(); },
  disconnectMcp: async () => { calls.push("mcp:disconnect"); for (const server of mcp.servers) {server.state="disconnected"; server.tools=0;} return mcpView(); },
  manageMcp: async (request) => {
    calls.push(`mcp:${request.action}:${request.draft?.name ?? request.name ?? request.flowId}`);
    if(request.action==="save") { const draft=request.draft; const server={ name:draft.name, origin:`user:${draft.name}`, transport:draft.transport, state:"permission-required", tools:0, approved:false, permissions:["process:execute"], added:["process:execute"], fingerprint:"c".repeat(64), editable:{...draft,fingerprint:"c".repeat(64)},removable:true }; mcp.servers=mcp.servers.filter(s=>s.name!==draft.name).concat(server); }
    if(request.action==="delete") mcp.servers=mcp.servers.filter(s=>s.name!==request.name);
    if(request.action==="login") mcp.oauthFlow={id:"ui-oauth",name:request.name,state:"confirmation",issuer:"https://auth.test",resource:"https://mcp.test",scopes:["read"],callback:"http://127.0.0.1:53122"};
    if(request.action==="oauth-decision") mcp.oauthFlow={...mcp.oauthFlow,state:request.allowed?"waiting":"cancelled",browserOpened:false,authorizationUrl:"https://auth.test/authorize?state=ui-test"};
    if(request.action==="oauth-cancel") mcp.oauthFlow={...mcp.oauthFlow,state:"cancelled"};
    return mcpView();
  },
  browseMcp: async ({name,action}) => { calls.push(`mcp:browse:${action}`); return {server:name, content:"external-resource-canary", warning:"untrusted"}; },
  snapshot: async () => workspace,
  chooseWorkspace: async () => workspace,
  closeWorkspace: async () => workspace,
  openRecentWorkspace: async () => workspace,
  removeRecentWorkspace: async () => workspace,
  trustWorkspace: async () => workspace,
  runtimeConnect: async () => runtime(),
  createTask: async ({ text }) => {
    const approval = { id: "approval-1", description: "写入验收文件", risk: "write", preview: "src/example.ts", sessionScope: "workspace-files:write", scope: "once", effects: ["修改工作区文件"], recovery: "可从检查点恢复", requestedAt: now() };
    task = { id: "smoke-task", state: "waiting_approval", taskPreview: text, startedAt: now(), updatedAt: now(), pendingApproval: approval };
    calls.push("task:create");
    return runtime();
  },
  continueTask: async ({ text }) => bridge.createTask({ text }),
  newConversation: async () => { task = undefined; sequence = 0; return runtime(); },
  steerTask: async ({ text }) => { calls.push("task:steer"); emit("task.steered", { text }); return true; },
  stopTask: async () => { calls.push("task:stop"); recoveryActive = true; task = { ...task, state: "cancelled", updatedAt: now() }; emit("task.finished", { state: "cancelled", error: "用户已停止" }); return true; },
  setApprovalMode: async ({ mode }) => { approvalMode = mode; calls.push(`approval-mode:${mode}`); return runtime(); },
  setPlanMode: async ({ enabled, contextId }) => {
    if (contextId !== `smoke-mode-context-${modeContextRevision}`) throw new Error("stale Plan mode context");
    if (task && ["running", "waiting_approval", "stopping"].includes(task.state)) throw new Error("Plan mode requires an idle task");
    planMode = enabled;
    modeContextRevision += 1;
    calls.push(`plan-mode:${enabled}`);
    return runtime();
  },
  decideApproval: async ({ approvalId, allowed }) => {
    calls.push(`approval:${allowed}`);
    task = { ...task, state: "running", pendingApproval: undefined, updatedAt: now() };
    emit("approval.decided", { approvalId, allowed, source: "handler" });
    for (let turn = 1; turn <= 30; turn += 1) {
      emit("model.started", { turn });
      emit("assistant.message", { text: `第 ${turn} 轮公开进展`, hasToolCalls: turn < 30 });
    }
    calls.push("long-task:30-turns"); emit("tool.started", { name: "read_file", operationId: "source-1", description: "source-detail-canary\n" + "saved source\n".repeat(50) });
    emit("subagent.updated", { agent: { id: "run:child", runId: "run", title: "调查任务验收", role: "explorer", status: "completed", startedAt: now(), completedAt: now(), durationMs: 1200, result: "child-result-canary" } });
  },
  openTaskHistory: async () => { throw new Error("not used"); },
  deleteTask: async () => workspace,
  chooseAttachments: async () => ({ insertText: "", attachments: [] }),
  pasteAttachments: async () => ({ insertText: "", attachments: [] }),
  importAttachments: async () => ({ insertText: "", attachments: [] }),
  reviewSnapshot: async ({ changeView = "workspace" } = {}) => ({ ...review(), changeView, changes: { ...report, view: changeView }, changeRounds: [{ id: "old-round", startedAt: now(), report: { ...report, changes: [{ ...report.changes[0], preview: "@@ -1 +1 @@\n-old-round\n+round-one-canary" }] } }, { id: "missing-round", startedAt: now() }] }),
  previewFile: async ({ path }) => ({ path, kind: "text", bytes: 8, source: "old\nnew\n", truncated: false }),
  restoreCheckpoint: async ({ checkpointId }) => { calls.push(`restore:${checkpointId}`); return review(); },
  recoverTask: async () => runtime(),
  abandonRecovery: async () => review(),
  providerRecovery: async (request) => {
    calls.push(`provider-recovery:${request.action}`);
    if (request.action === "snapshot" || request.action === "cancel") providerRecoveryState.preview = undefined;
    else if (request.action === "preview") providerRecoveryState.preview = { action: "restore-backup", token: "fixture-recovery-token", backupId: request.backupId, sourceVersion: 4, currentVersion: null, expiresAt: "2026-10-01T00:05:00.000Z", warnings: ["Close other Xiu clients. Restart after recovery."] };
    else if (request.action === "recover") {
      calls.push(`provider-recovery:native-confirm:${providerRecoveryConfirm}`);
      providerRecoveryState.preview = undefined;
      if (providerRecoveryConfirm) providerRecoveryState.restartRequired = true;
    }
    return providerRecoveryView();
  },
  providerSnapshot: async () => providers(),
  discoverProviderModels: async () => providers(),
  selectProvider: async ({ providerId, model, capability }) => { activeProviderId = providerId; if (capability) { activeCapabilityModels[providerId][capability] = model; calls.push(`provider:${providerId}/${capability}/${model}`); } else { activeModel = model; calls.push(`provider:${providerId}/${model}`); } return { settings: providers(), connection: runtime() }; },
  saveProviderCredential: async () => ({ settings: providers(), connection: runtime() }),
  testProvider: async () => ({ ok: true, message: "连接成功", modelsDiscovered: 1 }),
  upsertProvider: async (request) => {
    if (onboardingSnapshot) {
      activeProviderId = request.id; activeModel = request.model;
      onboardingSnapshot = { ...onboardingSnapshot, activeProviderId, activeModel, modelProviderId: activeProviderId,
        profiles: [{ ...request, defaultModel: request.model, selectedModel: request.model, builtin: false, credential: { source: "missing", configured: false, editable: true } }] };
      calls.push(`onboarding:add:${request.id}`);
    }
    return { settings: providers(), connection: runtime() };
  },
  deleteProvider: async ({ providerId }) => {
    if (onboardingSnapshot) { onboardingSnapshot = { ...onboardingSnapshot, profiles: [], activeProviderId: "", activeModel: "", modelProviderId: "" }; activeProviderId = ""; activeModel = ""; calls.push(`onboarding:delete:${providerId}`); }
    return { settings: providers(), connection: runtime() };
  },
  terminalSnapshot: async () => terminal,
  startTerminal: async ({ cols = 80, rows = 24 } = {}) => { terminal = { state: "running", sessionId: "terminal-1", shell: "PowerShell", cols, rows, output: "PS C:\\Xiu UI Smoke> " }; calls.push("terminal:start"); return terminal; },
  writeTerminal: async ({ data }) => { calls.push(`terminal:write:${data}`); },
  resizeTerminal: async ({ cols, rows }) => { terminal = { ...terminal, cols, rows }; return terminal; },
  stopTerminal: async () => { terminal = { state: "exited", sessionId: "terminal-1", shell: "PowerShell", cols: terminal.cols, rows: terminal.rows, exitCode: 0 }; calls.push("terminal:stop"); return terminal; },
  onSnapshot: (listener) => { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); },
  onRuntimeEvent: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
  onTerminalEvent: (listener) => { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
};

contextBridge.exposeInMainWorld("xiuDesktop", Object.freeze(bridge));
contextBridge.exposeInMainWorld("xiuSmoke", Object.freeze({ calls: () => [...calls],
  recoveryConfirmation: (confirmed) => { providerRecoveryConfirm = confirmed; },
  recoveryWorkspace: (selected) => { const value = selected ? workspace : { bridgeVersion: 1, trust: "none", recent: [], tasks: [] }; for (const listener of workspaceListeners) listener(value); },
  emitBrowser: (state) => { for (const listener of browserListeners) listener(state); }, freshProviders: () => {
  const templates = providers().profiles.map((profile) => ({ id: profile.id, name: profile.name, kind: profile.kind, model: profile.defaultModel, capabilityModels: profile.capabilityModels, features: profile.features }));
  onboardingSnapshot = { activeProviderId: "", activeModel: "", modelProviderId: "", profiles: [], models: [], modelsByProvider: {}, capabilityModelsByProvider: {}, templates };
  activeProviderId = ""; activeModel = "";
} }));
