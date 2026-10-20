import assert from "node:assert/strict";
import test from "node:test";
import { providerIpcChannels, registerProviderIpc, type ProviderIpcContext } from "../apps/desktop/main/ipc-provider.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };

function harness(options: { workspace?: string; visionModels?: string[] } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  const settings = { activeProviderId: "p", activeModel: "m" };
  const connection = { writer: "available" };
  const providers = {
    refresh: async () => { calls.push("providers.refresh"); return settings; },
    discover: async (workspace: string, request: unknown) => { calls.push(`providers.discover:${workspace}:${JSON.stringify(request)}`); return settings; },
    select: async (request: unknown) => { calls.push(`providers.select:${JSON.stringify(request)}`); return settings; },
    saveCredential: async (request: unknown) => { calls.push(`providers.saveCredential:${JSON.stringify(request)}`); return settings; },
    manageCredential: async (request: unknown) => { calls.push(`providers.manageCredential:${JSON.stringify(request)}`); return settings; },
    test: async (workspace: string, request: unknown) => { calls.push(`providers.test:${workspace}:${JSON.stringify(request)}`); return { ok: true }; },
    upsert: async (request: unknown) => { calls.push(`providers.upsert:${JSON.stringify(request)}`); return settings; },
    delete: async (request: unknown) => { calls.push(`providers.delete:${JSON.stringify(request)}`); return settings; },
    visionProbeConfig: (_workspace: string, request: { providerId: string; model: string }) => { calls.push(`providers.visionProbeConfig:${request.model}`); return { model: request.model, apiKeyEnv: "X_KEY" }; },
    snapshot: (providerId: string) => ({ capabilityModelsByProvider: { [providerId]: { vision: (options.visionModels ?? []).map((id) => ({ id })) } } }),
  };
  const ctx: ProviderIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    serializeWriterStart: async (operation) => { calls.push("writer"); return operation(); },
    trustedWorkspacePath: () => { calls.push("workspace"); if (!options.workspace) throw new Error("no trusted workspace"); return options.workspace; },
    providers: async () => providers as never,
    tasks: {
      assertCanReconfigure: async (workspace: string) => { calls.push(`tasks.assertCanReconfigure:${workspace}`); },
      reload: async (workspace: string) => { calls.push(`tasks.reload:${workspace}`); return connection as never; },
      connect: async () => { calls.push("tasks.connect"); return { runtime: { snapshot: { planMode: false } } } as never; },
    } as never,
    visionProbe: {
      cancel: () => { calls.push("vision.cancel"); },
      snapshot: () => { calls.push("vision.snapshot"); return { total: 3, results: [] }; },
      run: async () => { calls.push("vision.run"); return { ok: true } as never; },
      runBatch: async () => { calls.push("vision.runBatch"); return { total: 0, results: [] } as never; },
    },
    mainWindow: () => undefined,
    confirmVisionProbe: async () => { calls.push("confirm"); return true; },
  };
  registerProviderIpc(ctx);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke, settings, connection };
}

test("the provider page registers exactly its channels and every handler refuses an untrusted sender first", async () => {
  const { calls, handlers, invoke } = harness({ workspace: "/ws" });
  assert.deepEqual([...handlers.keys()].sort(), [...providerIpcChannels].sort());
  assert.equal(handlers.size, 11);
  for (const channel of providerIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, { providerId: "p", model: "m" }), /untrusted sender/, channel);
    assert.deepEqual(calls.filter((call) => call.startsWith("providers.") || call.startsWith("tasks.") || call.startsWith("vision.")), [], `${channel} touched state for an untrusted sender`);
  }
});

test("configuration writes run on the writer queue, check reconfiguration and reload the workspace runtime", async () => {
  const { calls, invoke, settings, connection } = harness({ workspace: "/ws" });
  const writes: Array<[string, string, Record<string, string>]> = [
    [desktopChannels.providerSelect, "select", { providerId: "p", model: "m" }],
    [desktopChannels.providerCredentialSave, "saveCredential", { providerId: "p", apiKey: "k" }],
    [desktopChannels.providerCredentialManage, "manageCredential", { providerId: "p", action: "clear" }],
    [desktopChannels.providerUpsert, "upsert", { id: "custom", label: "Custom" }],
    [desktopChannels.providerDelete, "delete", { providerId: "custom" }],
  ];
  for (const [channel, method, request] of writes) {
    calls.length = 0;
    const result = await invoke(channel, trusted, request);
    assert.deepEqual(result, { settings, connection }, channel);
    assert.deepEqual(calls, ["writer", "trust", "workspace", "tasks.assertCanReconfigure:/ws", `providers.${method}:${JSON.stringify(request)}`, "tasks.reload:/ws"], channel);
  }
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.providerTest, trusted, { providerId: "p" }), { ok: true });
  assert.deepEqual(calls, ["writer", "trust", "workspace", "tasks.assertCanReconfigure:/ws", 'providers.test:/ws:{"providerId":"p"}']);
});

test("reads need a trusted workspace but no writer queue, and the vision probe is reached directly", async () => {
  const { calls, invoke, settings } = harness({ workspace: "/ws" });
  assert.deepEqual(await invoke(desktopChannels.providerSnapshot, trusted), settings);
  assert.deepEqual(calls, ["trust", "workspace", "providers.refresh"]);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.providerModels, trusted, { providerId: "p" }), settings);
  assert.deepEqual(calls, ["trust", "workspace", 'providers.discover:/ws:{"providerId":"p"}']);
  calls.length = 0;
  assert.deepEqual(await invoke(desktopChannels.providerVisionProgress, trusted), { total: 3, results: [] });
  await invoke(desktopChannels.providerVisionCancel, trusted);
  assert.deepEqual(calls, ["trust", "vision.snapshot", "trust", "vision.cancel"]);
  const closed = harness();
  await assert.rejects(() => closed.invoke(desktopChannels.providerSnapshot, trusted), /no trusted workspace/);
  assert.deepEqual(closed.calls, ["trust", "workspace"]);
});

test("a batch vision test needs 1–200 candidates and starts no probe without them", async () => {
  const { calls, invoke } = harness({ workspace: "/ws", visionModels: [] });
  await assert.rejects(() => invoke(desktopChannels.providerVisionTest, trusted, { providerId: "p", model: "m", allCandidates: true }), /1–200/);
  assert.deepEqual(calls.slice(0, 4), ["writer", "trust", "workspace", "providers.refresh"]);
  assert.ok(!calls.some((call) => call.startsWith("vision.run")));
  const many = harness({ workspace: "/ws", visionModels: Array.from({ length: 201 }, (_, index) => `v-${index}`) });
  await assert.rejects(() => many.invoke(desktopChannels.providerVisionTest, trusted, { providerId: "p", model: "m", allCandidates: true }), /1–200/);
  assert.ok(!many.calls.some((call) => call.startsWith("vision.run")));
});
