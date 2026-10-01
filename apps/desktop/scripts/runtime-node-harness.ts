import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function run(): Promise<void> {
await fs.writeFile(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ stage: "ready" }));
const { McpManager, resolveStdioLaunch } = await import("../../../src/mcp.js");
const { PermissionGrantStore } = await import("../../../src/extension-permissions.js");
const { resolveNodeRuntime } = await import("../../../src/node-runtime.js");
const { configureBackgroundRuntime, configureBackgroundWorkspace, startBackgroundProcess, listBackgroundProcesses, readBackgroundProcessOutput, stopAllBackgroundProcesses } = await import("../../../src/background.js");
const root = await fs.mkdtemp(path.join(repo, ".desktop-build-temp", "electron-node-"));
await fs.mkdir(path.join(root, "user-data"));
app.setPath("userData", path.join(root, "user-data"));
await app.whenReady();
let manager: InstanceType<typeof McpManager> | undefined;
try {
  // Exercise the Electron branch with a broken inherited PATH; only existing NVM installation is used.
  const inherited = process.env.PATH;
  process.env.PATH = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const node = await resolveNodeRuntime();
  assert.notEqual(node.toLowerCase(), process.execPath.toLowerCase());
  const launch = await resolveStdioLaunch("npx.cmd", ["--version"]);
  assert.equal(launch.command, node);
  const config = path.join(root, "mcp.json");
  await fs.writeFile(config, JSON.stringify({ mcpServers: { local: { command: "node", args: [path.join(repo, "test", "fixtures", "mcp-server.mjs")], risk: "read" } } }));
  manager = new McpManager(root, config);
  await manager.approvePermissions("local"); // isolated fixture only, never grants a real user configuration.
  const statuses = await manager.start(false);
  assert.equal(statuses[0]?.state, "connected");
  assert.equal(statuses[0]?.tools, 2);
  await manager.close();
  configureBackgroundWorkspace(root, path.join(root, "background"));
  configureBackgroundRuntime(node, process.env.XIU_PACKAGED_WORKER ?? path.join(repo, "apps", "desktop", "dist", "main", "background-worker.mjs"));
  const command = process.platform === "win32" ? `& '${node.replace(/'/g, "''")}' -e "console.log('desktop-worker-canary')"` : `"${node}" -e "console.log('desktop-worker-canary')"`;
  const processRecord = startBackgroundProcess(command, root);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && listBackgroundProcesses().find((item) => item.id === processRecord.id)?.running) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(listBackgroundProcesses().find((item) => item.id === processRecord.id)?.state, "completed");
  assert.match(readBackgroundProcessOutput(processRecord.id).text, /desktop-worker-canary/);
  process.env.PATH = inherited;
  console.log("Electron Node/MCP fixture/background worker: passed");
  if (process.env.XIU_MCP_REAL_CONFIG) {
    const real = process.env.XIU_MCP_REAL_CONFIG;
    const parsed = JSON.parse(await fs.readFile(real, "utf8"));
    assert.ok(parsed.mcpServers?.everything);
    const isolated = path.join(root, "everything.json");
    await fs.writeFile(isolated, JSON.stringify({ mcpServers: { everything: parsed.mcpServers.everything } }));
    manager = new McpManager("D:\\QoderWork Project\\snake", isolated, undefined, undefined, new PermissionGrantStore(path.join(path.dirname(real), "extension-permissions.json")));
    const result = await manager.start(false);
    console.log(JSON.stringify({ realMcp: result.map(({ name, state, tools }) => ({ name, state, tools })) }));
    assert.equal(result[0]?.state, "connected", (await manager.serverTextSanitizer("everything"))(result[0]?.error ?? ""));
    assert.ok(result[0]!.tools >= 1);
  }
  await manager?.close();
  await stopAllBackgroundProcesses();
  await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ passed: true }));
  app.exit(0);
} catch (error) {
  await manager?.close();
  await stopAllBackgroundProcesses().catch(() => undefined);
  console.error(error instanceof Error ? error.message : "Runtime smoke failed");
  await fs.writeFile(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) }));
  app.exit(1);
}
}
app.on("window-all-closed", () => {});
void app.whenReady().then(() => { new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } }); return run(); }).catch(async (error) => { await fs.writeFile(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ passed: false, error: String(error) })); app.exit(1); });
