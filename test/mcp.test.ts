import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

test("MCP manager discovers namespaced tools and calls a stdio server", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.mkdir(path.join(workspace, ".xiu"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".xiu", "mcp.json"), JSON.stringify({
    mcpServers: {
      test: {
        command: process.execPath,
        args: [fixture],
        risk: "read",
        toolRisks: { change: "write" },
        toolChangesWorkspace: { change: true },
      },
    },
  }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    const statuses = await manager.start();
    assert.deepEqual(statuses, [{ name: "test", state: "connected", tools: 2 }]);
    const tools = manager.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp__test__echo", "mcp__test__change"]);
    assert.equal(tools[0]?.risk, "read");
    assert.equal(tools[0]?.changesWorkspace, false);
    assert.equal(tools[1]?.risk, "write");
    assert.equal(tools[1]?.changesWorkspace, true);
    assert.equal(await tools[0]?.execute({ message: "hello" }, { cwd: workspace, approve: async () => true }), "echo:hello");
    const controller = new AbortController();
    const pending = tools[0]!.execute({ message: "slow" }, { cwd: workspace, approve: async () => true, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.match(manager.summary(), /test: connected \(2 tools\)/);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("project MCP configuration overrides a global server and can disable it", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-config-"));
  const globalConfig = path.join(workspace, "global-mcp.json");
  await fs.mkdir(path.join(workspace, ".xiu"), { recursive: true });
  await fs.writeFile(globalConfig, JSON.stringify({ mcpServers: { shared: { command: process.execPath, args: [fixture] } } }));
  await fs.writeFile(path.join(workspace, ".xiu", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: process.execPath, enabled: false } } }));
  const manager = new McpManager(workspace, globalConfig);
  try {
    assert.deepEqual(await manager.start(), []);
    assert.equal(manager.tools().length, 0);
    assert.deepEqual(await manager.start(false), [{ name: "shared", state: "connected", tools: 2 }]);
  } finally {
    await manager.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
