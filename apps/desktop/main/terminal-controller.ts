import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IDisposable, IPty } from "node-pty";
import type {
  DesktopTerminalEvent,
  DesktopTerminalResizeRequest,
  DesktopTerminalSnapshot,
  DesktopTerminalStartRequest,
  DesktopTerminalWriteRequest,
} from "../shared/protocol.js";

const DEFAULT_COLS = 96;
const DEFAULT_ROWS = 28;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_EVENT_CHARS = 16 * 1024;
const MAX_PENDING_CHARS = 256 * 1024;
const MAX_REPLAY_CHARS = 128 * 1024;
const PAUSE_AT_CHARS = 64 * 1024;
const DROPPED_OUTPUT_NOTICE = "\r\n\x1b[33m[Xiu：终端输出过快，已丢弃部分旧输出]\x1b[0m\r\n";

export interface TerminalPty extends Pick<IPty, "write" | "resize" | "kill" | "pause" | "resume" | "onData" | "onExit"> {}
export type TerminalPtyFactory = (file: string, args: string[], options: {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
  useConpty?: boolean;
}) => TerminalPty;

interface ActiveTerminal {
  id: string;
  workspace: string;
  shell: string;
  pty: TerminalPty;
  cols: number;
  rows: number;
  sequence: number;
  replay: string;
  pending: string;
  flushScheduled: boolean;
  paused: boolean;
  disposables: IDisposable[];
}

function dimensions(request?: DesktopTerminalStartRequest): { cols: number; rows: number } {
  const cols = request?.cols ?? DEFAULT_COLS;
  const rows = request?.rows ?? DEFAULT_ROWS;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error("终端尺寸无效。");
  return {
    cols: Math.max(20, Math.min(500, Math.trunc(cols))),
    rows: Math.max(5, Math.min(200, Math.trunc(rows))),
  };
}

