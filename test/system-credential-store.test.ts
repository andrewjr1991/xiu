import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStoreError } from "../src/credential-store.js";
import { WindowsSystemCredentialStore } from "../src/system-credential-store.js";

class FakeEntry {
  static values = new Map<string, string>();
  private readonly key: string;

  constructor(service: string, username: string) { this.key = `${service}\0${username}`; }
  setPassword(password: string): void { FakeEntry.values.set(this.key, password); }
  getPassword(): string | null { return FakeEntry.values.get(this.key) ?? null; }
  deleteCredential(): boolean { return FakeEntry.values.delete(this.key); }
}

test("Windows system credential store round-trips values with monotonic revisions", () => {
  FakeEntry.values.clear();
  const store = new WindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key", FakeEntry, ["provider:demo"]);
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

test("Windows system credential store rejects oversized values without writing", () => {
  FakeEntry.values.clear();
  const store = new WindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key", FakeEntry);
  assert.throws(() => store.set(store.ref("provider:large"), "x".repeat(3_000)), (error) =>
    error instanceof CredentialStoreError && error.code === "size-limit");
  assert.equal(FakeEntry.values.size, 0);
});

test("Windows system credential errors never include backend error secrets", () => {
  const leaked = "canary-do-not-leak";
  class ThrowingEntry {
    constructor(_service: string, _username: string) {}
    setPassword(): void { throw new Error(leaked); }
    getPassword(): string | null { throw new Error(leaked); }
    deleteCredential(): boolean { throw new Error(leaked); }
  }
  const store = new WindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key", ThrowingEntry);
  let message = "";
  try { store.get(store.ref("provider:error")); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }
  assert.doesNotMatch(message, new RegExp(leaked));
  assert.match(message, /read failed/i);
});

test("Windows system credential store rejects corrupted or mismatched envelopes", () => {
  FakeEntry.values.clear();
  const store = new WindowsSystemCredentialStore<string, "provider-api-key">("provider-api-key", FakeEntry);
  const ref = store.ref("provider:corrupt");
  FakeEntry.values.set("xiu-ai.credentials.provider-api-key\0provider:corrupt", "not-json");
  assert.throws(() => store.get(ref), (error) => error instanceof CredentialStoreError && error.code === "corrupted-value");
  FakeEntry.values.set("xiu-ai.credentials.provider-api-key\0provider:corrupt", JSON.stringify({ version: 1, kind: "mcp-oauth-record", revision: 1, value: "secret" }));
  assert.throws(() => store.get(ref), (error) => error instanceof CredentialStoreError && error.code === "corrupted-value");
});
