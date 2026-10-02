import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test, { type TestContext } from "node:test";
import { ProviderRegistry } from "../src/provider-registry.js";

const canary = "fixture_Q7pR-not-a-real-key_38v!";
async function fixture(t: TestContext, version: number | null = 4) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-provider-upgrade-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "providers.json");
  const bytes = Buffer.from(JSON.stringify({ version, active: "agnes", profiles: [], credentials: { agnes: canary }, credentialRevisions: { agnes: 7 }, activeModels: { agnes: "chosen-chat" }, activeCapabilityModels: { agnes: { image: "chosen-image" } }, failoverChains: { agnes: ["openai"] }, routing: { enabled: true, phases: { verification: "openai" } } }, null, 1) + "\n");
  if (version !== null) await fs.writeFile(filename, bytes, { mode: 0o600 });
  return { filename, directory, bytes, recovery: `${filename}.recovery`, registry: new ProviderRegistry(filename) };
}
async function upgraded(t: TestContext) {
  const f = await fixture(t);
  await f.registry.load();
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.equal(diagnostics.backups.length, 1);
  return { ...f, backupId: diagnostics.backups[0]!.id };
}
async function privateFixtureWrite(filename: string, bytes: string, options?: Parameters<typeof fs.writeFile>[2]): Promise<void> {
  await fs.writeFile(filename, bytes, options);
  if (process.platform === "win32") {
    // Elevated Windows runners can choose Administrators as a new file's
    // default owner. Model the production writer's explicit current-user owner.
    const script = `$ErrorActionPreference='Stop'; $p=$env:XIU_TEST_TARGET; $acl=Get-Acl -LiteralPath $p; $acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User); Set-Acl -LiteralPath $p -AclObject $acl`;
    await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, XIU_TEST_TARGET: filename } });
  }
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await once(child, "close");
  return pid;
}

for (const version of [1, 2, 3, 4]) test(`v${version} upgrade preserves exact private bytes and configured-only semantics`, async (t) => {
  const f = await fixture(t, version);
  await f.registry.load();
  assert.deepEqual(f.registry.list().map((item) => item.id), ["agnes", "openai"]);
  assert.equal(f.registry.get("agnes")?.apiKey, canary);
  assert.equal(f.registry.credentialRevision("agnes"), 7);
  assert.equal(f.registry.activeModel("agnes"), "chosen-chat");
  assert.equal(f.registry.activeCapabilityModel("agnes", "image"), "chosen-image");
  assert.deepEqual(f.registry.failoverChain("agnes"), ["openai"]);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.equal(diagnostics.state, "current");
  assert.equal(diagnostics.sourceVersion, 5);
  assert.equal(diagnostics.backups.length, 1);
  const backup = diagnostics.backups[0]!;
  assert.equal(backup.sourceVersion, version);
  assert.equal(backup.reason, "upgrade");
  const backupPath = path.join(f.recovery, `${backup.id}.json`);
  const envelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
  assert.deepEqual(Buffer.from(envelope.payload, "base64"), f.bytes);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(f.recovery)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600);
  }
  const preview = await f.registry.previewConfigurationRecovery(backup.id);
  assert.equal(preview.action, "restore-backup");
  assert.doesNotMatch(JSON.stringify({ diagnostics, preview }), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify({ diagnostics, preview }), /chosen-chat|chosen-image|credentialRevisions/);
  const restart = new ProviderRegistry(f.filename);
  await restart.load();
  assert.equal((await restart.configurationDiagnostics()).backups.length, 1);
});

test("backup directory failure prevents migration and further saves", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.recovery, "collision");
  await assert.rejects(f.registry.load(), /protected regular file\/directory/);
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  assert.deepEqual(f.registry.list(), []);
  await assert.rejects(f.registry.setRoutingEnabled(true), /Reload Provider settings/);
});

