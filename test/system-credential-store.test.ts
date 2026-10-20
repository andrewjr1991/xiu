import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStoreError } from "../src/credential-store.js";
import { SystemCredentialStore, createSystemCredentialStore, probeSystemCredentialStore, systemCredentialBackend, systemCredentialBackendName } from "../src/system-credential-store.js";

class FakeEntry {
  static values = new Map<string, string>();
  private readonly key: string;

  constructor(service: string, username: string) { this.key = `${service}\0${username}`; }
  setPassword(password: string): void { FakeEntry.values.set(this.key, password); }
  getPassword(): string | null { return FakeEntry.values.get(this.key) ?? null; }
  deleteCredential(): boolean { return FakeEntry.values.delete(this.key); }
}

test("System credential store round-trips values with monotonic revisions", () => {
  FakeEntry.values.clear();
  const store = new SystemCredentialStore<string, "provider-api-key">("provider-api-key", FakeEntry, ["provider:demo"]);
  const ref = store.ref("provider:demo");
  const first = store.set(ref, "canary-secret");
  const second = store.set(first, "rotated-secret");

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(store.get(second), "rotated-secret");
  assert.equal(store.get(first), "rotated-secret");
  assert.equal(store.has(second), true);
  assert.deepEqual(store.list(), [store.ref("provider:demo")]);
  assert.doesNotMatch(JSON.stringify(store.status()), /canary|rotated/);
  assert.equal(store.delete(second), true);
  assert.equal(store.get(second), undefined);
});

test("System credential store rejects oversized values without writing", () => {
  FakeEntry.values.clear();
  const store = new SystemCredentialStore<string, "provider-api-key">("provider-api-key", FakeEntry);
  assert.throws(() => store.set(store.ref("provider:large"), "x".repeat(3_000)), (error) =>
    error instanceof CredentialStoreError && error.code === "size-limit");
  assert.equal(FakeEntry.values.size, 0);
});

test("System credential errors never include backend error secrets", () => {
  const leaked = "canary-do-not-leak";
  class ThrowingEntry {
    constructor(_service: string, _username: string) {}
    setPassword(): void { throw new Error(leaked); }
    getPassword(): string | null { throw new Error(leaked); }
    deleteCredential(): boolean { throw new Error(leaked); }
  }
  const store = new SystemCredentialStore<string, "provider-api-key">("provider-api-key", ThrowingEntry);
  let message = "";
  try { store.get(store.ref("provider:error")); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }
  assert.doesNotMatch(message, new RegExp(leaked));
  assert.match(message, /read failed/i);
});

test("System credential store rejects corrupted or mismatched envelopes", () => {
  FakeEntry.values.clear();
  const store = new SystemCredentialStore<string, "provider-api-key">("provider-api-key", FakeEntry);
  const ref = store.ref("provider:corrupt");
  FakeEntry.values.set("xiu-ai.credentials.provider-api-key\0provider:corrupt", "not-json");
  assert.throws(() => store.get(ref), (error) => error instanceof CredentialStoreError && error.code === "corrupted-value");
  FakeEntry.values.set("xiu-ai.credentials.provider-api-key\0provider:corrupt", JSON.stringify({ version: 1, kind: "mcp-oauth-record", revision: 1, value: "secret" }));
  assert.throws(() => store.get(ref), (error) => error instanceof CredentialStoreError && error.code === "corrupted-value");
});

test("system credential backends are selected per platform and fail closed elsewhere", async () => {
  FakeEntry.values.clear();
  assert.equal(systemCredentialBackend("win32")?.name, "Windows Credential Manager");
  assert.equal(systemCredentialBackend("darwin")?.name, "macOS Keychain");
  assert.equal(systemCredentialBackend("linux")?.name, "Linux Secret Service");
  assert.equal(systemCredentialBackend("freebsd"), undefined);
  assert.equal(systemCredentialBackendName("freebsd"), "system credential store");
  await assert.rejects(createSystemCredentialStore("provider-api-key", [], { platform: "freebsd", Entry: FakeEntry }), (error) =>
    error instanceof CredentialStoreError && error.code === "backend-unavailable" && /No system credential backend is available on freebsd/.test(error.message));
  const probe = await probeSystemCredentialStore(true, { platform: "aix", Entry: FakeEntry });
  assert.equal(probe.backend, undefined);
  assert.equal(probe.status.available, false);
  assert.equal(probe.checks.module, false);
  assert.match(probe.status.reason ?? "", /No system credential backend is available on aix/);
  assert.equal(FakeEntry.values.size, 0, "an unsupported platform must never write a canary");
});

