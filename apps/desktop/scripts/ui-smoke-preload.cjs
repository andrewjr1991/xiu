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
let activeProviderId = "openai";
let activeModel = "gpt-5";
const activeCapabilityModels = {
  openai: { vision: "gpt-5", image: "gpt-image-1", video: "sora-2", audio: "gpt-4o-mini-tts" },
  agnes: { vision: "agnes-2.5-flash", image: "agnes-image-2.1-flash", video: "agnes-video-v2.0" },
};
let terminal = { state: "idle" };
let recoveryActive = false;
const runtimeListeners = new Set();
const terminalListeners = new Set();
const calls = [];
let onboardingSnapshot;

const runtime = () => ({ runtime: { snapshot: { schemaVersion: 1, sequence, generatedAt: now(), ...(task ? { task } : {}) }, events: [], resyncRequired: false }, conversationId: task?.id, provider: { id: activeProviderId, label: activeProviderId === "openai" ? "OpenAI" : "Agnes", model: activeModel }, writer: "available", approvalMode });
const emit = (type, payload) => {
  sequence += 1;
  const event = { schemaVersion: 1, eventId: `event-${sequence}`, taskId: task.id, sequence, timestamp: now(), type, payload };
  for (const listener of runtimeListeners) listener(event);
};
const report = { view: "workspace", git: true, capturedAt: now(), changes: [{ path: "src/example.ts", kind: "modified", source: "unknown", preExisting: false, staged: false, preview: "@@ -1 +1 @@\n-old\n+new", limitations: [] }], preExisting: [], complete: true, warnings: [] };
const review = () => ({ generatedAt: now(), changeView: "workspace", changes: report, files: [{ path: "src/example.ts", kind: "text", bytes: 8 }], commands: [], validations: [], checkpoints: [{ id: "checkpoint-1", createdAt: now(), tool: "write_file", description: "修改前恢复点", files: [{ path: "src/example.ts", existed: true }] }], ...(recoveryActive ? { recovery: { runId: "recovery-1", taskPreview: "异常中断任务", status: "recoverable", recommendation: "先核验未知副作用，再决定是否恢复。", unknownOperations: [{ id: "op-unknown", kind: "command", name: "external command", status: "unknown", sideEffect: "unknown", startedAt: now() }] } } : {}) });
const providers = () => onboardingSnapshot ?? ({ activeProviderId, activeModel, modelProviderId: activeProviderId, profiles: [
  { id: "openai", name: "OpenAI", kind: "openai", defaultModel: "gpt-5", selectedModel: activeProviderId === "openai" ? activeModel : "gpt-5", builtin: true, apiKeyEnv: "OPENAI_API_KEY", credential: { source: "environment", configured: true, editable: false }, capabilityModels: { ...activeCapabilityModels.openai }, features: { tools: true, vision: true, image: true, video: true, audio: true } },
  { id: "agnes", name: "Agnes", kind: "agnes", defaultModel: "agnes-3.0-flash", selectedModel: "agnes-3.0-flash", builtin: true, apiKeyEnv: "AGNES_API_KEY", credential: { source: "environment", configured: true, editable: false }, capabilityModels: { ...activeCapabilityModels.agnes }, features: { tools: true, vision: true, image: true, video: true, audio: false } },
], models: [{ id: activeModel, source: "current", contextWindow: 128000 }], modelsByProvider: { openai: [{ id: "gpt-5", source: "builtin", contextWindow: 128000 }], agnes: [{ id: "agnes-3.0-flash", source: "builtin", contextWindow: 128000 }] }, capabilityModelsByProvider: { openai: { vision: [{ id: "gpt-5", source: "builtin" }], image: [{ id: "gpt-image-1", source: "builtin" }], video: [{ id: "sora-2", source: "builtin" }], audio: [{ id: "gpt-4o-mini-tts", source: "builtin" }] }, agnes: { vision: [{ id: "agnes-2.5-flash", source: "builtin" }], image: [{ id: "agnes-image-2.1-flash", source: "builtin" }], video: [{ id: "agnes-video-v2.0", source: "builtin" }], audio: [] } } });

