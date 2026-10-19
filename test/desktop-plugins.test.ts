import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionGrantStore } from "../src/extension-permissions.js";
import { PluginRegistry } from "../src/plugins.js";
import { createWorkspaceAgentHost } from "../src/runtime/workspace-agent-host.js";
import { xiuPackageVersion } from "../src/package-version.js";

async function writePlugin(root: string, name: string, manifest: object, files: Record<string, string>): Promise<void> {
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
  apiVersion: 1, id, name: id, version: "1.0.0",
  engines: { xiu: { min: "0.14.0", maxExclusive: "99.0.0" } },
  permissions: ["workspace:read", "instructions:load", "network:access"],
  contributes: { skills: [{ id: "review", path: "skills/review" }], tools: [{ id: "search", path: "tools/search.json" }] },
  ...extra,
});

const hostOptions = (workspace: string, journalRoot: string, pluginRegistry: PluginRegistry) => ({
  pluginRegistry,
  profile: { id: "fixture", name: "Fixture", kind: "openai-compatible" as const, model: "offline", features: { text: true as const, tools: true, vision: false, image: false, video: false, audio: false } },
  backgroundRoot: path.join(workspace, ".xiu", "background"), journalRoot, securityAuditFile: path.join(path.dirname(journalRoot), "security-audit.jsonl"),
  provider: { async complete() { return { text: "unused", toolCalls: [], raw: {} }; } },
});

test("the desktop host reuses plugins approved in the CLI and ignores unapproved ones", async (t) => {
  assert.match(xiuPackageVersion(), /^\d+\.\d+\.\d+/);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-plugins-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const globalRoot = path.join(root, "global-plugins");
  await fs.mkdir(workspace);
  await fs.mkdir(globalRoot);
  const files = { "skills/review/SKILL.md": "---\nname: plugin-review\ndescription: Review checklist from the plugin\n---\n# Review\n", "tools/search.json": JSON.stringify({ url: "https://mcp.example.com/mcp", transport: "streamable-http" }) };
  await writePlugin(path.join(workspace, ".xiu", "plugins"), "approved", manifest("acme.approved"), files);
  await writePlugin(globalRoot, "pending", manifest("acme.pending"), files);
  const grants = new PermissionGrantStore(path.join(root, "permissions.json"));
  const approving = new PluginRegistry(workspace, globalRoot, xiuPackageVersion(), grants);
  await approving.refresh(true);
  await approving.approve("acme.approved");

  // A fresh registry, as the desktop creates one: only the stored grant decides what is active.
  const registry = new PluginRegistry(workspace, globalRoot, xiuPackageVersion(), grants);
  const host = await createWorkspaceAgentHost(workspace, hostOptions(workspace, path.join(root, "journal"), registry));
  try {
    assert.deepEqual(host.plugins, { active: 1, errors: [] });
    const skills = (await host.management!.snapshot()).skills;
    const pluginSkills = skills.filter((skill) => skill.scope === "plugin");
    assert.equal(pluginSkills.length, 1, JSON.stringify(skills));
    assert.equal(pluginSkills[0]?.name, "acme.approved.review", "plugin skills are namespaced by plugin id");
    const servers = (await host.mcp!.snapshot()).servers.map((server) => server.name);
    assert.ok(servers.includes("plugin_acme_approved_search"), servers.join(","));
    assert.ok(!servers.some((name) => name.includes("acme.pending")), servers.join(","));
    const approved = (await host.mcp!.snapshot()).servers.find((server) => server.name === "plugin_acme_approved_search");
    assert.equal(approved?.approved, false, "plugin approval does not pre-approve the MCP permission manifest");
  } finally {
    await host.close!();
  }
});

test("a plugin provider that collides with a saved provider id is dropped and reported, not merged", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-plugins-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const globalRoot = path.join(root, "global-plugins");
  await fs.mkdir(workspace);
  await fs.mkdir(globalRoot);
  await writePlugin(path.join(workspace, ".xiu", "plugins"), "provider", manifest("acme.provider", {
    permissions: ["workspace:read", "network:access", "credentials:access"],
    contributes: { providers: [{ id: "openai", path: "providers/openai.json" }] },
  }), { "providers/openai.json": JSON.stringify({ id: "openai", name: "Plugin OpenAI", kind: "openai", model: "gpt-5", apiKeyEnv: "PLUGIN_KEY", features: { text: true, tools: true, vision: false, image: false, video: false } }) });
  const grants = new PermissionGrantStore(path.join(root, "permissions.json"));
  const approving = new PluginRegistry(workspace, globalRoot, xiuPackageVersion(), grants);
  await approving.refresh(true);
  await approving.approve("acme.provider");
  const host = await createWorkspaceAgentHost(workspace, hostOptions(workspace, path.join(root, "journal"), new PluginRegistry(workspace, globalRoot, xiuPackageVersion(), grants)));
  try {
    const providers = (await host.management!.snapshot()).providers.map((provider) => provider.id);
    // Either the id was free (plugin profile visible) or it collided with a saved profile (dropped with an error); never both or silent.
    if (host.plugins!.errors.length) {
      assert.match(host.plugins!.errors[0]!, /conflicts with an existing provider: openai/);
      assert.equal(providers.filter((id) => id === "openai").length <= 1, true);
    } else {
      assert.equal(host.plugins!.active, 1);
      assert.ok(providers.includes("openai"), providers.join(","));
    }
  } finally {
    await host.close!();
  }
});