test("system credential store names the platform backend in status and errors", async () => {
  FakeEntry.values.clear();
  for (const [platform, name] of [["darwin", "macOS Keychain"], ["linux", "Linux Secret Service"], ["win32", "Windows Credential Manager"]] as const) {
    const store = await createSystemCredentialStore<string, "provider-api-key">("provider-api-key", ["provider:demo"], { platform, Entry: FakeEntry });
    assert.equal(store.system.platform, platform);
    assert.equal(store.status().location, name);
    assert.throws(() => store.set(store.ref("provider:large"), "x".repeat(3_000)), (error) =>
      error instanceof CredentialStoreError && error.code === "size-limit" && error.message.includes(name));
    const probe = await probeSystemCredentialStore(true, { platform, Entry: FakeEntry });
    assert.equal(probe.backend?.name, name);
    assert.deepEqual(probe.checks, { module: true, lookup: true, write: true, read: true, delete: true });
    assert.equal(probe.status.available, true);
    assert.equal(FakeEntry.values.size, 0, "the canary must be deleted again");
  }
});

test("system credential probe reports an unreachable service without writing and names its requirement", async () => {
  class NoSessionEntry {
    static writes = 0;
    constructor(_service: string, _username: string) {}
    setPassword(): void { NoSessionEntry.writes += 1; throw new Error("No DBus session or Secret Service provider found"); }
    getPassword(): string | null { throw new Error("No DBus session or Secret Service provider found"); }
    deleteCredential(): boolean { throw new Error("No DBus session or Secret Service provider found"); }
  }
  const quick = await probeSystemCredentialStore(false, { platform: "linux", Entry: NoSessionEntry });
  assert.equal(quick.status.available, false);
  assert.deepEqual(quick.checks, { module: true, lookup: false });
  assert.match(quick.status.reason ?? "", /^Linux Secret Service lookup failed \(a D-Bus session bus with a Secret Service provider/);
  assert.doesNotMatch(quick.status.reason ?? "", /DBus session or Secret Service provider found/, "the native error text is not echoed");
  const full = await probeSystemCredentialStore(true, { platform: "linux", Entry: NoSessionEntry });
  assert.equal(full.status.available, false);
  assert.equal(full.checks.write, undefined, "a failed lookup stops the probe before the canary write");
  assert.equal(NoSessionEntry.writes, 0);
  const locked = await probeSystemCredentialStore(false, { platform: "darwin", Entry: NoSessionEntry });
  assert.match(locked.status.reason ?? "", /^macOS Keychain lookup failed \(the login keychain must be unlocked/);
});

test("system credential store stays usable for existing references when the service answers", async () => {
  FakeEntry.values.clear();
  const store = await createSystemCredentialStore<string, "mcp-oauth-record">("mcp-oauth-record", [], { platform: "darwin", Entry: FakeEntry });
  const ref = store.set(store.ref("mcp:demo"), "token");
  const quick = await probeSystemCredentialStore(false, { platform: "darwin", Entry: FakeEntry });
  assert.equal(quick.status.available, true);
  assert.deepEqual(quick.checks, { module: true, lookup: true });
  assert.equal(store.get(ref), "token", "a read-only probe never touches real entries");
  assert.equal(FakeEntry.values.size, 1);
});

test("Linux refuses the kernel keyring fallback: no Secret Service means no system store at all", async () => {
  FakeEntry.values.clear();
  let searches = 0;
  const noService = () => { searches += 1; throw new Error("no secret service provider or dbus session found"); };
  // The native module answers reads and even writes through keyutils when Secret Service is missing; the store must never be created then.
  await assert.rejects(createSystemCredentialStore("provider-api-key", [], { platform: "linux", Entry: FakeEntry, findCredentials: noService }), (error) =>
    error instanceof CredentialStoreError && error.code === "backend-unavailable" && /^Linux Secret Service is not reachable \(a D-Bus session bus .* does not survive a reboot\)$/.test(error.message));
  const probe = await probeSystemCredentialStore(true, { platform: "linux", Entry: FakeEntry, findCredentials: noService });
  assert.equal(probe.status.available, false);
  assert.deepEqual(probe.checks, { module: true, lookup: false });
  assert.match(probe.status.reason ?? "", /^Linux Secret Service is not reachable \(/);
  assert.equal((probe.status.reason ?? "").split("does not survive a reboot").length, 2, "the requirement is stated once");
  assert.equal(FakeEntry.values.size, 0, "nothing is written through the fallback");
  assert.equal(searches, 2);

  const reachable = (service: string) => { searches += 1; assert.equal(service, "xiu-ai.credentials.probe"); return []; };
  const store = await createSystemCredentialStore<string, "provider-api-key">("provider-api-key", [], { platform: "linux", Entry: FakeEntry, findCredentials: reachable });
  assert.equal(store.get(store.set(store.ref("provider:demo"), "secret")), "secret");
  const ok = await probeSystemCredentialStore(true, { platform: "linux", Entry: FakeEntry, findCredentials: reachable });
  assert.deepEqual(ok.checks, { module: true, lookup: true, write: true, read: true, delete: true });
  assert.equal(searches, 4);

  // Other platforms never run the search: their stores have no silent fallback.
  for (const platform of ["darwin", "win32"] as const) {
    const other = await createSystemCredentialStore<string, "provider-api-key">("provider-api-key", [], { platform, Entry: FakeEntry, findCredentials: noService });
    assert.equal(other.system.platform, platform);
  }
  assert.equal(searches, 4);
});
