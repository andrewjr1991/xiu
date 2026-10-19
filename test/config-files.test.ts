import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigFileError } from "../src/config-file-error.js";
import { probeConfigFiles } from "../src/doctor.js";
import { PermissionGrantStore } from "../src/extension-permissions.js";
import { inspectMcpConfig, McpManager } from "../src/mcp.js";
import { inspectTrustStore, isWorkspaceTrusted, trustWorkspace } from "../src/trust.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-config-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(path.join(cwd, ".xiu"), { recursive: true });
  return {
    cwd,
    trustStore: path.join(root, "trusted-workspaces.json"),
    permissionStore: path.join(root, "extension-permissions.json"),
    mcpUserConfig: path.join(root, "mcp.json"),
    mcpProjectConfig: path.join(cwd, ".xiu", "mcp.json"),
  };
}

test("the trust store, permission store and MCP configs are inspected without throwing, and their owners still fail closed", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await inspectTrustStore(f.trustStore), { file: f.trustStore, state: "absent" });
  await trustWorkspace(f.cwd, f.trustStore);
  assert.deepEqual(await inspectTrustStore(f.trustStore), { file: f.trustStore, state: "read", workspaces: 1 });
  await fs.writeFile(f.trustStore, "{ broken");
  const trust = await inspectTrustStore(f.trustStore);
  assert.equal(trust.state, "unreadable");
  assert.match(trust.cause!, /JSON/);
  await assert.rejects(isWorkspaceTrusted(f.cwd, f.trustStore), /Unable to read Xiu trust store at .*trusted-workspaces\.json/, "trust still fails closed");
  await assert.rejects(isWorkspaceTrusted(f.cwd, f.trustStore), (error: unknown) => error instanceof ConfigFileError && error.kind === "trust-store" && error.file === f.trustStore && error.code === undefined,
    "the failure names its file kind so the CLI can explain it");
  await fs.writeFile(f.trustStore, JSON.stringify({ version: 2, workspaces: [] }));
  assert.equal((await inspectTrustStore(f.trustStore)).cause, "invalid trust store structure");

  const grants = new PermissionGrantStore(f.permissionStore);
  assert.deepEqual(await grants.inspect(), { file: f.permissionStore, state: "absent" });
  await grants.approve({ kind: "skill", name: "deploy", origin: f.cwd, permissions: ["instructions:load"], declared: true });
  assert.deepEqual(await grants.inspect(), { file: f.permissionStore, state: "read", grants: 1 });
  await fs.writeFile(f.permissionStore, JSON.stringify({ version: 1, grants: [] }));
  assert.deepEqual(await grants.inspect(), { file: f.permissionStore, state: "unreadable", cause: "invalid permission grant store" });
  await assert.rejects(grants.isApproved({ kind: "skill", name: "deploy", origin: f.cwd, permissions: ["instructions:load"], declared: true }),
    /Unable to read the extension permission store at .*extension-permissions\.json: invalid permission grant store/, "approval checks still fail closed, now naming the file");
  await fs.rm(f.permissionStore);
  await fs.mkdir(f.permissionStore);
  assert.equal((await grants.inspect()).cause, "EISDIR");
  await assert.rejects(grants.approvedManifest({ kind: "skill", name: "deploy", origin: f.cwd, permissions: ["instructions:load"], declared: true }),
    (error: unknown) => error instanceof ConfigFileError && error.kind === "extension-permissions" && error.file === f.permissionStore && error.code === "EISDIR");

  assert.deepEqual(await inspectMcpConfig(f.mcpUserConfig), { file: f.mcpUserConfig, state: "absent" });
  await fs.writeFile(f.mcpUserConfig, JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["docs-mcp"] }, api: { url: "https://mcp.example/sse" } } }));
  assert.deepEqual(await inspectMcpConfig(f.mcpUserConfig), { file: f.mcpUserConfig, state: "read", servers: 2 });
  await fs.writeFile(f.mcpUserConfig, "not json");
  const mcp = await inspectMcpConfig(f.mcpUserConfig);
  assert.equal(mcp.state, "unreadable");
  assert.match(mcp.cause!, /^Invalid MCP JSON in mcp\.json: /, "the cause names the file by its base name only");
  assert.doesNotMatch(mcp.cause!, new RegExp(f.cwd.replace(/[\\/]/g, "[\\\\/]")));
  await fs.writeFile(f.mcpUserConfig, JSON.stringify({ mcpServers: [] }));
  assert.equal((await inspectMcpConfig(f.mcpUserConfig)).cause, "MCP config mcp.json must contain an mcpServers object");
  await assert.rejects(new McpManager(f.cwd, f.mcpUserConfig).start(false), (error: unknown) => error instanceof ConfigFileError && error.kind === "mcp" && error.file === f.mcpUserConfig
    && error.message === `MCP config ${f.mcpUserConfig} must contain an mcpServers object`, "the manager still refuses the file, as a ConfigFileError");
  await fs.writeFile(f.mcpUserConfig, JSON.stringify({ mcpServers: { bad: {} } }));
  await assert.rejects(new McpManager(f.cwd, f.mcpUserConfig).start(false), (error: unknown) => error instanceof ConfigFileError && error.kind === "mcp"
    && error.message === "MCP server bad requires exactly one of command or url", "an invalid server entry keeps its message");
});

test("probeConfigFiles reads the workspace MCP config only for a trusted workspace and says why otherwise", async (t) => {
  const f = await fixture(t);
  const options = { trustStore: f.trustStore, permissionStore: f.permissionStore, mcpUserConfig: f.mcpUserConfig };
  await fs.writeFile(f.mcpProjectConfig, JSON.stringify({ mcpServers: { local: { command: "node", args: ["server.js"] } } }));

  const untrusted = await probeConfigFiles(f.cwd, options);
  assert.deepEqual(untrusted, [
    { id: "trust-store", state: "absent" },
    { id: "extension-permissions", state: "absent" },
    { id: "mcp-user", state: "absent" },
    { id: "mcp-project", state: "skipped", cause: "untrusted" },
  ], "an untrusted workspace's project file is not read at all");

  await trustWorkspace(f.cwd, f.trustStore);
  const trusted = await probeConfigFiles(f.cwd, options);
  assert.deepEqual(trusted[0], { id: "trust-store", state: "read", count: 1 });
  assert.deepEqual(trusted[3], { id: "mcp-project", state: "read", count: 1 });

  await fs.writeFile(f.mcpProjectConfig, "{");
  assert.equal((await probeConfigFiles(f.cwd, options))[3]!.state, "unreadable");

  await fs.writeFile(f.trustStore, "{ broken");
  const unknown = await probeConfigFiles(f.cwd, options);
  assert.equal(unknown[0]!.state, "unreadable");
  assert.deepEqual(unknown[3], { id: "mcp-project", state: "skipped", cause: "trust-unknown" }, "with the trust store damaged, trust is unknown and the project file stays unread");
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(f.cwd.replace(/[\\/]/g, "[\\\\/]")), "no path in the probe");
});
