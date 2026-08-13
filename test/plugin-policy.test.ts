import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluatePluginPolicy, loadPluginTeamPolicy, pluginPolicyRevision } from "../src/plugin-policy.js";

const subject = {
  scope: "global" as const,
  installSource: "https://plugins.example.test/acme.git",
  signature: "valid-untrusted" as const,
  publisherFingerprint: "a".repeat(64),
  permissions: ["workspace:read" as const],
};

test("team plugin policy is strict, canonical, and only loaded for trusted workspaces", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-policy-"));
  const file = path.join(cwd, "xiu.plugin-policy.json");
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    requireSignature: true,
    allowedSources: ["https://plugins.example.test/acme.git"],
    allowedPublishers: [`sha256:${"a".repeat(64)}`],
    deniedPermissions: ["process:execute"],
  }), "utf8");

  const hidden = await loadPluginTeamPolicy(cwd, false);
  assert.equal(hidden.state, "not-loaded");
  const loaded = await loadPluginTeamPolicy(cwd, true);
  assert.equal(loaded.state, "active");
  assert.match(pluginPolicyRevision(loaded), /^active:[a-f0-9]{64}$/);
  assert.deepEqual(evaluatePluginPolicy(loaded, subject), []);
  assert.deepEqual(evaluatePluginPolicy(loaded, { ...subject, signature: "unsigned" }), ["team policy requires a valid plugin signature"]);
  assert.deepEqual(evaluatePluginPolicy(loaded, { ...subject, publisherFingerprint: "b".repeat(64) }), ["plugin publisher is not in the team allowlist"]);
  assert.deepEqual(evaluatePluginPolicy(loaded, { ...subject, installSource: "https://lookalike.example.test/acme.git" }), ["plugin source is not in the team allowlist"]);
  assert.deepEqual(evaluatePluginPolicy(loaded, { ...subject, permissions: ["process:execute"] }), ["team policy denies permissions: process:execute"]);

  await fs.writeFile(file, JSON.stringify({ version: 1, requireSignature: false, deniedPermissions: [], autoApprove: true }), "utf8");
  const expanded = await loadPluginTeamPolicy(cwd, true);
  assert.equal(expanded.state, "invalid");
  assert.match(expanded.problem ?? "", /unknown fields/);
  assert.match(evaluatePluginPolicy(expanded, subject)[0] ?? "", /policy is invalid/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("team plugin policy rejects symlinks and malformed allowlists", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-policy-boundary-"));
  const outside = path.join(cwd, "outside.json");
  await fs.writeFile(outside, JSON.stringify({ version: 1, requireSignature: false, deniedPermissions: [] }), "utf8");
  try {
    await fs.symlink(outside, path.join(cwd, "xiu.plugin-policy.json"), "file");
    assert.equal((await loadPluginTeamPolicy(cwd, true)).state, "invalid");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    t.diagnostic("symlink creation unavailable; malformed policy coverage still ran");
  }
  await fs.rm(path.join(cwd, "xiu.plugin-policy.json"), { force: true });
  await fs.writeFile(path.join(cwd, "xiu.plugin-policy.json"), JSON.stringify({
    version: 1,
    requireSignature: false,
    allowedSources: ["http://insecure.example.test/plugin.git"],
    deniedPermissions: [],
  }), "utf8");
  assert.equal((await loadPluginTeamPolicy(cwd, true)).state, "invalid");
  await fs.rm(cwd, { recursive: true, force: true });
});
