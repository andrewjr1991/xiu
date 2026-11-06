import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { DesktopTaskController } from "../apps/desktop/main/task-controller.js";
import { TaskRunJournal } from "../src/task-run.js";
import { XiuRuntime, type RuntimeTaskDriver } from "../src/runtime/xiu-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

for (const closeFails of [false, true]) {
  test(`desktop shutdown drains finished-event IO when host close ${closeFails ? "fails" : "succeeds"}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-shutdown-events-"));
    const journal = new TaskRunJournal(root, path.join(root, "journals"));
    const saved = await journal.begin({ sessionId: "fixture", task: "fixture", providerId: "offline", model: "offline" });
    await journal.complete("completed");
    const runtime = new XiuRuntime(), finish = deferred<string>();
    let outcome: ReturnType<RuntimeTaskDriver["status"]>["outcome"] = "idle";
    runtime.attachDriver({ run: () => { outcome = "running"; return finish.promise; }, cancel: () => false,
      steer: () => false, status: () => ({ outcome, planMode: false }) });
    const controller = new DesktopTaskController(() => {}, async () => ({ runtime, journal, close: async () => { if (closeFails) throw new Error("fixture close failure"); }, provider: { id: "offline", label: "offline", model: "offline" } }));
    const discoveryEntered = deferred<void>(), releaseDiscovery = deferred<void>();
    const saveEntered = deferred<void>(), releaseSave = deferred<void>();
    const originalRecent = journal.recent.bind(journal), originalSave = journal.saveRuntimeEvents.bind(journal);
    await controller.connect(root);
    journal.recent = async limit => { discoveryEntered.resolve(); await releaseDiscovery.promise; return originalRecent(limit); };
    journal.saveRuntimeEvents = async (id, events) => { saveEntered.resolve(); await releaseSave.promise; return originalSave(id, events); };
    // Always drain controlled work before removing private fixture files, including on assertion failure.
    t.after(async () => {
      releaseDiscovery.resolve(); releaseSave.resolve();
      await controller.computerAcceptance(root, { taskId: saved.runId });
      await controller.shutdown().catch(error => { assert.equal(error.message, "fixture close failure"); });
      await fs.rm(root, { recursive: true, force: true });
    });
    const running = runtime.createTask("offline fixture");
    outcome = "completed"; finish.resolve("done"); await running;
    await discoveryEntered.promise;
    let returned = false;
    const shuttingDown = controller.shutdown().then(() => { returned = true; return undefined; }, error => { returned = true; return error as Error; });
    await nextTurn();
    assert.equal(returned, false, "shutdown returned while finished-event discovery was still reading");
    releaseDiscovery.resolve(); await saveEntered.promise; await nextTurn();
    assert.equal(returned, false, "shutdown returned before finished events were persisted");
    releaseSave.resolve();
    const failure = await shuttingDown;
    if (closeFails) assert.equal(failure?.message, "fixture close failure"); else assert.equal(failure, undefined);
    assert.ok((await journal.read(saved.runId))?.runtimeEvents?.some(event => event.type === "task.finished"));
  });
}
