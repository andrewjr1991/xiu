import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";
import { WorkspaceMcpService } from "../src/runtime/mcp-service.js";
import { McpAuthStore, type McpAuthSecretRecord } from "../src/mcp-auth-store.js";
import { CredentialStoreError } from "../src/credential-store.js";
import { SystemCredentialStore } from "../src/system-credential-store.js";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { TaskRunJournal } from "../src/task-run.js";
import { Agent } from "../src/agent.js";
import { TaskPlanManager } from "../src/plan.js";
import type { AgentTool, ModelProvider } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

async function setup(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-mcp-"));
  const file = path.join(root, "user-mcp.json");
  const config = { command: process.execPath, args: [fixture], risk: "read", toolRisks: { change: "dangerous" } };
  const save = (value = config) => fs.writeFile(file, JSON.stringify({ mcpServers: { test: value } }));
  await save();
  const manager = new McpManager(root, file);
  let tools: AgentTool[] = [];
  const service = new WorkspaceMcpService(manager, () => { tools = manager.tools(); });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, config, save, manager, service, tools: () => tools };
}

test("desktop MCP reads without spawning, explicitly grants exact configuration, connects and disconnects real stdio tools", async (t) => {
  const { root, service, tools } = await setup(t);
  const first = (await service.snapshot()).servers[0]!;
  assert.equal(first.state, "permission-required");
  assert.equal(first.tools, 0);
  assert.equal(tools().length, 0);
  assert.equal((await service.reload()).servers[0]?.state, "permission-required");
  await service.approve(first.name, first.fingerprint);
  assert.equal((await service.snapshot()).servers[0]?.state, "disconnected");
  assert.equal(tools().length, 0, "grant is not a connection or tool execution");
  assert.equal((await service.reload()).servers[0]?.state, "connected");
  assert.equal(tools().length, 3);
  assert.equal(await tools()[0]!.execute({ message: "desktop" }, { cwd: root, approve: async () => false }), "echo:desktop");
  await service.close();
  assert.equal(tools().length, 0);
  assert.equal((await service.snapshot()).servers[0]?.state, "disconnected");
});

test("MCP confirmation rejects configuration edits, not only added permissions, in both frontends", async (t) => {
  const { config, save, manager, service } = await setup(t);
  const first = (await service.snapshot()).servers[0]!;
  await save({ ...config, args: [fixture, "changed-target"] });
  await assert.rejects(service.approve(first.name, first.fingerprint), /changed since permission preview/);
  await assert.rejects(manager.approvePermissions(first.name, true, first.fingerprint), /changed since permission preview/);
  const changed = (await service.snapshot()).servers[0]!;
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(changed.approved, false);
  assert.equal(manager.tools().length, 0);
});

test("MCP shutdown waits for in-flight connection setup and leaves no registered tools", async (t) => {
  const { service, manager, tools } = await setup(t);
  await service.approve("test", (await service.snapshot()).servers[0]!.fingerprint);
  const connecting = service.reload();
  const closing = service.close();
  await Promise.all([connecting, closing]);
  assert.equal(tools().length, 0);
  assert.deepEqual(manager.connectedServerNames(), []);
});

test("MCP snapshot never exposes config or credentials and failed reload removes stale tools", async (t) => {
  const { file, config, save, service, tools } = await setup(t);
  const canary = "unusual-mcp-secret-49281";
  await save({ ...config, env: { SECRET: canary } } as typeof config);
  const snapshot = await service.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes(canary));
  assert.ok(!JSON.stringify(snapshot).includes(process.execPath));
  await service.approve("test", snapshot.servers[0]!.fingerprint);
  await service.reload();
  assert.equal(tools().length, 3);
  await fs.writeFile(file, "{invalid");
  await assert.rejects(service.reload());
  assert.equal(tools().length, 0);
});

