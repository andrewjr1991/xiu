import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { Agent } from "../src/agent.js";
import { TaskPlanManager } from "../src/plan.js";
import { AgentRuntimeAdapter } from "../src/runtime/agent-adapter.js";
import { XiuRuntime } from "../src/runtime/xiu-runtime.js";
import { TaskRunJournal } from "../src/task-run.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

for (const action of ["create", "continue", "recover", "continue-model", "abandon"] as const) {
  test(`desktop ${action} rejects ${action === "abandon" ? "abandonment" : "task start"} if Full Access confirmation begins during ${action === "continue-model" ? "model persistence" : "journal preflight"}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-desktop-start-context-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace"), sessions = path.join(workspace, ".xiu", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const file = path.join(sessions, "old.jsonl"), body = `${JSON.stringify({ type: "task", task: "old goal" })}\n`;
    await fs.writeFile(file, body);
    const runtime = new XiuRuntime(), journal = new TaskRunJournal(workspace, path.join(root, "runs"));
    const finish = deferred<void>();
    let requests = 0;
    const agent = new Agent({ config: { cwd: workspace, provider: "openai", providerId: "offline", model: "offline", autoApprove: false },
      provider: { async complete() { requests++; await finish.promise; return { text: "done", toolCalls: [], raw: {} }; } }, tools: [], approve: async () => false,
      planManager: new TaskPlanManager(), taskRunJournal: journal, events: runtime.agentEvents() });
    runtime.attachDriver(new AgentRuntimeAdapter(agent));
    const controller = new DesktopTaskController(() => {}, async () => ({ agent, runtime, journal, provider: { id: "offline", label: "Offline", model: "offline" } }));
    let recoveryRun: string | undefined;
    if (action === "recover" || action === "abandon") {
      const paused = await journal.begin({ sessionId: "old", task: "old goal", providerId: "offline", model: "offline" });
      await journal.pause("fixture safe pause");
      recoveryRun = paused.runId;
      runtime.recordRecovery({ runId: paused.runId, status: "paused", interruptedOperations: 0, unknownSideEffects: 0, recommendation: "Resume only after confirmation" });
    }
    const initial = await controller.connect(workspace);
    const initialTask = structuredClone(runtime.snapshot().task);
    const entered = deferred<void>(), release = deferred<void>(), confirming = deferred<void>(), confirmation = deferred<boolean>();
    const lockStatus = journal.lockStatus.bind(journal);
    let held = false;
    if (action === "continue-model") {
      const open = fs.open.bind(fs);
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (typeof args[1] === "number" && (args[1] & constants.O_APPEND)) {
          const append = handle.appendFile.bind(handle);
          t.mock.method(handle, "appendFile", async (...data: Parameters<typeof handle.appendFile>) => {
            if (!held && String(data[0]).includes('"type":"model_changed"')) { held = true; entered.resolve(); await release.promise; }
            return append(...data);
          });
        }
        return handle;
      });
    } else if (action === "recover" || action === "abandon") {
      const interrupted = journal.interrupted.bind(journal);
      t.mock.method(journal, "interrupted", async () => {
        if (!held) { held = true; entered.resolve(); await release.promise; }
        return interrupted();
      });
    } else t.mock.method(journal, "lockStatus", async () => {
      if (!held) { held = true; entered.resolve(); await release.promise; }
      return lockStatus();
    });
    const starting = action === "create" ? controller.createTask(workspace, "new task")
      : action.startsWith("continue") ? controller.continueTask(workspace, "old", "continue task")
      : action === "recover" ? controller.recoverTask(workspace, { runId: recoveryRun! }, false)
      : controller.abandonRecovery(workspace, { runId: recoveryRun! }, true);
    await entered.promise;
    const current = action === "continue-model" ? await controller.connect(workspace) : initial;
    const selecting = controller.setApprovalMode(workspace, { mode: "full", contextId: current.modeContextId! }, () => { confirming.resolve(); return confirmation.promise; });
    const selected = selecting.catch(() => undefined);
    await confirming.promise;
    try {
      const rejected = assert.rejects(starting, /任务|配置|上下文/);
      release.resolve();
      await rejected;
      assert.equal(requests, 0);
      if (action === "abandon") assert.equal((await journal.read(recoveryRun!))?.status, "paused");
      assert.deepEqual(runtime.snapshot().task, initialTask);
      assert.equal(agent.status().sessionId, action === "continue-model" ? "old" : undefined);
      const records = await fs.readFile(file, "utf8");
      if (action === "continue-model") {
        const parsed = records.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
        assert.deepEqual(parsed.map((record) => record.type), ["task", "model_changed"]);
      } else assert.equal(records, body);
    } finally {
      release.resolve(); confirmation.resolve(false); finish.resolve();
      await selected;
      await starting.catch(() => undefined);
      const deadline = Date.now() + 10000;
      while (["running", "waiting_approval", "stopping"].includes(runtime.snapshot().task?.state ?? "")) {
        assert.ok(Date.now() < deadline, "offline cleanup must finish");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await controller.reviewSnapshot(workspace);
      controller.detach();
    }
  });
}
