import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedWebSearchAuth } from "../src/managed-web-search-auth.js";

const device = (suffix: string) => ({
  deviceId: `device_${suffix.repeat(32).slice(0, 32)}`,
  deviceSecret: `secret-${suffix.repeat(40)}`,
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("managed search lazily registers once, caches the short token, and never persists it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-"));
  const filename = path.join(directory, "search-auth.json");
  const calls: string[] = [];
  const credential = device("a");
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    calls.push(url);
    if (url.endsWith("/v1/devices/register")) return json(credential, 201);
    if (url.endsWith("/v1/tokens")) return json({ accessToken: "short-lived-token", expiresAt: 2_000 });
    return json({ error: "unexpected" }, 404);
  }, () => 1_000_000, async () => undefined);

  assert.deepEqual(calls, [], "constructing managed search auth must not perform network I/O");
  assert.equal(await auth.getBearerToken(), "short-lived-token");
  assert.equal(await auth.getBearerToken(), "short-lived-token");
  assert.equal(calls.filter((url) => url.endsWith("/v1/devices/register")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/v1/tokens")).length, 1);
  const persisted = await fs.readFile(filename, "utf8");
  assert.match(persisted, /device_aaaaaaaa/);
  assert.doesNotMatch(persisted, /short-lived-token/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search replaces a revoked device credential and retries token issuance once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-revoked-"));
  const filename = path.join(directory, "search-auth.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    legacyCredential: device("b"),
  }));
  let tokenCalls = 0;
  let registrations = 0;
  const replacement = device("c");
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    if (url.endsWith("/v1/devices/register")) { registrations += 1; return json(replacement, 201); }
    if (url.endsWith("/v1/tokens")) {
      tokenCalls += 1;
      return tokenCalls === 1 ? json({ error: "invalid_device_credential" }, 401) : json({ accessToken: "replacement-token", expiresAt: 2_000 });
    }
    return json({}, 404);
  }, () => 1_000_000, async () => undefined);

  assert.equal(await auth.getBearerToken(), "replacement-token");
  assert.equal(registrations, 1);
  assert.equal(tokenCalls, 2);
  assert.match(await fs.readFile(filename, "utf8"), /device_cccccccc/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search coalesces concurrent token refreshes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-concurrent-"));
  const filename = path.join(directory, "search-auth.json");
  let registrations = 0;
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    if (url.endsWith("/v1/devices/register")) { registrations += 1; return json(device("d"), 201); }
    return json({ accessToken: "shared-token", expiresAt: 2_000 });
  }, () => 1_000_000, async () => undefined);
  assert.deepEqual(await Promise.all([auth.getBearerToken(), auth.getBearerToken(), auth.getBearerToken()]), ["shared-token", "shared-token", "shared-token"]);
  assert.equal(registrations, 1);
  await fs.rm(directory, { recursive: true, force: true });
});
