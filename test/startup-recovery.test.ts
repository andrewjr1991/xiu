import assert from "node:assert/strict";
import test from "node:test";
import { resolveStartupRecovery, type StartupRecoveryChoice, type StartupRecoveryContext } from "../src/commands/session-commands.js";
import type { RestoredSession } from "../src/session.js";
import { recoveryContinuation, type InterruptedTaskRun } from "../src/task-run.js";

const plain = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

const run = (overrides: Partial<InterruptedTaskRun> = {}): InterruptedTaskRun => ({
  version: 1,
  runId: "abcdef1234567890",
  workspaceId: "ws",
  sessionId: "session-1",
  taskPreview: "rename the helpers",
  providerId: "openai",
  model: "gpt-x",
  status: "running",
  startedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:01:00.000Z",
  ownerPid: 1,
  recoveryPoints: [{ evidence: "checkpoint 2 saved", at: "2026-10-20T10:00:30.000Z", operationIndex: 1 }],
  operations: [],
  interruptedOperations: [],
  pendingSideEffects: [{ kind: "command", name: "npm test", sideEffect: "unknown", replay: "forbidden", status: "unknown", startedAt: "2026-10-20T10:00:40.000Z" }],
  recommendation: "verify",
  ...overrides,
} as unknown as InterruptedTaskRun);

const session: RestoredSession = { id: "session-1", providerId: "openai", model: "gpt-x", messages: [], replay: [] } as unknown as RestoredSession;

function harness(options: { interrupted?: InterruptedTaskRun | Error; oneShot?: boolean; choice?: StartupRecoveryChoice; language?: "zh-CN" | "en-US"; loadError?: Error } = {}) {
  const logs: string[] = [];
  const refusals: string[] = [];
  const calls: string[] = [];
  const prompts: Array<{ title: string; options: string[] }> = [];
  const context: StartupRecoveryContext = {
    config: { cwd: "/workspace" },
    language: options.language ?? "en-US",
    oneShot: options.oneShot ?? false,
    refuseToStart: (message) => { refusals.push(message); },
    taskRunJournal: {
      interrupted: async () => {
        if (options.interrupted instanceof Error) throw options.interrupted;
        return options.interrupted;
      },
      abandon: async (runId) => { calls.push(`abandon:${runId}`); },
    },
    io: {
      log: (line) => { logs.push(plain(line)); },
      select: async (title, selectOptions, language) => {
        prompts.push({ title: plain(title), options: selectOptions.map((item) => `${item.value}:${item.label}:${item.description}`) });
        calls.push(`select:${language}`);
        return options.choice;
      },
      loadSession: async (cwd, sessionId) => {
        calls.push(`load:${cwd}:${sessionId}`);
        if (options.loadError) throw options.loadError;
        return session;
      },
    },
  };
  return { context, logs, refusals, calls, prompts };
}

test("a clean journal starts normally without printing anything", async () => {
  const h = harness();
  assert.deepEqual(await resolveStartupRecovery(h.context), { action: "none" });
  assert.deepEqual([h.logs, h.refusals, h.calls], [[], [], []]);
});

test("an unreadable journal refuses to start so nothing is replayed by mistake", async () => {
  const h = harness({ interrupted: new Error("journal locked") });
  assert.deepEqual(await resolveStartupRecovery(h.context), { action: "refused" });
  assert.deepEqual(h.refusals, ["The task recovery journal could not be read: journal locked. Xiu will not start a new task because replay safety cannot be established."]);
  assert.deepEqual(h.calls, []);
});

test("an interrupted run in front of a one-shot task refuses to start and names the abandon command", async () => {
  const h = harness({ interrupted: run(), oneShot: true });
  assert.deepEqual(await resolveStartupRecovery(h.context), { action: "refused" });
  assert.deepEqual(h.refusals, ["Interrupted task abcdef12 was detected. Start xiu without a task in an interactive terminal to resume or abandon it, or run xiu recover abandon abcdef12 to abandon it explicitly, before running a new task."]);
  assert.deepEqual(h.calls, [], "no menu, no abandon");
});

test("the interactive start shows the run and a cancelled menu (no terminal) leaves the record alone and fails the start", async () => {
  const h = harness({ interrupted: run() });
  assert.deepEqual(await resolveStartupRecovery(h.context), { action: "exit", failed: true });
  assert.deepEqual(h.logs, ["Interrupted task detected: rename the helpers\nLast recovery point: checkpoint 2 saved\nSide effects awaiting verification: 1. Xiu will not replay them automatically."]);
  assert.deepEqual(h.prompts, [{
    title: "How should the interrupted task be handled?",
    options: [
      "resume:Resume after confirmation:Restore the session, verify unknown side effects, then continue",
      "abandon:Abandon old task:Mark it abandoned without executing any old operation",
      "exit:Exit:Keep the recovery record and do nothing",
    ],
  }]);
  assert.deepEqual(h.calls, ["select:en-US"], "nothing abandoned or loaded");
});

test("choosing Exit keeps the record and is a clean exit", async () => {
  const h = harness({ interrupted: run(), choice: "exit" });
  assert.deepEqual(await resolveStartupRecovery(h.context), { action: "exit", failed: false });
  assert.deepEqual(h.calls, ["select:en-US"]);
});

test("abandoning marks the run abandoned and replays nothing", async () => {
  const h = harness({ interrupted: run(), choice: "abandon" });
  assert.deepEqual(await resolveStartupRecovery(h.context), { action: "abandoned" });
  assert.deepEqual(h.calls, ["select:en-US", "abandon:abcdef1234567890"]);
  assert.equal(h.logs.at(-1), "The old task was abandoned; no operation was replayed.\n");
});

test("confirmed recovery loads the linked session and hands back the continuation; a load failure keeps the record", async () => {
  const interrupted = run();
  const ok = harness({ interrupted, choice: "resume" });
  const outcome = await resolveStartupRecovery(ok.context);
  assert.deepEqual(outcome, { action: "resume", run: interrupted, restored: session, continuation: recoveryContinuation(interrupted, "en-US") });
  assert.deepEqual(ok.calls, ["select:en-US", "load:/workspace:session-1"]);

  const failed = harness({ interrupted, choice: "resume", loadError: new Error("missing log") });
  assert.deepEqual(await resolveStartupRecovery(failed.context), { action: "exit", failed: false });
  assert.equal(failed.logs.at(-1), "The linked session could not be loaded: missing log. The recovery record was preserved.");
  assert.ok(!failed.calls.some((call) => call.startsWith("abandon:")), "the record is never abandoned on a failed load");
});

test("Chinese wording is used when the session language is zh-CN", async () => {
  const h = harness({ interrupted: run({ taskPreview: "", recoveryPoints: [] }), choice: "abandon", language: "zh-CN" });
  await resolveStartupRecovery(h.context);
  assert.deepEqual(h.logs, [
    "检测到异常中断任务：（无摘要）\n最后恢复点：尚无安全恢复点\n待核验副作用：1 项。Xiu 不会自动重放这些操作。",
    "旧任务已标记为放弃；没有重放任何操作。\n",
  ]);
  assert.equal(h.prompts[0]?.title, "如何处理异常中断任务？");
  assert.deepEqual(h.calls, ["select:zh-CN", "abandon:abcdef1234567890"]);
});
