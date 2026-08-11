import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialStoreError,
  EnvironmentCredentialStore,
  LegacyCredentialStore,
  credentialRef,
  readEnvironmentCredential,
} from "../src/credential-store.js";

test("environment credential store exposes only safe metadata and is read-only", () => {
  const store = new EnvironmentCredentialStore({
    kind: "provider-api-key", ids: ["OFFICE_KEY", "MISSING_KEY"], env: { OFFICE_KEY: "canary-secret" },
  });
  const ref = credentialRef("environment", "provider-api-key", "OFFICE_KEY");
  assert.equal(store.get(ref), "canary-secret");
  assert.deepEqual(store.list(), [ref]);
  assert.doesNotMatch(JSON.stringify(store.status()), /canary-secret/);
  assert.throws(() => store.set(ref, "new-secret"), (error) => error instanceof CredentialStoreError && error.code === "read-only");
});

test("environment credential helper uses the same read-only backend contract", () => {
  assert.equal(readEnvironmentCredential("OFFICE_KEY", { OFFICE_KEY: "canary-secret" }), "canary-secret");
  assert.equal(readEnvironmentCredential("MISSING_KEY", {}), undefined);
});

test("legacy credential store keeps secret values separate from safe metadata", () => {
  const store = new LegacyCredentialStore<string>({
    kind: "provider-api-key",
    location: "C:/Users/test/.xiu/providers.json",
    values: { "provider:office:api-key": "canary-secret" },
    revisions: { "provider:office:api-key": 3 },
  });
  const ref = credentialRef("legacy-file", "provider-api-key", "provider:office:api-key", 3);

  assert.equal(store.get(ref), "canary-secret");
  assert.equal(store.has(ref), true);
  assert.deepEqual(store.list(), [{
    backend: "legacy-file", kind: "provider-api-key", id: "provider:office:api-key", revision: 3,
  }]);
  assert.doesNotMatch(JSON.stringify(store.list()), /canary-secret/);
  assert.deepEqual(store.status(), {
    backend: "legacy-file", available: true, secure: false,
    location: "C:/Users/test/.xiu/providers.json", entries: 1,
  });

  const receipt = store.set(credentialRef("legacy-file", "provider-api-key", "provider:office:api-key"), "rotated-secret");
  assert.equal(receipt.revision, 4);
  assert.equal(store.get(receipt), "rotated-secret");
  assert.equal(store.delete(receipt), true);
  assert.equal(store.delete(receipt), false);
});

test("legacy credential store rejects mismatched references and returns cloned values", () => {
  const store = new LegacyCredentialStore<{ token: string }>({
    kind: "mcp-oauth-record", location: "mcp-auth.json", values: { one: { token: "secret" } },
  });
  assert.throws(() => store.get(credentialRef("environment", "mcp-oauth-record", "one")), /backend/i);
  assert.throws(() => store.get(credentialRef("legacy-file", "provider-api-key", "one")), /kind/i);
  const value = store.get(credentialRef("legacy-file", "mcp-oauth-record", "one"))!;
  value.token = "changed";
  assert.equal(store.get(credentialRef("legacy-file", "mcp-oauth-record", "one"))?.token, "secret");
});
