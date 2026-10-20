import chalk from "chalk";
import { setBrokenPipeHandler } from "./broken-pipe.js";
import { localize, type UiLanguage } from "./i18n.js";

/** Something Ctrl+C can stop: an `AbortController`, or anything with the same `abort()`. */
export interface Abortable {
  abort: () => void;
}

export interface TerminalSignalsContext {
  language: () => UiLanguage;
  status: { stop: () => void };
  /** The running `/check` controller, when package scripts are running. */
  activeCheck: () => Abortable | undefined;
  /** The controller of a task still being prepared (context gathering, baseline), when there is one. */
  activeTaskPreparation: () => Abortable | undefined;
  /** Stops the running task; false when none runs. */
  stopTask: () => boolean;
  runningTaskView: () => { setPhase: (value: string) => void } | undefined;
  /** The process, the console and the broken-pipe hook; the real ones unless a test injects its own. */
  io?: TerminalSignalsIo;
}

export interface TerminalSignalsIo {
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
  process: {
    on: (signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void) => unknown;
    off: (signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void) => unknown;
  };
  setBrokenPipeHandler: (handler: (() => boolean) | undefined) => void;
}

export interface TerminalSignals {
  /** True once Xiu must leave as soon as the current work has stopped: the output pipe closed, or SIGTERM/SIGHUP arrived. */
  shutdownRequested: () => boolean;
  /** Aborted when an idle prompt must stop waiting for a line because a termination signal arrived. */
  idleSignal: AbortSignal;
  /** Stops whatever is running the way Ctrl+C does; false when nothing was running. */
  cancelActiveWork: () => boolean;
  /** Removes the signal handlers again, the way the interactive loop does when it leaves. */
  dispose: () => void;
}

const realIo: TerminalSignalsIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exit: (code) => process.exit(code),
  process,
  setBrokenPipeHandler,
};

/**
 * Installs what Ctrl+C, SIGTERM, SIGHUP and a closed output pipe do while Xiu runs: stop the running work (project
 * checks first, then task preparation, then the task itself) so its record is closed, and mark the session as leaving
 * when the signal means the process must end. The interactive loop reads `shutdownRequested` to stop dequeuing follow-ups
 * and to leave instead of asking for the next line, and passes `idleSignal` to the idle prompt.
 */
export function installTerminalSignals(ctx: TerminalSignalsContext): TerminalSignals {
  const io = ctx.io ?? realIo;
  const language = (): UiLanguage => ctx.language();

  /** Stops whatever is running the way Ctrl+C does; false when nothing was running. */
  const cancelActiveWork = (): boolean => {
    ctx.status.stop();
    const activeCheckController = ctx.activeCheck();
    const activeTaskPreparationController = ctx.activeTaskPreparation();
    if (activeCheckController) {
      activeCheckController.abort();
      io.log(chalk.yellow(localize(language(), "\n正在取消项目检查……", "\nCancelling project checks...")));
    } else if (activeTaskPreparationController) {
      activeTaskPreparationController.abort();
      io.log(chalk.yellow(localize(language(), "\n正在取消任务准备……", "\nCancelling task preparation...")));
    } else if (ctx.stopTask()) {
      ctx.runningTaskView()?.setPhase(localize(language(), "正在取消", "Cancelling"));
      io.log(chalk.yellow(localize(language(), "\n正在取消当前任务……", "\nCancelling current task...")));
    } else return false;
    return true;
  };
  const onSigint = () => {
    if (!cancelActiveWork()) io.log(chalk.dim(localize(language(), "\n使用 /exit 退出 Xiu。", "\nUse /exit to leave Xiu.")));
  };
  io.process.on("SIGINT", onSigint);
  // Set when Xiu must leave as soon as the current work has stopped: the output pipe closed, or SIGTERM/SIGHUP arrived.
  // runTaskSequence then stops dequeuing and skips its menus, and the prompt loop leaves instead of asking for the next line.
  let shutdownRequested = false;
  const idlePrompt = new AbortController();
  io.setBrokenPipeHandler(() => {
    // The reader of stdout or stderr is gone (`xiu --json <task> | head -1`): stop the current work as Ctrl+C would, so the
    // run records its end instead of dying mid-write, and leave once it has stopped. Idle, there is nothing to end: exit now.
    // When a shutdown is already under way (SIGHUP from a closed terminal arrives together with EIO on its pty), the work
    // is already stopping and will end the process itself; exiting here would leave its record open.
    if (shutdownRequested) return true;
    shutdownRequested = true;
    const stopping = cancelActiveWork();
    if (stopping) io.error(chalk.yellow(localize(language(), "输出管道已关闭，正在停止当前工作后退出。", "The output pipe was closed; stopping the current work, then exiting.")));
    return stopping;
  });
  // SIGTERM (`timeout`, `kill`, a stopped container, a cancelled CI job) and SIGHUP (the terminal went away) end a Node
  // process at once by default: no `result` line, and a running task left as `running` in its journal, which the next
  // start reports as interrupted until someone runs `xiu recover abandon`. They are handled like Ctrl+C instead: the
  // running work is cancelled and records its end, a one-shot run prints its result and exits with the cancelled code, an
  // idle session leaves the way /exit does. A second signal while that is in progress ends the process at once.
  const onTerminationSignal = (signal: NodeJS.Signals): void => {
    if (shutdownRequested) {
      io.exit(signal === "SIGHUP" ? 129 : 143);
      return;
    }
    shutdownRequested = true;
    const stopping = cancelActiveWork();
    io.error(chalk.yellow(stopping
      ? localize(language(), `收到 ${signal}，正在停止当前工作后退出。`, `Received ${signal}; stopping the current work, then exiting.`)
      : localize(language(), `\n收到 ${signal}，退出 Xiu。`, `\nReceived ${signal}; leaving Xiu.`)));
    if (!stopping) idlePrompt.abort();
  };
  io.process.on("SIGTERM", onTerminationSignal);
  io.process.on("SIGHUP", onTerminationSignal);

  return {
    shutdownRequested: () => shutdownRequested,
    idleSignal: idlePrompt.signal,
    cancelActiveWork,
    dispose: () => {
      io.process.off("SIGINT", onSigint);
      io.process.off("SIGTERM", onTerminationSignal);
      io.process.off("SIGHUP", onTerminationSignal);
    },
  };
}