test("partial backup failure preserves original bytes and redacts raw storage errors", async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(f.recovery) && String(args[0]).endsWith(".json") && args[1] === "wx") {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async () => { await write("partial interrupted backup"); throw new Error(`fixture-error-${canary}`); });
    }
    return handle;
  });
  await assert.rejects(f.registry.load(), (error: unknown) => { assert.doesNotMatch(String(error), new RegExp(canary)); return /storage operation failed/.test(String(error)); });
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.equal(diagnostics.state, "upgrade-required");
  assert.ok(diagnostics.issues.includes("invalid-backup"));
});

test("failed replacement retains original and verified pre-migration backup", async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, "rename", async () => { throw Object.assign(new Error(`fixture-${canary}`), { code: "EACCES" }); });
  await assert.rejects(f.registry.load(), /replacement may have completed/);
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.equal(diagnostics.backups.length, 1);
  assert.equal(diagnostics.state, "upgrade-required");
  assert.deepEqual((await fs.readdir(f.recovery)).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
});

test("legacy client edits between backup and replacement are not overwritten", async (t) => {
  const f = await fixture(t);
  const changed = Buffer.from(JSON.stringify({ version: 4, profiles: [], active: "ollama" }));
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(".tmp") && args[1] === "wx") await fs.writeFile(f.filename, changed);
    return handle;
  });
  await assert.rejects(f.registry.load(), /changed in another client/);
  assert.deepEqual(await fs.readFile(f.filename), changed);
  assert.equal((await f.registry.configurationDiagnostics()).backups.length, 1);
});

test("loaded registries reject stale saves and require reload after a failure", async (t) => {
  const f = await upgraded(t);
  const other = new ProviderRegistry(f.filename);
  await other.load();
  await f.registry.setActive("agnes", "newer-choice");
  const latest = await fs.readFile(f.filename);
  await assert.rejects(other.setActive("agnes", "stale-choice"), /changed in another client/);
  assert.deepEqual(await fs.readFile(f.filename), latest);
  await assert.rejects(other.setRoutingEnabled(true), /Reload Provider settings/);
  await other.load();
  assert.equal(other.activeModel("agnes"), "newer-choice");
});

test("malformed and future settings fail closed with secret-safe diagnostics", async (t) => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from(`{broken: "${canary}"`), Buffer.from(JSON.stringify({ version: 6, profiles: [], extra: canary })), Buffer.from(JSON.stringify({ version: 4, profiles: [{ id: canary }] }))]) {
    await fs.writeFile(f.filename, bytes);
    const registry = new ProviderRegistry(f.filename);
    await assert.rejects(registry.load(), (error: unknown) => { assert.doesNotMatch(String(error), new RegExp(canary)); return true; });
    const diagnostics = await registry.configurationDiagnostics();
    assert.ok(["invalid", "unsupported"].includes(diagnostics.state));
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(canary));
    assert.deepEqual(await fs.readFile(f.filename), bytes);
    assert.equal(diagnostics.backups.length, 0);
  }
});

test("restore requires explicit single-use confirmation and backs up displaced bytes", async (t) => {
  const f = await upgraded(t);
  await f.registry.setActive("agnes", "after-upgrade");
  const displaced = await fs.readFile(f.filename);
  let preview = await f.registry.previewConfigurationRecovery(f.backupId);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, false), /explicit confirmation/);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /explicit confirmation/);
  preview = await f.registry.previewConfigurationRecovery(f.backupId);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, "true" as unknown as boolean), /explicit confirmation/);
  assert.deepEqual(await fs.readFile(f.filename), displaced);
  preview = await f.registry.previewConfigurationRecovery(f.backupId);
  assert.deepEqual(await f.registry.confirmConfigurationRecovery(preview.token, true), { restoredVersion: 4, restartRequired: true });
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  assert.deepEqual(f.registry.list(), []);
  await assert.rejects(f.registry.load(), /Restart this client/);
  await assert.rejects(f.registry.setRoutingEnabled(true), /recovery requires restarting/);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /explicit confirmation/);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.equal(diagnostics.state, "upgrade-required");
  const retained = diagnostics.backups.find((backup) => backup.reason === "recovery")!;
  const envelope = JSON.parse(await fs.readFile(path.join(f.recovery, `${retained.id}.json`), "utf8"));
  assert.deepEqual(Buffer.from(envelope.payload, "base64"), displaced);
});

