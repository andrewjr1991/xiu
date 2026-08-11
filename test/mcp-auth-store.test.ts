import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpAuthStore, type McpAuthIdentity, type McpAuthSecretRecord } from "../src/mcp-auth-store.js";
import { WindowsSystemCredentialStore } from "../src/system-credential-store.js";

class FakeCredentialEntry {
  static values = new Map<string, string>();
  private readonly key: string;
  constructor(service: string, username: string) { this.key = `${service}\0${username}`; }
  setPassword(value: string): void { FakeCredentialEntry.values.set(this.key, value); }
  getPassword(): string | null { return FakeCredentialEntry.values.get(this.key) ?? null; }
  deleteCredential(): boolean { return FakeCredentialEntry.values.delete(this.key); }
}

function fakeSystemStore(): WindowsSystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record"> {
  return new WindowsSystemCredentialStore("mcp-oauth-record", FakeCredentialEntry);
}

const first: McpAuthIdentity = {
  resource: "https://mcp.example.com/",
  issuer: "https://login.example.com/",
  clientId: "xiu-client-a",
};

test("MCP auth store persists versioned credentials bound to resource, issuer, and client", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-store-"));
  const file = path.join(directory, "mcp-auth.json");
  const store = new McpAuthStore(file);
  const second = { ...first, issuer: "https://accounts.example.net/" };
  try {
    await store.save({
      ...first,
      tokens: { access_token: "access-a", refresh_token: "refresh-a", token_type: "Bearer", scope: "files:read" },
      clientInformation: { client_id: first.clientId },
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    });
    await store.save({
      ...second,
      tokens: { access_token: "access-b", token_type: "Bearer" },
      clientInformation: { client_id: second.clientId },
    });
    await Promise.all([
      store.save({ ...first, tokens: { access_token: "access-a2", token_type: "Bearer" }, clientInformation: { client_id: first.clientId } }),
      store.save({ ...second, tokens: { access_token: "access-b2", token_type: "Bearer" }, clientInformation: { client_id: second.clientId } }),
    ]);

    const reloaded = new McpAuthStore(file);
    assert.equal((await reloaded.get(first))?.tokens?.access_token, "access-a2");
    assert.equal((await reloaded.get(second))?.tokens?.access_token, "access-b2");
    assert.equal((await reloaded.find(first.resource, first.issuer, first.clientId))[0]?.tokens?.access_token, "access-a2");
    assert.equal((await reloaded.find(first.resource)).length, 2);
    assert.equal((await reloaded.find("https://unrelated.example.com/")).length, 0);
    assert.equal(await reloaded.get({ ...first, clientId: "another-client" }), undefined);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { version: number; entries: Record<string, unknown> };
    assert.equal(parsed.version, 2);
    assert.equal(Object.keys(parsed.entries).length, 2);
    assert.deepEqual(await reloaded.status(), {
      backend: "legacy-file", available: true, secure: false, location: file, entries: 2, reason: "local plaintext compatibility storage",
    });
    assert.doesNotMatch(JSON.stringify(parsed), /code_verifier|authorization_code|\"state\"/i);

    assert.equal(await reloaded.clearCredentials(first, "tokens"), true);
    assert.equal((await reloaded.get(first))?.tokens, undefined);
    assert.equal((await reloaded.get(first))?.clientInformation?.client_id, first.clientId);
    await reloaded.save({ ...first, tokens: { access_token: "restored", token_type: "Bearer" }, clientInformation: { client_id: first.clientId } });

    assert.equal(await reloaded.delete(first), true);
    assert.equal(await reloaded.get(first), undefined);
    assert.equal((await reloaded.get(second))?.tokens?.access_token, "access-b2");
    assert.equal(await reloaded.delete(first), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP OAuth migration keeps large public metadata outside the bounded system secret", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-migrate-"));
  const file = path.join(directory, "mcp-auth.json");
  const system = fakeSystemStore();
  const scope = Array.from({ length: 600 }, (_, index) => `permission-${index}`).join(" ");
  const store = new McpAuthStore(file);
  try {
    await store.save({
      ...first,
      tokens: { access_token: "access-secret", refresh_token: "refresh-secret", id_token: "id-secret", token_type: "Bearer", scope },
      clientInformation: { client_id: first.clientId, client_secret: "client-secret" },
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(await store.migrateResource(first.resource, system), 1);
    const migrated = new McpAuthStore(file, system);
    const record = await migrated.get(first);
    assert.equal(record?.tokens?.scope, scope);
    assert.equal(record?.tokens?.access_token, "access-secret");
    assert.equal(record?.clientInformation?.client_secret, "client-secret");
    assert.equal((await migrated.credentialInfo(first.resource))[0]?.legacyCopyPresent, true);

    assert.equal(await migrated.cleanupResource(first.resource), 1);
    const plaintext = await fs.readFile(file, "utf8");
    assert.match(plaintext, /permission-599/);
    assert.doesNotMatch(plaintext, /access-secret|refresh-secret|id-secret|client-secret/);
    assert.equal((await new McpAuthStore(file, system).get(first))?.tokens?.scope, scope);
    const withoutSystem = new McpAuthStore(file);
    assert.equal((await withoutSystem.get(first))?.tokens, undefined, "system references must never fall back to removed plaintext");
    assert.deepEqual(await withoutSystem.status(), {
      backend: "system", available: false, secure: true, location: file, entries: 1, reason: "system credential backend unavailable",
    });

    await migrated.save({
      ...first,
      tokens: { access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", scope: "updated-scope" },
      clientInformation: { client_id: first.clientId, client_secret: "rotated-client-secret" },
    });
    const rotatedFile = await fs.readFile(file, "utf8");
    assert.match(rotatedFile, /updated-scope/);
    assert.doesNotMatch(rotatedFile, /rotated-access|rotated-refresh|rotated-client-secret/);
    assert.equal((await new McpAuthStore(file, system).get(first))?.tokens?.access_token, "rotated-access");
    assert.deepEqual(
      new Set(await migrated.redactionValues(first.resource)),
      new Set(["rotated-access", "rotated-refresh", "rotated-client-secret"]),
    );
    assert.deepEqual(await migrated.redactionValues("https://unrelated.example.com/"), []);

    assert.equal(await migrated.rollbackResource(first.resource), 1);
    assert.equal((await new McpAuthStore(file).get(first))?.tokens?.access_token, "rotated-access");
    assert.equal(FakeCredentialEntry.values.size, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP auth store rejects corrupt or unsupported files without overwriting them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-corrupt-"));
  const file = path.join(directory, "mcp-auth.json");
  try {
    await fs.writeFile(file, JSON.stringify({ version: 3, entries: {} }));
    const store = new McpAuthStore(file);
    await assert.rejects(store.get(first), /unsupported.*version/i);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP OAuth migration records an interruption and safely resumes", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-resume-"));
  const file = path.join(directory, "mcp-auth.json");
  const store = new McpAuthStore(file);
  await store.save({
    ...first,
    tokens: { access_token: "resume-access", refresh_token: "resume-refresh", token_type: "Bearer" },
    clientInformation: { client_id: first.clientId, client_secret: "resume-client" },
  });
  class WriteThenThrowEntry extends FakeCredentialEntry {
    override setPassword(value: string): void { super.setPassword(value); throw new Error("simulated interruption"); }
  }
  const interruptedSystem = new WindowsSystemCredentialStore<McpAuthSecretRecord, "mcp-oauth-record">("mcp-oauth-record", WriteThenThrowEntry);
  try {
    await assert.rejects(store.migrateResource(first.resource, interruptedSystem), /write failed/i);
    const interruptedText = await fs.readFile(file, "utf8");
    assert.match(interruptedText, /migrationIntent/);
    assert.match(interruptedText, /resume-access/);

    const resumed = new McpAuthStore(file);
    const system = fakeSystemStore();
    assert.equal(await resumed.migrateResource(first.resource, system), 1);
    const completedText = await fs.readFile(file, "utf8");
    assert.doesNotMatch(completedText, /migrationIntent/);
    assert.equal((await new McpAuthStore(file, system).get(first))?.tokens?.access_token, "resume-access");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP OAuth cleanup refuses a corrupted system copy and preserves legacy recovery data", async () => {
  FakeCredentialEntry.values.clear();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-cleanup-refusal-"));
  const file = path.join(directory, "mcp-auth.json");
  const system = fakeSystemStore();
  const store = new McpAuthStore(file);
  try {
    await store.save({
      ...first,
      tokens: { access_token: "cleanup-access", token_type: "Bearer" },
      clientInformation: { client_id: first.clientId },
    });
    await store.migrateResource(first.resource, system);
    const info = (await store.credentialInfo(first.resource))[0]!;
    const systemKey = [...FakeCredentialEntry.values.keys()].find((key) => key.includes(info.key));
    assert.ok(systemKey);
    FakeCredentialEntry.values.set(systemKey, "not-json");

    await assert.rejects(store.cleanupResource(first.resource), /could not be verified|read failed|not valid Xiu credential data/i);
    assert.match(await fs.readFile(file, "utf8"), /cleanup-access/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
