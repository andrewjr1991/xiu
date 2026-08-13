import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginRegistry, pluginPackageDigest } from "../src/plugins.js";
import { PermissionGrantStore } from "../src/extension-permissions.js";
import { PLUGIN_SIGNATURE_FILE, PluginPublisherTrustStore, pluginPublisherFingerprint, pluginSignatureMessage } from "../src/plugin-signatures.js";

async function writePlugin(root: string, name: string, manifest: object, files: Record<string, string> = {}): Promise<void> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "xiu.plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

const manifest = (id: string, extra: object = {}) => ({
  apiVersion: 1,
  id,
  name: id,
  version: "1.0.0",
  engines: { xiu: { min: "0.14.0", maxExclusive: "0.15.0" } },
  permissions: ["workspace:read", "instructions:load"],
  contributes: { skills: [{ id: "review", path: "skills/review" }] },
  ...extra,
});

async function signPlugin(directory: string, pluginId: string, pluginVersion: string, publisherName = "Test Publisher"): Promise<{ fingerprintKey: string; privateKey: KeyObject }> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const digest = (await pluginPackageDigest(directory)).digest;
  const signature = sign(null, pluginSignatureMessage(pluginId, pluginVersion, digest), privateKey).toString("base64");
  await fs.writeFile(path.join(directory, PLUGIN_SIGNATURE_FILE), `${JSON.stringify({
    version: 1,
    algorithm: "ed25519",
    pluginId,
    pluginVersion,
    packageDigest: digest,
    publisher: { name: publisherName, publicKey: publicKeyBase64 },
    signature,
  }, null, 2)}\n`, "utf8");
  return { fingerprintKey: publicKeyBase64, privateKey };
}

test("plugin registry discovers trusted project and global manifests without activating code", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugins-"));
  const globalRoot = path.join(cwd, "global");
  await writePlugin(path.join(cwd, ".xiu", "plugins"), "project", manifest("acme.project"), { "skills/review/SKILL.md": "# Review\n" });
  await writePlugin(globalRoot, "global", manifest("acme.global"), { "skills/review/SKILL.md": "# Review\n" });
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.0");

  await registry.refresh(false);
  assert.deepEqual(registry.list().map((plugin) => plugin.id), ["acme.global"]);

  await registry.refresh(true);
  assert.deepEqual(registry.list().map((plugin) => plugin.id).sort(), ["acme.global", "acme.project"]);
  assert.ok(registry.list().every((plugin) => plugin.state === "ready" && plugin.active === false));
  await fs.rm(cwd, { recursive: true, force: true });
});

test("plugin registry rejects traversal, absolute paths, unknown permissions, and unsupported API versions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-invalid-"));
  const root = path.join(cwd, ".xiu", "plugins");
  await writePlugin(root, "traversal", manifest("bad.traversal", { contributes: { skills: [{ id: "bad", path: "../outside" }] } }));
  await writePlugin(root, "absolute", manifest("bad.absolute", { contributes: { workflows: [{ id: "bad", path: path.resolve(cwd, "outside.json") }] } }));
  await writePlugin(root, "permission", manifest("bad.permission", { permissions: ["system:override"] }));
  await writePlugin(root, "missing-instructions", manifest("bad.missing-instructions", { permissions: ["workspace:read"] }), { "skills/review/SKILL.md": "# Review\n" });
  await writePlugin(root, "api", manifest("bad.api", { apiVersion: 99 }));
  const registry = new PluginRegistry(cwd, path.join(cwd, "global"), "0.14.0");
  await registry.refresh(true);

  for (const id of ["bad.traversal", "bad.absolute", "bad.permission", "bad.missing-instructions", "bad.api"]) {
    const plugin = registry.get(id);
    assert.equal(plugin?.state, "invalid", `${id} should be invalid`);
    assert.ok(plugin?.problems.length);
  }
  await fs.rm(cwd, { recursive: true, force: true });
});