test("recovery works before successful load and retains corrupt current bytes verbatim", async (t) => {
  const f = await upgraded(t);
  const broken = Buffer.from(`broken-${canary}`);
  await fs.writeFile(f.filename, broken);
  const rescue = new ProviderRegistry(f.filename);
  await assert.rejects(rescue.load(), /configuration is invalid/);
  const preview = await rescue.previewConfigurationRecovery(f.backupId);
  assert.equal(preview.currentVersion, null);
  await rescue.confirmConfigurationRecovery(preview.token, true);
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  const envelopes = await Promise.all((await fs.readdir(f.recovery)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await fs.readFile(path.join(f.recovery, name), "utf8"))));
  assert.ok(envelopes.some((item) => item.reason === "recovery" && Buffer.from(item.payload, "base64").equals(broken)));
});

test("recovery refuses future-schema data and never invokes credential backends", async (t) => {
  const f = await upgraded(t);
  const unsupported = Buffer.from(JSON.stringify({ version: 6, profiles: [], secret: canary }));
  await fs.writeFile(f.filename, unsupported);
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /Unsupported provider configuration/);
  assert.deepEqual(await fs.readFile(f.filename), unsupported);
  let calls = 0;
  const store = { backend: "system" as const, kind: "provider-api-key" as const, get: () => { calls++; return undefined; }, has: () => { calls++; return false; }, set: () => { calls++; throw new Error("unexpected set"); }, delete: () => { calls++; return false; }, list: () => [], status: () => ({ backend: "system" as const, available: true, secure: true, entries: 0 }) };
  await fs.unlink(f.filename);
  const rescue = new ProviderRegistry(f.filename, store);
  const preview = await rescue.previewConfigurationRecovery(f.backupId);
  await rescue.confirmConfigurationRecovery(preview.token, true);
  assert.equal(calls, 0);
});

test("changes to either settings or backup invalidate recovery preview", async (t) => {
  const f = await upgraded(t);
  let preview = await f.registry.previewConfigurationRecovery(f.backupId);
  const changed = Buffer.from(JSON.stringify({ version: 5, profiles: [] }));
  await fs.writeFile(f.filename, changed);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /changed in another client/);
  assert.deepEqual(await fs.readFile(f.filename), changed);
  preview = await f.registry.previewConfigurationRecovery(f.backupId);
  await fs.appendFile(path.join(f.recovery, `${f.backupId}.json`), "\n");
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /changed in another client/);
  assert.deepEqual(await fs.readFile(f.filename), changed);
});

test("expired, forged, and superseded previews cannot authorize recovery", async (t) => {
  const f = await upgraded(t);
  const initial = await fs.readFile(f.filename);
  let preview = await f.registry.previewConfigurationRecovery(f.backupId);
  await assert.rejects(f.registry.confirmConfigurationRecovery("forged", true), /explicit confirmation/);
  preview = await f.registry.previewConfigurationRecovery(f.backupId);
  await f.registry.previewConfigurationRecovery(f.backupId);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /explicit confirmation/);
  preview = await f.registry.previewConfigurationRecovery(f.backupId);
  t.mock.method(Date, "now", () => Date.parse(preview.expiresAt) + 1);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /explicit confirmation/);
  assert.deepEqual(await fs.readFile(f.filename), initial);
});

