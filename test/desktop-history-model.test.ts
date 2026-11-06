import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { TaskPlanManager } from "../src/plan.js";
import { AgentRuntimeAdapter } from "../src/runtime/agent-adapter.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { loadSession } from "../src/session.js";
import { TaskRunJournal } from "../src/task-run.js";

for (const action of ["continue", "reload"] as const) {
  test(`desktop ${action} applies its selected model without first adopting an incompatible historical model`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-history-model-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace"), sessions = path.join(workspace, ".xiu", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "old.jsonl"), `${JSON.stringify({ type: "task", task: "historical goal", config: { provider: "agnes", providerId: "offline", model: "unknown-model" } })}\n`);
    const restored = await loadSession(workspace, "old");
    const hosts: Array<{ agent: Agent; runtime: XiuRuntime; config: AgentConfig }> = [];
    let calls = 0;
    const controller = new DesktopTaskController(() => {}, async () => {
      const old = action === "reload" && hosts.length === 0;
      const config: AgentConfig = { cwd: workspace, provider: "agnes", providerId: "offline", model: old ? "unknown-model" : "agnes-2.5-flash", autoApprove: false,
        contextWindow: old ? 128000 : 512000, contextWindowSource: old ? "fallback" : "official", contextLimit: old ? 100000 : 300000, contextLimitMode: "configured",
        capabilities: { text: old ? "unknown-model" : "agnes-2.5-flash", vision: "selected-vision" } };
      const runtime = new XiuRuntime(), plan = new TaskPlanManager();
      const journal = new TaskRunJournal(workspace, path.join(root, "runs"));
      const agent = new Agent({ config, provider: { async complete() { calls++; return { text: "done", toolCalls: [], raw: {} }; } }, tools: [], approve: async () => false,
        planManager: plan, events: runtime.agentEvents(), taskRunJournal: journal });
      runtime.attachDriver(new AgentRuntimeAdapter(agent));
      if (old) agent.restoreSession(restored);
      hosts.push({ agent, runtime, config });
      return { agent, runtime, journal, provider: { id: "offline", label: "Offline", model: config.model } };
    });
    await controller.connect(workspace);
    if (action === "continue") await controller.continueTask(workspace, "old", "continue with the selected model");
    else await controller.reload(workspace);
    const current = hosts.at(-1)!;
    const deadline = Date.now() + 10000;
    while (["running", "waiting_approval", "stopping"].includes(current.runtime.snapshot().task?.state ?? "")) {
      assert.ok(Date.now() < deadline, "offline task must complete");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(current.agent.status().sessionId, "old");
    assert.equal(current.config.model, "agnes-2.5-flash");
    assert.equal(current.config.contextLimit, 300000);
    assert.equal(current.config.capabilities?.text, "agnes-2.5-flash");
    assert.equal(current.config.capabilities?.vision, "selected-vision");
    assert.equal((await loadSession(workspace, "old")).model, "agnes-2.5-flash");
    assert.equal(calls, action === "continue" ? 1 : 0);
    if (action === "continue") assert.equal(current.runtime.snapshot().task?.state, "completed");
    await controller.reviewSnapshot(workspace);
    controller.detach();
  });
}