test("MCP tools use real Agent danger approval and Plan read-only boundaries", async (t) => {
  const { root, service, tools } = await setup(t);
  await service.approve("test", (await service.snapshot()).servers[0]!.fingerprint);
  await service.reload();
  for (const planMode of [false, true]) {
    let calls = 0;
    const approvals: string[] = [];
    const provider: ModelProvider = { async complete(_system, messages) {
      if (++calls === 1) return { text: "try", toolCalls: [{ id: "call", name: "mcp__test__change", input: {} }], raw: {} };
      assert.match(messages.at(-1)?.content ?? "", planMode ? /plan mode is read-only/ : /denied|declined/i);
      return { text: "done", toolCalls: [], raw: {} };
    } };
    const agent = new Agent({
      config: { provider: "openai", providerId: "openai", model: "test", cwd: root, maxTurns: 3, autoApprove: false },
      provider,
      tools: tools(),
      approve: async (request) => { approvals.push(request.risk); return false; },
      events: {},
      planManager: new TaskPlanManager(undefined, planMode),
    });
    assert.equal(await agent.run("test boundary"), "done");
    assert.deepEqual(approvals, planMode ? [] : ["dangerous"]);
  }
});

test("desktop MCP lifecycle drains old host before creating a new workspace host", async (t) => {
  const { root } = await setup(t);
  const order: string[] = [];
  const controller = new DesktopTaskController(() => {}, async (workspace) => {
    order.push(`open:${workspace}`);
    return { runtime: new XiuRuntime(), journal: new TaskRunJournal(workspace, path.join(root, "journals")),
      provider: { id: "test", label: "Test", model: "test" },
      close: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); order.push(`close:${workspace}`); },
    };
  });
  await controller.connect(root);
  controller.detach();
  await controller.connect(path.join(root, "next"));
  assert.deepEqual(order, [`open:${root}`, `close:${root}`, `open:${path.join(root, "next")}`]);
  await controller.shutdown();
  assert.equal(order.at(-1), `close:${path.join(root, "next")}`);
});

test("desktop MCP changes fail closed under external writer lock and malformed confirmation", async (t) => {
  const { root, service } = await setup(t);
  const journal = new TaskRunJournal(root, path.join(root, "journals"));
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime: new XiuRuntime(), mcp: service,
    journal, provider: { id: "test", label: "Test", model: "test" }, close: () => service.close() }));
  const first = (await controller.mcpSnapshot(root)).servers[0]!;
  await assert.rejects(controller.changeMcp(root, "approve", { name: "test", fingerprint: first.fingerprint, confirmed: false } as never), /未完成/);
  assert.equal((await service.snapshot()).servers[0]?.approved, false);
  await journal.begin({ sessionId: "external", task: "external", model: "test", providerId: "openai" });
  await assert.rejects(controller.changeMcp(root, "reload"), /另一个 Xiu 进程/);
  await journal.complete("completed");
  await controller.shutdown();
});

test("desktop MCP user editor saves without granting, preserves other entries and rejects stale/project/advanced edits", async (t) => {
  const { root, file, service } = await setup(t);
  const draft = { name: "editable", transport: "stdio" as const, command: process.execPath, args: [fixture], risk: "read" as const };
  const first = await service.save(draft);
  const entry = first.servers.find((item) => item.name === draft.name)!;
  assert.equal(entry.approved, false);
  assert.equal(entry.state, "permission-required");
  assert.ok(entry.editable);
  assert.equal(first.servers.find((item) => item.name === "test")?.editable, undefined);
  await assert.rejects(service.save(draft), /changed/);
  await service.approve(entry.name, entry.fingerprint);
  await service.reload();
  const changed = await service.save({ ...entry.editable!, risk: "execute" });
  assert.equal(changed.servers.find((item) => item.name === draft.name)?.approved, false);
  assert.deepEqual(service.manager.connectedServerNames(), []);
  await assert.rejects(service.save(entry.editable!), /changed/);
  // Sampling is a basic-editor field: turning it on adds model:sampling, revokes the grant and keeps the entry editable.
  const current = changed.servers.find((item) => item.name === draft.name)!;
  assert.equal(current.editable?.sampling, undefined);
  await service.approve(current.name, current.fingerprint);
  const sampling = (await service.save({ ...current.editable!, sampling: true })).servers.find((item) => item.name === draft.name)!;
  assert.equal(sampling.editable?.sampling, true);
  assert.equal(sampling.details.sampling, true);
  assert.ok(sampling.permissions.includes("model:sampling"));
  assert.deepEqual(sampling.added, ["model:sampling"]);
  assert.equal(sampling.approved, false);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.editable.sampling, true);
  const off = (await service.save({ ...sampling.editable!, sampling: false })).servers.find((item) => item.name === draft.name)!;
  assert.equal(off.editable?.sampling, undefined);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.editable.sampling, undefined, "off removes the key instead of writing false");
  await assert.rejects(service.save({ ...off.editable!, sampling: "yes" as never }), /sampling/);
  await assert.rejects(service.save({ ...draft, name: "test", fingerprint: first.servers[0]!.fingerprint }), /read-only/);
  await fs.mkdir(path.join(root, ".xiu"), { recursive: true });
  await fs.writeFile(path.join(root, ".xiu", "mcp.json"), JSON.stringify({ mcpServers: { project: { command: process.execPath, args: [fixture] } } }));
  await assert.rejects(service.save({ ...draft, name: "project" }), /read-only/);
  const final = (await service.snapshot()).servers.find((item) => item.name === draft.name)!;
  await assert.rejects(service.remove(final.name, final.fingerprint, false), /confirmation/);
  await service.remove(final.name, final.fingerprint, true);
  assert.ok(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.test);
  assert.equal((await service.snapshot()).servers.some((item) => item.name === draft.name), false);
});