test("corrupt and semantically invalid backups cannot be restored or leak through diagnostics", async (t) => {
  const f = await upgraded(t);
  const current = await fs.readFile(f.filename);
  const backupPath = path.join(f.recovery, `${f.backupId}.json`);
  const envelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
  envelope.payload = Buffer.from("corrupt").toString("base64");
  await fs.writeFile(backupPath, JSON.stringify(envelope));
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /corrupt, or unverifiable/);
  const invalid = Buffer.from(JSON.stringify({ version: 4, profiles: [{ id: canary }] }));
  envelope.payload = invalid.toString("base64");
  envelope.sha256 = createHash("sha256").update(invalid).digest("hex");
  await fs.writeFile(backupPath, JSON.stringify(envelope));
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /configuration is invalid/);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.deepEqual(diagnostics.backups, []);
  assert.ok(diagnostics.issues.includes("invalid-backup"));
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(canary));
  assert.deepEqual(await fs.readFile(f.filename), current);
});

test("active and corrupt locks refuse recovery; dead-owner recovery requires confirmation", async (t) => {
  const f = await upgraded(t);
  const lock = path.join(f.recovery, "write.lock");
  await privateFixtureWrite(lock, JSON.stringify({ pid: process.pid, nonce: "fixture" }), { mode: 0o600 });
  assert.equal((await f.registry.configurationDiagnostics()).state, "blocked");
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /write lock/);
  await privateFixtureWrite(lock, "corrupt lock");
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /write lock/);
  await privateFixtureWrite(lock, JSON.stringify({ pid: await deadPid(), nonce: "fixture" }));
  const temp = path.join(f.recovery, "interrupted.tmp");
  await fs.writeFile(temp, "partial fixture data", { mode: 0o600 });
  const preview = await f.registry.previewConfigurationRecovery(f.backupId);
  assert.ok(await fs.stat(lock));
  await f.registry.confirmConfigurationRecovery(preview.token, true);
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  assert.equal(await fs.readFile(temp, "utf8"), "partial fixture data");
});

test("backup creation failure during restore preserves current settings", async (t) => {
  const f = await upgraded(t);
  const current = await fs.readFile(f.filename);
  const preview = await f.registry.previewConfigurationRecovery(f.backupId);
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".json") && args[1] === "wx") throw new Error(`fixture-${canary}`);
    return originalOpen(...args);
  });
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /storage operation failed/);
  assert.deepEqual(await fs.readFile(f.filename), current);
});

test("unsafe backup paths, symbolic links, and hard links are rejected", async (t) => {
  const f = await upgraded(t);
  for (const id of ["../providers.json", "../../outside", "a".repeat(36)]) await assert.rejects(f.registry.previewConfigurationRecovery(id), /missing, corrupt, or unverifiable/);
  const current = await fs.readFile(f.filename);
  const backupPath = path.join(f.recovery, `${f.backupId}.json`);
  const outside = path.join(f.directory, "outside.json");
  await fs.rename(backupPath, outside);
  try { await fs.symlink(outside, backupPath); }
  catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Windows runner does not permit fixture symlinks"); return; } throw error; }
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /protected regular file/);
  await fs.unlink(backupPath);
  await fs.link(outside, backupPath);
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /protected regular file/);
  assert.deepEqual(await fs.readFile(f.filename), current);
});