export function controlledShell(platform = process.platform, env = process.env): { file: string; args: string[]; label: string } {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    return { file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo"], label: "PowerShell" };
  }
  const requested = env.SHELL;
  const allowed = new Set(["/bin/bash", "/bin/zsh", "/bin/fish", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/sh"]);
  if (requested && allowed.has(requested)) {
    return { file: requested, args: [], label: path.basename(requested) };
  }
  return platform === "darwin"
    ? { file: "/bin/zsh", args: [], label: "zsh" }
    : { file: "/bin/sh", args: [], label: "sh" };
}

function terminalEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export class DesktopTerminalController {
  private active?: ActiveTerminal;
  private last: DesktopTerminalSnapshot = { state: "idle" };

  constructor(
    private readonly emit: (event: DesktopTerminalEvent) => void,
    private readonly factory: TerminalPtyFactory,
    private readonly shell = controlledShell,
  ) {}

  snapshot(workspace?: string): DesktopTerminalSnapshot {
    if (this.active && workspace && this.active.workspace !== workspace) return { state: "idle" };
    if (!this.active) return { ...this.last };
    return this.activeSnapshot(true);
  }

  isRunning(workspace: string): boolean {
    return this.active?.workspace === workspace;
  }

  async start(workspace: string, request?: DesktopTerminalStartRequest): Promise<DesktopTerminalSnapshot> {
    const canonical = await fs.realpath(workspace);
    if (this.active) {
      if (this.active.workspace === canonical) return this.activeSnapshot(true);
      this.stopActive("工作区已切换，终端会话已关闭。");
    }
    const size = dimensions(request);
    const selected = this.shell();
    const id = randomUUID();
    let pty: TerminalPty;
    try {
      pty = this.factory(selected.file, selected.args, {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd: canonical,
        env: terminalEnvironment(),
        ...(process.platform === "win32" ? { useConpty: true } : {}),
      });
    } catch (error) {
      this.last = { state: "error", sessionId: id, shell: selected.label, message: error instanceof Error ? error.message : String(error) };
      return { ...this.last };
    }
    const session: ActiveTerminal = {
      id, workspace: canonical, shell: selected.label, pty, ...size,
      sequence: 0, replay: "", pending: "", flushScheduled: false, paused: false, disposables: [],
    };
    this.active = session;
    this.last = { state: "running", sessionId: id, shell: selected.label, ...size };
    session.disposables.push(pty.onData((data) => this.enqueue(session, data)));
    session.disposables.push(pty.onExit(({ exitCode, signal }) => this.onExit(session, exitCode, signal)));
    this.emit({ sessionId: id, sequence: ++session.sequence, kind: "state", snapshot: this.activeSnapshot(false) });
    return this.activeSnapshot(true);
  }

  write(workspace: string, request: DesktopTerminalWriteRequest): void {
    const session = this.requireSession(workspace, request?.sessionId);
    if (typeof request.data !== "string" || Buffer.byteLength(request.data, "utf8") > MAX_INPUT_BYTES) throw new Error("终端输入超过 64 KiB 限制。");
    session.pty.write(request.data);
  }

  resize(workspace: string, request: DesktopTerminalResizeRequest): DesktopTerminalSnapshot {
    const session = this.requireSession(workspace, request?.sessionId);
    const size = dimensions(request);
    if (size.cols !== session.cols || size.rows !== session.rows) {
      session.pty.resize(size.cols, size.rows);
      session.cols = size.cols;
      session.rows = size.rows;
    }
    return this.activeSnapshot(false);
  }

  stop(workspace: string, sessionId: string): DesktopTerminalSnapshot {
    this.requireSession(workspace, sessionId);
    this.stopActive("终端会话已关闭。");
    return { ...this.last };
  }

  stopAll(message = "终端会话已关闭。"): void {
    if (this.active) this.stopActive(message);
  }

  private requireSession(workspace: string, sessionId: string): ActiveTerminal {
    if (!sessionId || typeof sessionId !== "string" || sessionId.length > 100) throw new Error("终端会话标识无效。");
    if (!this.active || this.active.id !== sessionId || this.active.workspace !== workspace) throw new Error("终端会话不存在、已经结束或属于其他工作区。");
    return this.active;
  }

  private activeSnapshot(includeOutput: boolean): DesktopTerminalSnapshot {
    const session = this.active;
    if (!session) return { ...this.last };
    return {
      state: "running", sessionId: session.id, shell: session.shell,
      cols: session.cols, rows: session.rows,
      ...(includeOutput && session.replay ? { output: session.replay } : {}),
    };
  }

  private enqueue(session: ActiveTerminal, data: string): void {
    if (this.active !== session || !data) return;
    session.replay = `${session.replay}${data}`.slice(-MAX_REPLAY_CHARS);
    session.pending += data;
    if (session.pending.length > MAX_PENDING_CHARS) session.pending = `${DROPPED_OUTPUT_NOTICE}${session.pending.slice(-MAX_PENDING_CHARS + DROPPED_OUTPUT_NOTICE.length)}`;
    if (!session.paused && session.pending.length >= PAUSE_AT_CHARS) {
      session.pty.pause();
      session.paused = true;
    }
    if (!session.flushScheduled) {
      session.flushScheduled = true;
      setImmediate(() => this.flush(session));
    }
  }

  private flush(session: ActiveTerminal): void {
    if (this.active !== session) return;
    session.flushScheduled = false;
    let emitted = 0;
    while (session.pending && emitted < 8) {
      const data = session.pending.slice(0, MAX_EVENT_CHARS);
      session.pending = session.pending.slice(data.length);
      this.emit({ sessionId: session.id, sequence: ++session.sequence, kind: "output", data });
      emitted += 1;
    }
    if (session.paused && session.pending.length < PAUSE_AT_CHARS / 2) {
      session.pty.resume();
      session.paused = false;
    }
    if (session.pending) {
      session.flushScheduled = true;
      setImmediate(() => this.flush(session));
    }
  }

  private onExit(session: ActiveTerminal, exitCode: number, signal?: number): void {
    if (this.active !== session) return;
    session.flushScheduled = false;
    while (session.pending) {
      const data = session.pending.slice(0, MAX_EVENT_CHARS);
      session.pending = session.pending.slice(data.length);
      this.emit({ sessionId: session.id, sequence: ++session.sequence, kind: "output", data });
    }
    for (const disposable of session.disposables) disposable.dispose();
    this.active = undefined;
    this.last = { state: "exited", sessionId: session.id, shell: session.shell, cols: session.cols, rows: session.rows, exitCode, ...(signal === undefined ? {} : { signal }), output: session.replay };
    this.emit({ sessionId: session.id, sequence: ++session.sequence, kind: "exit", exitCode, ...(signal === undefined ? {} : { signal }) });
  }

  private stopActive(message: string): void {
    const session = this.active;
    if (!session) return;
    this.active = undefined;
    for (const disposable of session.disposables) disposable.dispose();
    try { session.pty.kill(); } catch { /* The child may already have exited. */ }
    this.last = { state: "idle", message };
    this.emit({ sessionId: session.id, sequence: ++session.sequence, kind: "state", snapshot: { ...this.last } });
  }
}