test("desktop MCP editor rejects inline credentials and does not export secret-bearing or advanced configurations", async (t) => {
  const { root, file, service } = await setup(t);
  const draft = { name: "remote", transport: "streamable-http" as const, risk: "read" as const };
  for (const url of ["https://user:pass@service.example/mcp", "https://service.example/mcp?api_key=canary"]) await assert.rejects(service.save({ ...draft, url }));
  await assert.rejects(service.save({ name: "local", transport: "stdio", risk: "read", command: "node", args: ["--api-key", "opaque-canary-value"] }));
  await assert.rejects(service.save({ name: "local", transport: "stdio", risk: "read", command: "node", args: {} as never }));
  await fs.writeFile(file, JSON.stringify({ mcpServers: { private: { url: "https://service.example/mcp", headers: { Authorization: "Bearer opaque-canary-value" }, toolRisks: { wipe: "dangerous" }, permissions: ["network:access", "credentials:access", "external:write"] }, local: { command: process.execPath, args: [fixture], env: { PRIVATE_TOKEN: "opaque-env-canary" }, cwd: root } } }));
  const snapshot = await service.snapshot();
  assert.equal(snapshot.servers[0]?.editable, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /opaque-canary-value|opaque-env-canary|service.example/);
  // The read-only summary names fields, never values.
  assert.deepEqual(snapshot.servers[0]?.details, { enabled: true, risk: "execute", env: [], headers: ["Authorization"], cwd: false, toolRisks: { wipe: "dangerous" }, changesWorkspace: undefined, toolChangesWorkspace: {}, permissionsDeclared: true, sampling: false });
  assert.deepEqual(snapshot.servers[1]?.details, { enabled: true, risk: "execute", args: 1, env: ["PRIVATE_TOKEN"], headers: [], cwd: true, toolRisks: {}, changesWorkspace: undefined, toolChangesWorkspace: {}, permissionsDeclared: false, sampling: false });
  assert.equal(snapshot.servers[1]?.editable, undefined, "env and cwd are advanced fields the basic editor does not expose");
  assert.equal(snapshot.servers[0]?.origin, "user");
  const saved = await service.save({ ...draft, url: "https://safe.example/mcp", bearerTokenEnvironment: "XIU_TEST_BEARER" });
  assert.equal(saved.servers.find((item) => item.name === "remote")?.editable?.bearerTokenEnvironment, "XIU_TEST_BEARER");
});

test("desktop MCP Resource and Prompt browsing is bounded, redacted and requires a current approved connection", async (t) => {
  const { service } = await setup(t);
  await assert.rejects(service.browse("test", "resources"), /Connect/);
  await service.approve("test", (await service.snapshot()).servers[0]!.fingerprint);
  await service.reload();
  const catalog = await service.browse("test", "resources") as { templates: Array<{ uriTemplate: string }> };
  assert.match(JSON.stringify(catalog), /Greeting|Second/);
  assert.deepEqual(catalog.templates.map((item) => item.uriTemplate), ["test://docs/{id}"]);
  // Templates expand only from values the user supplied; nothing is guessed and plain URIs take no variables.
  const expanded = await service.browse("test", "read", "test://docs/{id}", { id: "42 a" }) as { uri?: string };
  assert.match(JSON.stringify(expanded), /test:\/\/docs\/42%20a/);
  await assert.rejects(service.browse("test", "read", "test://docs/{id}", {}), /without a value: id/);
  await assert.rejects(service.browse("test", "read", "test://docs/{id}"), /without a value: id/);
  await assert.rejects(service.browse("test", "read", "test://greeting", { id: "1" }), /takes no template variables/);
  await assert.rejects(service.browse("test", "read", "test://docs/{id*}", { id: "1" }), /modifier/);
  assert.match(JSON.stringify(await service.browse("test", "prompts")), /review/);
  const old = process.env.XIU_TEST_SECRET;
  process.env.XIU_TEST_SECRET = "opaque-desktop-mcp-canary";
  try {
    assert.doesNotMatch(JSON.stringify(await service.browse("test", "prompt", "review", { target: process.env.XIU_TEST_SECRET })), /opaque-desktop-mcp-canary/);
    assert.ok(JSON.stringify(await service.browse("test", "read", "test://large")).length < 35_000);
    await assert.rejects(service.browse("test", "read", "x".repeat(9000)));
  } finally { if (old === undefined) delete process.env.XIU_TEST_SECRET; else process.env.XIU_TEST_SECRET = old; }
  await service.close();
  await assert.rejects(service.browse("test", "resources"), /Connect/);
});