test("legacy system references, revisions and migration records survive without key fallback", async (t) => {
  const f = await fixture(t);
  const legacy = JSON.parse(f.bytes.toString("utf8"));
  const reference = { backend: "system", kind: "provider-api-key", id: "provider:agnes:api-key", revision: 9 };
  const from = { backend: "legacy-file", kind: "provider-api-key", id: "agnes", revision: 7 };
  legacy.credentialRefs = { agnes: reference };
  legacy.credentialMigrations = { agnes: { providerId: "agnes", from, to: reference, migratedAt: "2026-10-01T00:00:00.000Z", legacyCopyPresent: true } };
  legacy.credentialMigrationIntents = { openai: { providerId: "openai", from: { ...from, id: "openai" }, to: { ...reference, id: "provider:openai:api-key" }, preparedAt: "2026-10-01T00:00:00.000Z" } };
  await fs.writeFile(f.filename, JSON.stringify(legacy));
  await f.registry.load();
  const current = JSON.parse(await fs.readFile(f.filename, "utf8"));
  assert.deepEqual(current.credentialRefs, legacy.credentialRefs);
  assert.deepEqual(current.credentialMigrations, legacy.credentialMigrations);
  assert.deepEqual(current.credentialMigrationIntents, legacy.credentialMigrationIntents);
  assert.equal(f.registry.get("agnes")?.apiKey, undefined);
  assert.equal(f.registry.credentialRevision("agnes"), 9);
  assert.doesNotMatch(JSON.stringify(await f.registry.configurationDiagnostics()), /provider:agnes:api-key|provider:openai:api-key/);
});

test("stale credential mutations are refused before reaching the system backend", async (t) => {
  const f = await upgraded(t);
  const document = JSON.parse(await fs.readFile(f.filename, "utf8"));
  document.credentialRefs = { agnes: { backend: "system", kind: "provider-api-key", id: "provider:agnes:api-key", revision: 9 } };
  await fs.writeFile(f.filename, JSON.stringify(document));
  let changed = 0;
  const store = { backend: "system" as const, kind: "provider-api-key" as const, get: () => canary, has: () => true, set: () => { changed++; throw new Error("unexpected set"); }, delete: () => { changed++; return true; }, list: () => [], status: () => ({ backend: "system" as const, available: true, secure: true, entries: 1 }) };
  const stale = new ProviderRegistry(f.filename, store);
  await stale.load();
  const other = new ProviderRegistry(f.filename);
  await other.load();
  await other.setActive("agnes", "newer-choice");
  await assert.rejects(stale.setApiKey("agnes", "fixture-rotation"), /changed in another client/);
  await assert.rejects(stale.remove("agnes"), /Reload Provider settings/);
  await assert.rejects(stale.forgetLocalApiKey("agnes"), /Reload Provider settings/);
  assert.equal(changed, 0);
});

test("read-only diagnostics create neither settings nor recovery storage", async (t) => {
  const f = await fixture(t, null);
  assert.equal((await f.registry.configurationDiagnostics()).state, "missing");
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("overbroad POSIX backup permissions fail closed without permission repair", { skip: process.platform === "win32" }, async (t) => {
  const f = await upgraded(t);
  const original = await fs.readFile(f.filename);
  const backup = path.join(f.recovery, `${f.backupId}.json`);
  await fs.chmod(backup, 0o644);
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /protected regular file/);
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o644);
  await fs.chmod(backup, 0o600);
  await fs.chmod(f.recovery, 0o755);
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /protected regular file/);
  assert.deepEqual(await fs.readFile(f.filename), original);
});

test("current recovery can clear a dead-owner first-write lock without creating settings or backups", async (t) => {
  const f = await fixture(t, null);
  // Let the real writer establish the private directory and Windows DACL.
  await f.registry.load();
  await f.registry.setRoutingEnabled(false);
  await fs.unlink(f.filename);
  const lock = path.join(f.recovery, "write.lock");
  await privateFixtureWrite(lock, JSON.stringify({ pid: await deadPid(), nonce: "fixture" }), { mode: 0o600 });
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.ok(diagnostics.issues.includes("interrupted-write-can-keep-current"));
  assert.equal(diagnostics.backups.length, 0);
  const preview = await f.registry.previewConfigurationRecovery("current");
  assert.equal(preview.action, "keep-current");
  assert.match(preview.warnings.join(" "), /No backup is restored/);
  assert.match(preview.warnings.join(" "), /missing and will remain missing/);
  t.mock.method(fs, "rename", async () => { throw new Error("keeping current must not replace any file"); });
  await f.registry.confirmConfigurationRecovery(preview.token, true);
  await assert.rejects(fs.stat(f.filename), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.recovery), []);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /explicit confirmation/);
});

