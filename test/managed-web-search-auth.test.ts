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

test("managed search credential status is local-only and reports compatibility storage", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-status-"));
  const filename = path.join(directory, "search-auth.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    legacyCredential: device("e"),
  }));
  let networkCalls = 0;
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async () => {
    networkCalls += 1;
    return json({}, 500);
  }, () => 1_000_000, async () => undefined);

  assert.deepEqual(await auth.credentialStatus(), {
    present: true,
    storage: "compatibility-file",
    tokenCached: false,
  });
  assert.equal(networkCalls, 0);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search doctor checks health and authentication without exposing the token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-doctor-"));
  const filename = path.join(directory, "search-auth.json");
  const calls: string[] = [];
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    calls.push(url);
    if (url.endsWith("/healthz")) return json({ status: "ok" });
    if (url.endsWith("/v1/devices/register")) return json(device("f"), 201);
    if (url.endsWith("/v1/tokens")) return json({ accessToken: "doctor-secret-token", expiresAt: 2_000 });
    return json({}, 404);
  }, () => 1_000_000, async () => undefined);

  const result = await auth.diagnose();
  assert.equal(result.health, "ok");
  assert.equal(result.authentication, "ok");
  assert.equal(result.credential.present, true);
  assert.equal(result.credential.tokenCached, true);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ["/xiu-auth/healthz", "/xiu-auth/v1/devices/register", "/xiu-auth/v1/tokens"]);
  assert.doesNotMatch(JSON.stringify(result), /doctor-secret-token/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search device listing is read-only, bounded, and redacts identifiers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-devices-"));
  const filename = path.join(directory, "search-auth.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    legacyCredential: device("a"),
  }));
  const calls: Array<{ url: string; method: string; authorization?: string }> = [];
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    if (url.endsWith("/v1/tokens")) return json({ accessToken: "device-query-token", expiresAt: 2_000 });
    if (url.endsWith("/v1/devices")) return json({
      currentDeviceId: "device_gggggggggggggggggggggggggggggggg",
      requestId: "request-123",
      devices: [{ id: "device_gggggggggggggggggggggggggggggggg", status: "active", createdAt: "2026-08-01T00:00:00Z" }],
      audit: [{ action: "registered", deviceId: "device_gggggggggggggggggggggggggggggggg", occurredAt: "2026-08-01T00:00:00Z", requestId: "request-123" }],
    });
    return json({}, 404);
  }, () => 1_000_000, async () => undefined);

  const result = await auth.listDevices();
  assert.equal(result.devices[0]?.status, "active");
  assert.equal(result.audit[0]?.action, "registered");
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.method]), [["/xiu-auth/v1/tokens", "POST"], ["/xiu-auth/v1/devices", "GET"]]);
  assert.equal(calls[1]?.authorization, "Bearer device-query-token");
  assert.doesNotMatch(JSON.stringify(result), /device-query-token|secret-/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search device listing never auto-registers or clears a rejected credential", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-devices-rejected-"));
  const filename = path.join(directory, "search-auth.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    legacyCredential: device("b"),
  }));
  const calls: string[] = [];
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith("/v1/tokens")) return json({ error: "invalid_device_credential" }, 401);
    return json({}, 500);
  }, () => 1_000_000, async () => undefined);

  await assert.rejects(() => auth.listDevices(), /credential was rejected/i);
  assert.deepEqual(calls, ["/xiu-auth/v1/tokens"]);
  assert.match(await fs.readFile(filename, "utf8"), /device_bbbbbbbb/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search device listing fails closed on malformed server data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-devices-malformed-"));
  const filename = path.join(directory, "search-auth.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    legacyCredential: device("c"),
  }));
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    if (url.endsWith("/v1/tokens")) return json({ accessToken: "device-query-token", expiresAt: 2_000 });
    return json({ devices: [{ id: "device_cccccccccccccccccccccccccccccccc", status: "active" }], audit: [{ action: "unexpected", deviceId: "device_cccccccccccccccccccccccccccccccc" }] });
  }, () => 1_000_000, async () => undefined);

  await assert.rejects(() => auth.listDevices(), /invalid response/i);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search reset clears only the local device credential and re-enrolls on demand", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-reset-"));
  const filename = path.join(directory, "search-auth.json");
  await fs.writeFile(filename, JSON.stringify({
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    legacyCredential: device("1"),
  }));
  let registrations = 0;
  const auth = new ManagedWebSearchAuth("https://search.example/xiu-auth", filename, async (url) => {
    if (url.endsWith("/v1/devices/register")) { registrations += 1; return json(device("2"), 201); }
    return json({ accessToken: `token-${registrations}`, expiresAt: 2_000 });
  }, () => 1_000_000, async () => undefined);

  await auth.getBearerToken();
  const before = await auth.resetCredential();
  assert.equal(before.present, true);
  assert.deepEqual(await auth.credentialStatus(), { present: false, storage: "none", tokenCached: false });
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /device_|deviceSecret/);
  await auth.getBearerToken();
  assert.equal(registrations, 1);
  assert.match(await fs.readFile(filename, "utf8"), /device_22222222/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search reset fails closed when a referenced system credential backend is unavailable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-search-auth-reset-system-"));
  const filename = path.join(directory, "search-auth.json");
  const state = {
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    credentialRef: {
      backend: "system",
      kind: "web-search-device",
      id: "search.jingran.vip:device",
      revision: 1,
    },
  };
  await fs.writeFile(filename, JSON.stringify(state));
  const auth = new ManagedWebSearchAuth(
    "https://search.example/xiu-auth",
    filename,
    async () => json({}, 500),
    () => 1_000_000,
    async () => undefined,
  );

  await assert.rejects(() => auth.resetCredential(), /backend is unavailable/i);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), state);
  await fs.rm(directory, { recursive: true, force: true });
});