class FakeCredentialEntry {
  static values = new Map<string, string>();
  private readonly key: string;
  constructor(service: string, username: string) { this.key = `${service}\0${username}`; }
  setPassword(value: string): void { FakeCredentialEntry.values.set(this.key, value); }
  getPassword(): string | null { return FakeCredentialEntry.values.get(this.key) ?? null; }
  deleteCredential(): boolean { return FakeCredentialEntry.values.delete(this.key); }
}

async function migrationFixture(t: import("node:test").TestContext, options: { systemAvailable?: boolean; expiresAt?: number } = {}) {
  FakeCredentialEntry.values.clear();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-mcp-credentials-"));
  const file = path.join(root, "user-mcp.json");
  await fs.writeFile(file, JSON.stringify({ mcpServers: { secure: { url: "https://mcp.example.com/", auth: { type: "oauth", scopes: ["read"] }, risk: "read" } } }));
  const authStore = new McpAuthStore(path.join(root, "mcp-auth.json"));
  await authStore.save({
    resource: "https://mcp.example.com/", issuer: "https://login.example.com/", clientId: "desktop-client",
    tokens: { access_token: "desktop-access-canary", refresh_token: "desktop-refresh-canary", token_type: "Bearer", scope: "read write" },
    clientInformation: { client_id: "desktop-client", client_secret: "desktop-client-secret-canary" },
    expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
  });
  const manager = new McpManager(root, file, authStore);
  const audits: string[] = [];
  const system = new SystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record">("mcp-oauth-record", FakeCredentialEntry);
  const service = new WorkspaceMcpService(manager, () => {}, undefined, {
    systemCredentials: async () => { if (options.systemAvailable === false) throw new CredentialStoreError("backend-unavailable", "Linux Secret Service is not reachable"); return system; },
    audit: async (action, subject, outcome) => { audits.push(`${action}:${subject}:${outcome}`); },
  });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const server = async () => (await service.snapshot()).servers.find((item) => item.name === "secure")!;
  return { root, authStore, manager, service, audits, server };
}