test("current recovery rejects missing, living, unknown, changed, malformed and future cases", async (t) => {
  const f = await upgraded(t);
  const lock = path.join(f.recovery, "write.lock");
  await assert.rejects(f.registry.previewConfigurationRecovery("current"), /write lock/);
  await privateFixtureWrite(lock, JSON.stringify({ pid: process.pid, nonce: "fixture" }), { mode: 0o600 });
  await assert.rejects(f.registry.previewConfigurationRecovery("current"), /write lock/);
  await privateFixtureWrite(lock, "unknown owner");
  await assert.rejects(f.registry.previewConfigurationRecovery("current"), /write lock/);
  const pid = await deadPid();
  await privateFixtureWrite(lock, JSON.stringify({ pid, nonce: "fixture" }));
  let preview = await f.registry.previewConfigurationRecovery("current");
  const changed = Buffer.from(JSON.stringify({ version: 5, profiles: [] }));
  await fs.writeFile(f.filename, changed);
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /changed in another client/);
  assert.deepEqual(await fs.readFile(f.filename), changed);
  assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).nonce, "fixture");
  preview = await f.registry.previewConfigurationRecovery("current");
  await privateFixtureWrite(lock, JSON.stringify({ pid: process.pid, nonce: "new-owner" }));
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /write lock/);
  assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).nonce, "new-owner");
  await privateFixtureWrite(lock, JSON.stringify({ pid, nonce: "fixture3" }));
  await fs.writeFile(f.filename, JSON.stringify({ version: 6, profiles: [] }));
  await assert.rejects(f.registry.previewConfigurationRecovery("current"), /Unsupported provider configuration/);
  assert.ok(!(await f.registry.configurationDiagnostics()).issues.includes("interrupted-write-can-keep-current"));
  await fs.writeFile(f.filename, "broken current settings");
  await assert.rejects(f.registry.previewConfigurationRecovery("current"), /configuration is invalid/);
  assert.ok(await fs.stat(lock));
});