test("plugin registry rejects symlink escapes and reports incompatible Xiu versions", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-boundary-"));
  const root = path.join(cwd, ".xiu", "plugins");
  const outside = path.join(cwd, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "SKILL.md"), "# outside\n");
  await writePlugin(root, "escape", manifest("bad.escape"));
  await fs.mkdir(path.join(root, "escape", "skills"), { recursive: true });
  try {
    await fs.symlink(outside, path.join(root, "escape", "skills", "review"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("symlink creation is unavailable");
      await fs.rm(cwd, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  await writePlugin(root, "future", manifest("future.plugin", { engines: { xiu: { min: "0.15.0" } } }), { "skills/review/SKILL.md": "# Review\n" });
  const registry = new PluginRegistry(cwd, path.join(cwd, "global"), "0.14.0");
  await registry.refresh(true);
  assert.equal(registry.get("bad.escape")?.state, "invalid");
  assert.equal(registry.get("future.plugin")?.state, "incompatible");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("project plugin shadows duplicate global ID explicitly", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-shadow-"));
  const globalRoot = path.join(cwd, "global");
  await writePlugin(globalRoot, "same", manifest("same.plugin"), { "skills/review/SKILL.md": "# global\n" });
  await writePlugin(path.join(cwd, ".xiu", "plugins"), "same", manifest("same.plugin"), { "skills/review/SKILL.md": "# project\n" });
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.0");
  await registry.refresh(true);
  assert.equal(registry.get("same.plugin")?.scope, "project");
  assert.equal(registry.shadowed().length, 1);
  assert.equal(registry.shadowed()[0]?.scope, "global");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("approved plugin loads only bounded declarative contributions and manifest changes revoke activation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-active-"));
  const root = path.join(cwd, ".xiu", "plugins");
  const grants = new PermissionGrantStore(path.join(cwd, "permissions.json"));
  const activeManifest = manifest("acme.active", {
    permissions: ["instructions:load", "network:access", "credentials:access", "external:read"],
    contributes: {
      providers: [{ id: "acme-provider", path: "provider.json" }],
      tools: [{ id: "search", path: "mcp.json" }],
      skills: [{ id: "review", path: "skills/review" }],
      workflows: [{ id: "release", path: "workflows/release.md" }],
    },
  });
  await writePlugin(root, "active", activeManifest, {
    "provider.json": JSON.stringify({ id: "acme-provider", name: "Acme", kind: "openai-compatible", model: "acme-1", baseURL: "https://api.example.com/v1", apiKeyEnv: "ACME_API_KEY", features: { text: true, tools: true, vision: false, image: false, video: false } }),
    "mcp.json": JSON.stringify({ url: "https://mcp.example.com/mcp", risk: "read", permissions: ["external:read", "network:access"] }),
    "skills/review/SKILL.md": "---\nname: review\ndescription: Review safely\npermissions: instructions:load\n---\n# Review\n",
    "workflows/release.md": "# Release workflow\nVerify before release.\n",
  });
  const registry = new PluginRegistry(cwd, path.join(cwd, "global"), "0.14.1", grants);
  await registry.refresh(true);
  assert.equal(registry.get("acme.active")?.active, false);
  await registry.approve("acme.active");
  const loaded = await registry.loadApprovedContributions();
  assert.equal(loaded.providers[0]?.id, "acme-provider");
  assert.equal(Object.keys(loaded.mcpServers).length, 1);
  assert.deepEqual(loaded.skillFiles.map((item) => item.name), ["acme.active.review", "workflow:acme.active.release"]);
  assert.deepEqual(loaded.errors, []);

  await fs.writeFile(path.join(root, "active", "skills", "review", "SKILL.md"), "# Changed after approval\n");
  await registry.refresh(true);
  assert.equal(registry.get("acme.active")?.active, false);
  await registry.approve("acme.active");
  const changed = { ...activeManifest, version: "1.0.1" };
  await fs.writeFile(path.join(root, "active", "xiu.plugin.json"), `${JSON.stringify(changed, null, 2)}\n`);
  await registry.refresh(true);
  assert.equal(registry.get("acme.active")?.active, false);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("plugin lifecycle installs, updates, disables, uninstalls, and recovers without losing the previous package", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-lifecycle-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  const grants = new PermissionGrantStore(path.join(cwd, "permissions.json"));
  await writePlugin(cwd, "source", manifest("lifecycle.plugin"), { "skills/review/SKILL.md": "# Version one\n" });
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.2", grants);

  const install = await registry.prepareInstall(source, "global");
  assert.equal(install.previous, undefined);
  assert.deepEqual(install.addedPermissions, ["instructions:load", "workspace:read"]);
  const installed = await registry.commitInstall(install);
  assert.equal(installed.plugin.version, "1.0.0");
  assert.equal(installed.plugin.active, false);
  assert.equal(installed.plugin.integrity, "verified");
  assert.match(installed.plugin.packageDigest ?? "", /^[a-f0-9]{64}$/);
  const installMetadata = JSON.parse(await fs.readFile(path.join(installed.plugin.directory, ".xiu-install.json"), "utf8")) as Record<string, unknown>;
  assert.equal(installMetadata.version, 2);
  assert.equal(installMetadata.packageDigest, installed.plugin.packageDigest);
  assert.equal(typeof installMetadata.source, "string");

  await registry.approve("lifecycle.plugin");
  await registry.setEnabled("lifecycle.plugin", false);
  assert.equal(registry.get("lifecycle.plugin")?.state, "disabled");
  assert.equal(registry.get("lifecycle.plugin")?.active, false);
  await registry.setEnabled("lifecycle.plugin", true);
  assert.equal(registry.get("lifecycle.plugin")?.state, "ready");
  assert.equal(registry.get("lifecycle.plugin")?.active, true);

  await writePlugin(cwd, "source", manifest("lifecycle.plugin", {
    version: "1.1.0",
    permissions: ["workspace:read", "instructions:load", "external:read"],
  }), { "skills/review/SKILL.md": "# Version two\n" });
  const update = await registry.prepareUpdate("lifecycle.plugin");
  assert.equal(update.previous?.version, "1.0.0");
  assert.equal(update.plugin.version, "1.1.0");
  assert.deepEqual(update.addedPermissions, ["external:read"]);
  const updated = await registry.commitInstall(update);
  assert.ok(updated.backup);
  assert.equal(registry.get("lifecycle.plugin")?.version, "1.1.0");
  assert.equal(registry.get("lifecycle.plugin")?.active, false, "updated content requires exact re-authorization");
  assert.equal((await fs.stat(updated.backup!)).isDirectory(), true);

  const rolledBack = await registry.recover("lifecycle.plugin", "global");
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal(await fs.readFile(path.join(rolledBack.directory, "skills", "review", "SKILL.md"), "utf8"), "# Version one\n");

  const uninstallBackup = await registry.uninstall("lifecycle.plugin");
  assert.equal(registry.get("lifecycle.plugin"), undefined);
  assert.equal((await fs.stat(uninstallBackup)).isDirectory(), true);
  const recovered = await registry.recover("lifecycle.plugin", "global");
  assert.equal(recovered.version, "1.0.0");
  assert.equal(await fs.readFile(path.join(recovered.directory, "skills", "review", "SKILL.md"), "utf8"), "# Version one\n");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("installed plugin package tampering fails closed while local enable markers preserve integrity", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-integrity-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  const grants = new PermissionGrantStore(path.join(cwd, "permissions.json"));
  await writePlugin(cwd, "source", manifest("integrity.plugin"), { "skills/review/SKILL.md": "# Original\n" });
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", grants);
  const plan = await registry.prepareInstall(source, "global");
  await registry.commitInstall(plan);
  await registry.approve("integrity.plugin");

  await registry.setEnabled("integrity.plugin", false);
  assert.equal(registry.get("integrity.plugin")?.integrity, "verified");
  await registry.setEnabled("integrity.plugin", true);
  assert.equal(registry.get("integrity.plugin")?.active, true);

  const installed = registry.get("integrity.plugin")!;
  await fs.writeFile(path.join(installed.directory, "skills", "review", "SKILL.md"), "# Tampered\n", "utf8");
  await registry.refresh(true);
  assert.equal(registry.get("integrity.plugin")?.integrity, "mismatch");
  assert.equal(registry.get("integrity.plugin")?.state, "invalid");
  assert.equal(registry.get("integrity.plugin")?.active, false);
  assert.match(registry.get("integrity.plugin")?.problems.join(" ") ?? "", /locked digest/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("legacy install metadata remains identifiable and is upgraded to a verified v2 lock on update", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-legacy-lock-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  await writePlugin(cwd, "source", manifest("legacy.plugin"), { "skills/review/SKILL.md": "# Legacy source\n" });
  await writePlugin(globalRoot, "legacy.plugin", manifest("legacy.plugin"), { "skills/review/SKILL.md": "# Legacy installed\n" });
  await fs.writeFile(path.join(globalRoot, "legacy.plugin", ".xiu-install.json"), `${JSON.stringify({
    version: 1,
    source,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", new PermissionGrantStore(path.join(cwd, "permissions.json")));
  await registry.refresh(true);
  assert.equal(registry.get("legacy.plugin")?.integrity, "legacy");
  assert.equal(registry.get("legacy.plugin")?.installSource, source);

  const update = await registry.prepareUpdate("legacy.plugin");
  await registry.commitInstall(update);
  const upgraded = registry.get("legacy.plugin");
  assert.equal(upgraded?.integrity, "verified");
  assert.match(upgraded?.packageDigest ?? "", /^[a-f0-9]{64}$/);
  const metadata = JSON.parse(await fs.readFile(path.join(upgraded!.directory, ".xiu-install.json"), "utf8")) as Record<string, unknown>;
  assert.equal(metadata.version, 2);
  assert.equal(metadata.packageDigest, upgraded?.packageDigest);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("valid Ed25519 plugin signatures expose publisher identity without bypassing exact approval", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-signed-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  const trustStore = new PluginPublisherTrustStore(path.join(cwd, "publishers.json"));
  await writePlugin(cwd, "source", manifest("signed.plugin"), { "skills/review/SKILL.md": "# Signed\n" });
  await signPlugin(source, "signed.plugin", "1.0.0", "Acme Publisher");
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", new PermissionGrantStore(path.join(cwd, "permissions.json")), trustStore);

  const plan = await registry.prepareInstall(source, "global");
  assert.equal(plan.plugin.signature, "valid-untrusted");
  const installed = await registry.commitInstall(plan);
  assert.equal(installed.plugin.signature, "valid-untrusted");
  assert.equal(installed.plugin.active, false, "a valid signature must not bypass local plugin approval");
  await registry.approve("signed.plugin");
  assert.equal(registry.get("signed.plugin")?.active, true);

  const publisher = await registry.trustPublisher("signed.plugin");
  assert.match(publisher.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(publisher.name, "Acme Publisher");
  assert.equal(registry.get("signed.plugin")?.signature, "trusted");
  assert.equal(registry.get("signed.plugin")?.active, true);
  assert.equal((await registry.trustedPublishers()).length, 1);

  assert.equal(await registry.revokePublisher(publisher.fingerprint), true);
  assert.equal(registry.get("signed.plugin")?.signature, "valid-untrusted");
  assert.equal(registry.get("signed.plugin")?.active, true, "publisher trust is identity metadata, not a replacement for exact local approval");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("invalid signatures fail closed and a publisher-key replacement revokes prior plugin approval", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-signature-boundary-"));
  const source = path.join(cwd, "source");
  const invalidSource = path.join(cwd, "invalid-source");
  const globalRoot = path.join(cwd, "global-plugins");
  const grants = new PermissionGrantStore(path.join(cwd, "permissions.json"));
  const trustStore = new PluginPublisherTrustStore(path.join(cwd, "publishers.json"));
  await writePlugin(cwd, "source", manifest("key-swap.plugin"), { "skills/review/SKILL.md": "# Stable package\n" });
  await signPlugin(source, "key-swap.plugin", "1.0.0", "Publisher A");
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", grants, trustStore);
  await registry.commitInstall(await registry.prepareInstall(source, "global"));
  await registry.approve("key-swap.plugin");
  assert.equal(registry.get("key-swap.plugin")?.active, true);

  const installedDirectory = registry.get("key-swap.plugin")!.directory;
  const originalFingerprint = registry.get("key-swap.plugin")?.publisherFingerprint;
  await signPlugin(installedDirectory, "key-swap.plugin", "1.0.0", "Publisher B");
  await registry.refresh(true);
  assert.equal(registry.get("key-swap.plugin")?.signature, "valid-untrusted");
  assert.notEqual(registry.get("key-swap.plugin")?.publisherFingerprint, originalFingerprint);
  assert.equal(registry.get("key-swap.plugin")?.active, false, "publisher identity changes must invalidate exact approval");

  await writePlugin(cwd, "invalid-source", manifest("invalid-signature.plugin"), { "skills/review/SKILL.md": "# Invalid signature\n" });
  await signPlugin(invalidSource, "invalid-signature.plugin", "1.0.0");
  const signaturePath = path.join(invalidSource, PLUGIN_SIGNATURE_FILE);
  const signatureDocument = JSON.parse(await fs.readFile(signaturePath, "utf8")) as Record<string, unknown>;
  signatureDocument.packageDigest = "0".repeat(64);
  await fs.writeFile(signaturePath, `${JSON.stringify(signatureDocument, null, 2)}\n`, "utf8");
  await assert.rejects(registry.prepareInstall(invalidSource, "global"), /signature metadata does not match the package/);

  await signPlugin(invalidSource, "invalid-signature.plugin", "1.0.0");
  const cryptographicallyInvalid = JSON.parse(await fs.readFile(signaturePath, "utf8")) as { signature: string };
  cryptographicallyInvalid.signature = `${cryptographicallyInvalid.signature.startsWith("A") ? "B" : "A"}${cryptographicallyInvalid.signature.slice(1)}`;
  await fs.writeFile(signaturePath, `${JSON.stringify(cryptographicallyInvalid, null, 2)}\n`, "utf8");
  await assert.rejects(registry.prepareInstall(invalidSource, "global"), /signature verification failed/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("a corrupt publisher trust store fails closed without activating a signed plugin", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-corrupt-publisher-store-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  const trustFile = path.join(cwd, "publishers.json");
  const trustStore = new PluginPublisherTrustStore(trustFile);
  await writePlugin(cwd, "source", manifest("publisher-store.plugin"), { "skills/review/SKILL.md": "# Signed\n" });
  await signPlugin(source, "publisher-store.plugin", "1.0.0");
  await fs.writeFile(trustFile, "{broken", "utf8");
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", new PermissionGrantStore(path.join(cwd, "permissions.json")), trustStore);

  await registry.commitInstall(await registry.prepareInstall(source, "global"));
  await registry.refresh(true);
  assert.equal(registry.get("publisher-store.plugin")?.signature, "valid-untrusted");
  assert.equal(registry.get("publisher-store.plugin")?.active, false);
  await assert.rejects(trustStore.list(), /Unexpected token|JSON/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("plugin lifecycle rejects unsafe remote sources and leaves an installed plugin intact after a failed update check", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-lifecycle-safe-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  await writePlugin(cwd, "source", manifest("safe.plugin"), { "skills/review/SKILL.md": "# Safe\n" });
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.2", new PermissionGrantStore(path.join(cwd, "permissions.json")));
  const tamperedPlan = await registry.prepareInstall(source, "global");
  await fs.writeFile(path.join(tamperedPlan.stagingDirectory, "skills", "review", "SKILL.md"), "# Changed after review\n", "utf8");
  await assert.rejects(registry.commitInstall(tamperedPlan), /changed after review/);
  await registry.cancelInstall(tamperedPlan);

  const plan = await registry.prepareInstall(source, "global");
  await registry.commitInstall(plan);

  await assert.rejects(registry.prepareInstall("http://example.test/plugin.git", "global"), /must use HTTPS/);
  await assert.rejects(registry.prepareInstall("https://user:secret@example.test/plugin.git", "global"), /embedded credentials/);
  await fs.writeFile(path.join(source, "xiu.plugin.json"), "{broken", "utf8");
  await assert.rejects(registry.prepareUpdate("safe.plugin"), /not installable/);
  assert.equal(registry.get("safe.plugin")?.version, "1.0.0");
  assert.equal(await fs.readFile(path.join(registry.get("safe.plugin")!.directory, "skills", "review", "SKILL.md"), "utf8"), "# Safe\n");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("team policy blocks activation, cannot grant trust, and is rechecked at commit", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-team-policy-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  const grants = new PermissionGrantStore(path.join(cwd, "permissions.json"));
  const trust = new PluginPublisherTrustStore(path.join(cwd, "publishers.json"));
  await writePlugin(cwd, "source", manifest("policy.plugin"), { "skills/review/SKILL.md": "# Signed policy plugin\n" });
  const signer = await signPlugin(source, "policy.plugin", "1.0.0", "Policy Publisher");
  const publisherFingerprint = pluginPublisherFingerprint(signer.fingerprintKey);
  await fs.writeFile(path.join(cwd, "xiu.plugin-policy.json"), JSON.stringify({
    version: 1,
    requireSignature: true,
    allowedPublishers: [publisherFingerprint],
    deniedPermissions: [],
  }), "utf8");
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", grants, trust);
  await registry.refresh(true);
  const plan = await registry.prepareInstall(source, "global");
  assert.equal(plan.plugin.policy, "allowed");
  await registry.commitInstall(plan);
  assert.equal(registry.get("policy.plugin")?.signature, "valid-untrusted");
  assert.equal(registry.get("policy.plugin")?.active, false, "team publisher allowlisting must not grant local approval or trust");
  assert.deepEqual(await registry.trustedPublishers(), []);
  await registry.approve("policy.plugin");
  assert.equal(registry.get("policy.plugin")?.active, true);

  await fs.writeFile(path.join(cwd, "xiu.plugin-policy.json"), "{broken", "utf8");
  await registry.refresh(true);
  assert.equal(registry.get("policy.plugin")?.policy, "blocked");
  assert.equal(registry.get("policy.plugin")?.active, false);
  await assert.rejects(registry.approve("policy.plugin"), /blocked by team policy/);

  await fs.writeFile(path.join(cwd, "xiu.plugin-policy.json"), JSON.stringify({ version: 1, requireSignature: false, deniedPermissions: [] }), "utf8");
  const changedPlan = await registry.prepareInstall(source, "project");
  await fs.writeFile(path.join(cwd, "xiu.plugin-policy.json"), JSON.stringify({ version: 1, requireSignature: true, deniedPermissions: [] }), "utf8");
  await assert.rejects(registry.commitInstall(changedPlan), /policy changed after review/);
  await registry.cancelInstall(changedPlan);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("plugin installation never executes package scripts and corrupt rollback candidates preserve the current version", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-attack-matrix-"));
  const source = path.join(cwd, "source");
  const globalRoot = path.join(cwd, "global-plugins");
  const marker = path.join(cwd, "dependency-confusion-ran.txt");
  await writePlugin(cwd, "source", manifest("matrix.plugin"), {
    "skills/review/SKILL.md": "# Version one\n",
    "package.json": JSON.stringify({ name: "lookalike-package", scripts: { postinstall: `node -e \"require('fs').writeFileSync(${JSON.stringify(marker)},'ran')\"` } }),
  });
  const registry = new PluginRegistry(cwd, globalRoot, "0.14.3", new PermissionGrantStore(path.join(cwd, "permissions.json")));
  await registry.refresh(true);
  await registry.commitInstall(await registry.prepareInstall(source, "global"));
  assert.equal(await fs.stat(marker).then(() => true, () => false), false, "plugin package scripts must never execute");

  await writePlugin(cwd, "source", manifest("matrix.plugin", { version: "1.1.0" }), {
    "skills/review/SKILL.md": "# Version two\n",
    "package.json": JSON.stringify({ name: "lookalike-package", scripts: { postinstall: "exit 99" } }),
  });
  const updated = await registry.commitInstall(await registry.prepareUpdate("matrix.plugin"));
  assert.ok(updated.backup);
  await fs.writeFile(path.join(updated.backup!, "skills", "review", "SKILL.md"), "# Corrupt rollback\n", "utf8");
  await assert.rejects(registry.recover("matrix.plugin", "global"), /not recoverable/);
  assert.equal(registry.get("matrix.plugin")?.version, "1.1.0", "failed rollback validation must preserve the current plugin");
  assert.equal(await fs.readFile(path.join(registry.get("matrix.plugin")!.directory, "skills", "review", "SKILL.md"), "utf8"), "# Version two\n");
  await fs.rm(cwd, { recursive: true, force: true });
});