test("desktop MCP shows token-free OAuth and credential state and runs migrate, cleanup and rollback with the CLI's confirmations", async (t) => {
  const { root, service, audits, server } = await migrationFixture(t);
  const first = await server();
  assert.equal(first.oauth, true);
  assert.deepEqual({ ...first.auth, expiresAt: undefined }, { authenticated: true, expired: false, issuer: "https://login.example.com/", scopes: ["read", "write"], expiresAt: undefined });
  assert.match(first.auth?.expiresAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(first.credentials, { backend: first.credentials!.backend, records: [{ source: "legacy-file", legacyCopyPresent: true, systemCopyPresent: false, interruptedMigration: false }], migratable: true, cleanable: false, rollbackable: false });
  assert.doesNotMatch(JSON.stringify(await service.snapshot()), /canary/, "the snapshot never carries tokens or client secrets");

  // Every operation needs the current fingerprint, the literal confirmation and an eligible record.
  await assert.rejects(service.credentials("migrate", "secure", "0".repeat(64), true), /current configuration confirmation/);
  await assert.rejects(service.credentials("migrate", "secure", first.fingerprint, false), /current configuration confirmation/);
  await assert.rejects(service.credentials("cleanup", "secure", first.fingerprint, true, "secure"), /eligible/);
  await assert.rejects(service.credentials("rollback", "secure", first.fingerprint, true), /eligible/);
  assert.equal(FakeCredentialEntry.values.size, 0);
  assert.deepEqual(audits, []);

  const migrated = (await service.credentials("migrate", "secure", first.fingerprint, true)).servers[0]!;
  assert.equal(migrated.credentials?.records[0]?.source, "system");
  assert.equal(migrated.credentials?.records[0]?.legacyCopyPresent, true, "migration retains the plaintext copy until an explicit cleanup");
  assert.equal(migrated.credentials?.records[0]?.systemCopyPresent, true);
  assert.deepEqual([migrated.credentials?.migratable, migrated.credentials?.cleanable, migrated.credentials?.rollbackable], [false, true, true]);
  assert.equal(FakeCredentialEntry.values.size, 1);
  assert.equal(migrated.auth?.authenticated, true, "the login state is read through the system reference after migration");
  assert.doesNotMatch(JSON.stringify(migrated), /canary/);

  await assert.rejects(service.credentials("cleanup", "secure", first.fingerprint, true), /exact MCP name/);
  await assert.rejects(service.credentials("cleanup", "secure", first.fingerprint, true, "Secure"), /exact MCP name/);
  assert.equal((await server()).credentials?.records[0]?.legacyCopyPresent, true, "a mismatched name deletes nothing");
  const cleaned = (await service.credentials("cleanup", "secure", first.fingerprint, true, "secure")).servers[0]!;
  assert.equal(cleaned.credentials?.records[0]?.legacyCopyPresent, false);
  assert.deepEqual([cleaned.credentials?.cleanable, cleaned.credentials?.rollbackable], [false, true]);
  assert.doesNotMatch(await fs.readFile(path.join(root, "mcp-auth.json"), "utf8"), /canary/, "plaintext is gone from the compatibility file");

  const restored = (await service.credentials("rollback", "secure", first.fingerprint, true)).servers[0]!;
  assert.equal(restored.credentials?.records[0]?.source, "legacy-file");
  assert.equal(restored.credentials?.migratable, true);
  assert.equal(FakeCredentialEntry.values.size, 0);
  assert.equal(restored.auth?.authenticated, true, "rollback restores the token from the system copy");
  assert.deepEqual(audits, ["mcp-migrate:secure:succeeded", "mcp-cleanup:secure:cancelled", "mcp-cleanup:secure:cancelled", "mcp-cleanup:secure:succeeded", "mcp-rollback:secure:succeeded"]);
});

test("desktop MCP credential migration fails closed without a system backend and reports expiry without tokens", async (t) => {
  const unavailable = await migrationFixture(t, { systemAvailable: false, expiresAt: Date.now() - 1_000 });
  const entry = await unavailable.server();
  assert.deepEqual([entry.auth?.authenticated, entry.auth?.expired], [true, true]);
  assert.equal(entry.credentials?.migratable, true);
  await assert.rejects(unavailable.service.credentials("migrate", "secure", entry.fingerprint, true), /unavailable; the migration was not started/);
  assert.equal((await unavailable.server()).credentials?.records[0]?.source, "legacy-file", "nothing moved and nothing was deleted");
  assert.equal(FakeCredentialEntry.values.size, 0);
  assert.deepEqual(unavailable.audits, ["mcp-migrate:secure:failed"]);

  // The desktop controller routes the request through the same service and keeps its error text free of detail.
  const controller = new DesktopTaskController(() => {}, async () => ({ runtime: new XiuRuntime(), mcp: unavailable.service, journal: new TaskRunJournal(unavailable.root, path.join(unavailable.root, "journals")), provider: { id: "test", label: "test", model: "test" }, close: () => unavailable.service.close() }));
  await assert.rejects(controller.manageMcp(unavailable.root, { action: "credentials", operation: "migrate", name: "secure", fingerprint: entry.fingerprint, confirmed: true }), /系统凭据库不可用，操作未开始/);
  await assert.rejects(controller.manageMcp(unavailable.root, { action: "credentials", operation: "cleanup", name: "secure", fingerprint: entry.fingerprint, confirmed: true, typedName: "nope" }), /符合该操作条件|名称不匹配/);
  assert.deepEqual(unavailable.audits, ["mcp-migrate:secure:failed", "mcp-migrate:secure:failed", "mcp-cleanup:secure:cancelled"]);
});