test("Windows backups and replacement settings inherit only the owner DACL", { skip: process.platform !== "win32" }, async (t) => {
  const f = await upgraded(t);
  const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach ($p in @($env:XIU_TEST_CONFIG,$env:XIU_TEST_DIRECTORY,$env:XIU_TEST_BACKUP)) { $acl=Get-Acl -LiteralPath $p; $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'Unsafe fixture ACL' } }`;
  await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000, env: { ...process.env, XIU_TEST_CONFIG: f.filename, XIU_TEST_DIRECTORY: f.recovery, XIU_TEST_BACKUP: path.join(f.recovery, `${f.backupId}.json`) } });
});

test("failed dead-owner lock release does not report successful current recovery", async (t) => {
  const f = await upgraded(t);
  const lock = path.join(f.recovery, "write.lock");
  await privateFixtureWrite(lock, JSON.stringify({ pid: await deadPid(), nonce: "fixture" }), { mode: 0o600 });
  const current = await fs.readFile(f.filename);
  const preview = await f.registry.previewConfigurationRecovery("current");
  const unlink = fs.unlink.bind(fs);
  let removals = 0;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]) === lock && ++removals === 2) throw new Error(`fixture-${canary}`);
    return unlink(...args);
  });
  await assert.rejects(f.registry.confirmConfigurationRecovery(preview.token, true), /storage operation failed/);
  assert.deepEqual(await fs.readFile(f.filename), current);
  assert.equal((await f.registry.configurationDiagnostics()).state, "blocked");
});

test("live configuration lock prevents every credential side effect before a save", async (t) => {
  const f = await upgraded(t);
  const document = JSON.parse(await fs.readFile(f.filename, "utf8"));
  document.credentialRefs = { agnes: { backend: "system", kind: "provider-api-key", id: "provider:agnes:api-key", revision: 9 } };
  await fs.writeFile(f.filename, JSON.stringify(document));
  let changed = 0;
  const store = { backend: "system" as const, kind: "provider-api-key" as const, get: () => canary, has: () => true, set: () => { changed++; throw new Error("unexpected set"); }, delete: () => { changed++; return true; }, list: () => [], status: () => ({ backend: "system" as const, available: true, secure: true, entries: 1 }) };
  const lock = path.join(f.recovery, "write.lock");
  await privateFixtureWrite(lock, JSON.stringify({ pid: process.pid, nonce: "fixture" }), { mode: 0o600 });
  const original = await fs.readFile(f.filename);
  for (const operation of ["forgetLocalApiKey", "remove", "setApiKey"] as const) {
    const registry = new ProviderRegistry(f.filename, store);
    await registry.load();
    await assert.rejects(registry[operation]("agnes", "fixture-new-key"), /write lock/);
  }
  assert.equal(changed, 0);
  assert.deepEqual(await fs.readFile(f.filename), original);
});

test("normal and nested credential writes keep the lock through backend mutation and commit", async (t) => {
  const f = await upgraded(t);
  const document = JSON.parse(await fs.readFile(f.filename, "utf8"));
  const ref = { backend: "system" as const, kind: "provider-api-key" as const, id: "provider:agnes:api-key", revision: 9 };
  document.credentialRefs = { agnes: ref };
  await fs.writeFile(f.filename, JSON.stringify(document));
  let writes = 0;
  const readLock = async () => JSON.parse(await fs.readFile(path.join(f.recovery, "write.lock"), "utf8"));
  const locks: Array<Promise<unknown>> = [];
  const store = { backend: "system" as const, kind: "provider-api-key" as const, get: () => canary, has: () => true, set: () => { writes++; locks.push(readLock()); return { ...ref, revision: 10 }; }, delete: () => { writes++; locks.push(readLock()); return true; }, list: () => [], status: () => ({ backend: "system" as const, available: true, secure: true, entries: 1 }) };
  const registry = new ProviderRegistry(f.filename, store);
  await registry.load();
  await registry.setApiKey("agnes", "fixture-new-key");
  await registry.setApiKey("agnes", undefined); // Nested explicit forget.
  assert.equal(writes, 2);
  for (const lock of await Promise.all(locks)) assert.equal((lock as {pid: number}).pid, process.pid);
  await assert.rejects(fs.stat(path.join(f.recovery, "write.lock")), { code: "ENOENT" });
});

test("legacy serialization expansion is rejected before replacing readable original settings", async (t) => {
  const f = await fixture(t, null);
  const profile = { id: "local", name: "Local", kind: "ollama", model: "fixture", baseURL: "http://127.0.0.1:11434/v1", features: { text: true, tools: true, vision: false, image: false, video: false }, extensionData: Array(400_000).fill(0) };
  const original = Buffer.from(JSON.stringify({ version: 4, profiles: [profile] }));
  assert.ok(original.length < 4 * 1024 * 1024);
  await fs.writeFile(f.filename, original);
  await assert.rejects(f.registry.load(), /4 MiB safety limit/);
  assert.deepEqual(await fs.readFile(f.filename), original);
  assert.equal((await f.registry.configurationDiagnostics()).state, "upgrade-required");
});

test("ordinary save growth is rejected before replacing valid settings", async (t) => {
  const f = await upgraded(t);
  const original = await fs.readFile(f.filename);
  const profile = { ...f.registry.get("agnes")!, extensionData: Array(400_000).fill(0) };
  await assert.rejects(f.registry.upsert(profile), /4 MiB safety limit/);
  assert.deepEqual(await fs.readFile(f.filename), original);
});

test("noncanonical backup timestamps cannot leak embedded metadata into diagnostics", async (t) => {
  const f = await upgraded(t);
  const filename = path.join(f.recovery, `${f.backupId}.json`);
  const backup = JSON.parse(await fs.readFile(filename, "utf8"));
  backup.createdAt = `2026-10-01 (${canary})`;
  assert.ok(Number.isFinite(Date.parse(backup.createdAt)), "fixture exercises permissive Date.parse");
  await fs.writeFile(filename, JSON.stringify(backup));
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /corrupt, or unverifiable/);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(canary));
  assert.deepEqual(diagnostics.backups, []);
  assert.ok(diagnostics.issues.includes("invalid-backup"));
});

test("interrupted recovery with unknown lock ownership remains explicitly blocked", async (t) => {
  const f = await upgraded(t);
  const current = await fs.readFile(f.filename);
  await privateFixtureWrite(path.join(f.recovery, "write.lock"), JSON.stringify({ pid: await deadPid(), nonce: "fixture" }), { mode: 0o600 });
  await privateFixtureWrite(path.join(f.recovery, "recovery.lock"), "recovery\n", { mode: 0o600 });
  for (const id of ["current", f.backupId]) await assert.rejects(f.registry.previewConfigurationRecovery(id), /write lock/);
  const diagnostics = await f.registry.configurationDiagnostics();
  assert.equal(diagnostics.state, "blocked");
  assert.ok(!diagnostics.issues.includes("interrupted-write-can-keep-current"));
  assert.deepEqual(await fs.readFile(f.filename), current);
});

test("Windows directory and file ACL changes are rechecked and never repaired silently", { skip: process.platform !== "win32" }, async (t) => {
  const f = await upgraded(t);
  const before = await fs.readFile(f.filename);
  const run = promisify(execFile);
  const backup = path.join(f.recovery, `${f.backupId}.json`);
  const script = `$ErrorActionPreference='Stop'; $p=$env:XIU_TEST_TARGET; $acl=Get-Acl -LiteralPath $p; $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`;
  await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, XIU_TEST_TARGET: backup } });
  await assert.rejects(f.registry.previewConfigurationRecovery(f.backupId), /protected regular file/);
  await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, XIU_TEST_TARGET: f.recovery } });
  await assert.rejects(f.registry.setRoutingEnabled(true), /protected regular file/);
  assert.deepEqual(await fs.readFile(f.filename), before);
});

test("post-switch verification failure retains copied system credentials and requires inspection", async (t) => {
  const f = await upgraded(t);
  let value: string | undefined;
  let deletes = 0;
  const store = { backend: "system" as const, kind: "provider-api-key" as const, get: () => value, has: () => value !== undefined,
    set: (ref: { backend: "system" | "environment" | "legacy-file"; kind: "provider-api-key"; id: string; revision: number }, next: string) => { value = next; return { ...ref, revision: 1 }; },
    delete: () => { deletes++; value = undefined; return true; }, list: () => [], status: () => ({ backend: "system" as const, available: true, secure: true, entries: value ? 1 : 0 }) };
  const originalRead = fs.open.bind(fs);
  const originalRename = fs.rename.bind(fs);
  let renames = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { await originalRename(...args); if (args[1] === f.filename) renames++; });
  // Simulate a post-rename verification failure independently of directory
  // fsync, which is not available through Node on Windows.
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === f.filename && renames === 2) throw new Error(`fixture-${canary}`);
    return originalRead(...args);
  });
  await assert.rejects(f.registry.migrateApiKeysToSystem(["agnes"], store), /replacement may have completed/);
  assert.equal(deletes, 0);
  assert.equal(value, canary);
  t.mock.restoreAll();
  const persisted = JSON.parse(await fs.readFile(f.filename, "utf8"));
  assert.equal(persisted.credentialRefs.agnes.backend, "system");
  assert.equal(persisted.credentials.agnes, canary);
  const restarted = new ProviderRegistry(f.filename, store);
  await restarted.load();
  assert.equal(restarted.get("agnes")?.apiKey, canary);
});