const bridge = {
  mcpSnapshot: async () => ({ servers: [{ name: "smoke", origin: "user:smoke", transport: "stdio", state: "permission-required", tools: 0, approved: false, permissions: ["process:execute", "external:write"], added: ["process:execute", "external:write"], fingerprint: "a".repeat(64) }] }),
  approveMcp: async ({ name, fingerprint, confirmed }) => { if (!confirmed || fingerprint !== "a".repeat(64)) throw new Error("bad confirmation"); calls.push(`mcp:approve:${name}`); return { servers: [{ name, origin: "user:smoke", transport: "stdio", state: "disconnected", tools: 0, approved: true, permissions: ["process:execute", "external:write"], added: [], fingerprint }] }; },
  reloadMcp: async () => { calls.push("mcp:reload"); return { servers: [{ name: "smoke", origin: "user:smoke", transport: "stdio", state: "connected", tools: 2, approved: true, permissions: ["process:execute", "external:write"], added: [], fingerprint: "a".repeat(64) }] }; },
  disconnectMcp: async () => { calls.push("mcp:disconnect"); return { servers: [] }; },
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
  steerTask: async () => true,
  stopTask: async () => { calls.push("task:stop"); recoveryActive = true; task = { ...task, state: "cancelled", updatedAt: now() }; emit("task.finished", { state: "cancelled", error: "用户已停止" }); return true; },
  setApprovalMode: async ({ mode }) => { approvalMode = mode; calls.push(`approval-mode:${mode}`); return runtime(); },
  decideApproval: async ({ approvalId, allowed }) => {
    calls.push(`approval:${allowed}`);
    task = { ...task, state: "running", pendingApproval: undefined, updatedAt: now() };
    emit("approval.decided", { approvalId, allowed, source: "handler" });
    for (let turn = 1; turn <= 30; turn += 1) {
      emit("model.started", { turn });
      emit("assistant.message", { text: `第 ${turn} 轮公开进展`, hasToolCalls: turn < 30 });
    }
    calls.push("long-task:30-turns");
  },
  openTaskHistory: async () => { throw new Error("not used"); },
  deleteTask: async () => workspace,
  chooseAttachments: async () => ({ insertText: "", attachments: [] }),
  pasteAttachments: async () => ({ insertText: "", attachments: [] }),
  importAttachments: async () => ({ insertText: "", attachments: [] }),
  reviewSnapshot: async ({ changeView = "workspace" } = {}) => ({ ...review(), changeView, changes: { ...report, view: changeView } }),
  previewFile: async ({ path }) => ({ path, kind: "text", bytes: 8, source: "old\nnew\n", truncated: false }),
  restoreCheckpoint: async ({ checkpointId }) => { calls.push(`restore:${checkpointId}`); return review(); },
  recoverTask: async () => runtime(),
  abandonRecovery: async () => review(),
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
  onSnapshot: () => () => {},
  onRuntimeEvent: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
  onTerminalEvent: (listener) => { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
};

contextBridge.exposeInMainWorld("xiuDesktop", Object.freeze(bridge));
contextBridge.exposeInMainWorld("xiuSmoke", Object.freeze({ calls: () => [...calls], freshProviders: () => {
  const templates = providers().profiles.map((profile) => ({ id: profile.id, name: profile.name, kind: profile.kind, model: profile.defaultModel, capabilityModels: profile.capabilityModels, features: profile.features }));
  onboardingSnapshot = { activeProviderId: "", activeModel: "", modelProviderId: "", profiles: [], models: [], modelsByProvider: {}, capabilityModelsByProvider: {}, templates };
  activeProviderId = ""; activeModel = "";
} }));
