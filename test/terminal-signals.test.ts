import assert from "node:assert/strict";
import test from "node:test";
import { installTerminalSignals, type TerminalSignalsContext, type TerminalSignalsIo } from "../src/terminal-signals.js";

type Handler = (signal: NodeJS.Signals) => void;

function harness(options: { language?: "zh-CN" | "en-US" } = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const calls: string[] = [];
  const handlers = new Map<NodeJS.Signals, Handler[]>();
  let brokenPipe: (() => boolean) | undefined;
  const state: { check?: { abort: () => void }; preparation?: { abort: () => void }; running: boolean; view?: { setPhase: (value: string) => void } } = { running: false };
  const io: TerminalSignalsIo = {
    log: (line) => { logs.push(line); },
    error: (line) => { errors.push(line); },
    exit: (code) => { exits.push(code); },
    process: {
      on: (signal, handler) => { handlers.set(signal, [...(handlers.get(signal) ?? []), handler]); },
      off: (signal, handler) => { handlers.set(signal, (handlers.get(signal) ?? []).filter((item) => item !== handler)); },
    },
    setBrokenPipeHandler: (handler) => { brokenPipe = handler; },
  };
  const context: TerminalSignalsContext = {
    language: () => options.language ?? "en-US",
    status: { stop: () => { calls.push("status:stop"); } },
    activeCheck: () => state.check,
    activeTaskPreparation: () => state.preparation,
    stopTask: () => { calls.push("stopTask"); return state.running; },
    runningTaskView: () => state.view,
    io,
  };
  const signals = installTerminalSignals(context);
  const fire = (signal: NodeJS.Signals): void => { for (const handler of handlers.get(signal) ?? []) handler(signal); };
  const abortable = (name: string) => ({ abort: () => { calls.push(`abort:${name}`); } });
  return { signals, logs, errors, exits, calls, handlers, fire, state, abortable, brokenPipe: () => brokenPipe };
}

const plain = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

test("installs SIGINT, SIGTERM and SIGHUP handlers plus the broken-pipe hook, and dispose removes the handlers", () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  assert.equal(typeof h.brokenPipe(), "function");
  assert.equal(h.signals.shutdownRequested(), false);
  assert.equal(h.signals.idleSignal.aborted, false);
  h.signals.dispose();
  assert.deepEqual([...h.handlers.values()].map((list) => list.length), [0, 0, 0]);
});

test("Ctrl+C with nothing running only points at /exit and does not request a shutdown", () => {
  const h = harness();
  h.fire("SIGINT");
  assert.deepEqual(h.calls, ["status:stop", "stopTask"]);
  assert.deepEqual(h.logs.map(plain), ["\nUse /exit to leave Xiu."]);
  assert.equal(h.signals.shutdownRequested(), false);
  assert.equal(h.signals.idleSignal.aborted, false);
  assert.equal(h.signals.cancelActiveWork(), false);
});

test("Ctrl+C stops project checks before task preparation before the running task", () => {
  const h = harness();
  h.state.check = h.abortable("check");
  h.state.preparation = h.abortable("preparation");
  h.state.running = true;
  h.state.view = { setPhase: (value) => { h.calls.push(`view:phase:${value}`); } };
  h.fire("SIGINT");
  assert.deepEqual(h.calls, ["status:stop", "abort:check"]);
  assert.deepEqual(h.logs.map(plain), ["\nCancelling project checks..."]);

  h.calls.length = 0; h.logs.length = 0;
  h.state.check = undefined;
  h.fire("SIGINT");
  assert.deepEqual(h.calls, ["status:stop", "abort:preparation"]);
  assert.deepEqual(h.logs.map(plain), ["\nCancelling task preparation..."]);

  h.calls.length = 0; h.logs.length = 0;
  h.state.preparation = undefined;
  h.fire("SIGINT");
  assert.deepEqual(h.calls, ["status:stop", "stopTask", "view:phase:Cancelling"]);
  assert.deepEqual(h.logs.map(plain), ["\nCancelling current task..."]);
  assert.equal(h.signals.shutdownRequested(), false, "Ctrl+C never asks the session to leave");
});

test("SIGTERM while a task runs stops it and requests a shutdown; a second signal exits at once", () => {
  const h = harness();
  h.state.running = true;
  h.fire("SIGTERM");
  assert.equal(h.signals.shutdownRequested(), true);
  assert.deepEqual(h.errors.map(plain), ["Received SIGTERM; stopping the current work, then exiting."]);
  assert.equal(h.signals.idleSignal.aborted, false, "the running task ends the process itself; no idle prompt to wake");
  assert.deepEqual(h.exits, []);
  h.fire("SIGTERM");
  assert.deepEqual(h.exits, [143]);
  h.fire("SIGHUP");
  assert.deepEqual(h.exits, [143, 129]);
  assert.equal(h.errors.length, 1, "a repeated signal prints nothing more");
});

test("SIGHUP on an idle session leaves the way /exit does by waking the idle prompt", () => {
  const h = harness();
  h.fire("SIGHUP");
  assert.equal(h.signals.shutdownRequested(), true);
  assert.deepEqual(h.errors.map(plain), ["\nReceived SIGHUP; leaving Xiu."]);
  assert.equal(h.signals.idleSignal.aborted, true);
  assert.deepEqual(h.exits, []);
});

test("a closed output pipe stops running work and reports it, and exits at once when idle", () => {
  const idle = harness();
  assert.equal(idle.brokenPipe()?.(), false, "nothing to stop: the caller exits now");
  assert.equal(idle.signals.shutdownRequested(), true);
  assert.deepEqual(idle.errors, []);

  const busy = harness();
  busy.state.running = true;
  assert.equal(busy.brokenPipe()?.(), true);
  assert.deepEqual(busy.errors.map(plain), ["The output pipe was closed; stopping the current work, then exiting."]);
  assert.deepEqual(busy.calls, ["status:stop", "stopTask"]);

  const closing = harness();
  closing.state.running = true;
  closing.fire("SIGHUP");
  closing.calls.length = 0;
  assert.equal(closing.brokenPipe()?.(), true, "a shutdown already under way is left to finish");
  assert.deepEqual(closing.calls, [], "the work is not cancelled a second time");
});

test("Chinese wording is used when the session language is zh-CN", () => {
  const h = harness({ language: "zh-CN" });
  h.fire("SIGINT");
  assert.deepEqual(h.logs.map(plain), ["\n使用 /exit 退出 Xiu。"]);
  h.state.running = true;
  h.fire("SIGTERM");
  assert.deepEqual(h.errors.map(plain), ["收到 SIGTERM，正在停止当前工作后退出。"]);
  assert.deepEqual(h.logs.slice(1).map(plain), ["\n正在取消当前任务……"]);
});
