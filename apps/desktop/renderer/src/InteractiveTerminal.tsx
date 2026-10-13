import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { DesktopTerminalSnapshot } from "../../shared/protocol.js";
import { desktopTerminalVisuals } from "./terminal-visuals.js";

export function InteractiveTerminal({ visible, disabled }: { visible: boolean; disabled: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const snapshotRef = useRef<DesktopTerminalSnapshot>({ state: "idle" });
  const lastSequenceRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [snapshot, setSnapshot] = useState<DesktopTerminalSnapshot>({ state: "idle" });
  const [error, setError] = useState<string>();

  const applySnapshot = (next: DesktopTerminalSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      ...desktopTerminalVisuals,
      cursorBlink: true,
      convertEol: false,
      scrollback: 2_000,
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      const current = snapshotRef.current;
      if (current.state !== "running" || !current.sessionId) return;
      const sessionId = current.sessionId;
      writeQueueRef.current = writeQueueRef.current
        .then(() => window.xiuDesktop.writeTerminal({ sessionId, data }))
        .catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)); });
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      const current = snapshotRef.current;
      if (current.state !== "running" || !current.sessionId) return;
      void window.xiuDesktop.resizeTerminal({ sessionId: current.sessionId, cols, rows }).then(applySnapshot).catch(() => undefined);
    });
    const unsubscribe = window.xiuDesktop.onTerminalEvent((event) => {
      if (event.sessionId !== snapshotRef.current.sessionId && event.kind === "state" && event.snapshot.state === "running") lastSequenceRef.current = 0;
      if (event.sequence <= lastSequenceRef.current) return;
      lastSequenceRef.current = event.sequence;
      if (event.kind === "output") {
        if (snapshotRef.current.sessionId === event.sessionId) terminal.write(event.data);
        return;
      }
      if (event.kind === "state") {
        applySnapshot(event.snapshot);
        if (event.snapshot.state === "idle" && event.snapshot.message) terminal.writeln(`\r\n\x1b[90m${event.snapshot.message}\x1b[0m`);
        return;
      }
      applySnapshot({ ...snapshotRef.current, state: "exited", exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) });
      terminal.writeln(`\r\n\x1b[90m[进程已退出，代码 ${event.exitCode}]\x1b[0m`);
    });
    void window.xiuDesktop.terminalSnapshot().then((current) => {
      applySnapshot(current);
      if (current.output) terminal.write(current.output);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { unsubscribe(); input.dispose(); resize.dispose(); terminal.dispose(); terminalRef.current = undefined; fitRef.current = undefined; };
  }, []);

  useEffect(() => {
    if (!visible || !hostRef.current) return;
    const fit = () => {
      try {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        if (terminal) terminal.refresh(0, terminal.rows - 1);
        if (snapshotRef.current.state === "running") terminalRef.current?.focus();
      } catch { /* Hidden or closing terminal. */ }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(hostRef.current);
    requestAnimationFrame(fit);
    return () => observer.disconnect();
  }, [visible]);

  const start = async () => {
    setError(undefined);
    terminalRef.current?.reset();
    try {
      const terminal = terminalRef.current;
      fitRef.current?.fit();
      const next = await window.xiuDesktop.startTerminal({ cols: terminal?.cols, rows: terminal?.rows });
      applySnapshot(next);
      if (next.output) terminal?.write(next.output);
      if (next.state === "running") requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          terminal?.refresh(0, terminal.rows - 1);
          terminal?.focus();
        } catch { /* Terminal may be closing. */ }
      });
      if (next.state === "error") setError(next.message ?? "终端启动失败。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const stop = async () => {
    if (!snapshot.sessionId) return;
    setError(undefined);
    try { applySnapshot(await window.xiuDesktop.stopTerminal({ sessionId: snapshot.sessionId })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <section className={`review-pane terminal-pane ${visible ? "visible" : "hidden"}`} aria-hidden={!visible}>
    <div className="terminal-toolbar"><div><strong>交互终端</strong><small>{snapshot.state === "running" ? `${snapshot.shell ?? "Shell"} · ${snapshot.cols ?? "?"}×${snapshot.rows ?? "?"} · 运行中` : snapshot.state === "exited" ? `已退出${snapshot.exitCode === undefined ? "" : ` · ${snapshot.exitCode}`}` : snapshot.state === "error" ? "启动失败" : "未启动"}</small></div><div><button onClick={() => terminalRef.current?.clear()}>清屏</button>{snapshot.state === "running" ? <button className="terminal-stop" onClick={() => void stop()}>关闭</button> : <button className="terminal-start" disabled={disabled} onClick={() => void start()}>启动终端</button>}</div></div>
    <p className="terminal-notice">点击下方终端后直接输入，按 Enter 执行。固定绑定当前可信工作区；输入不经过 Agent 审批，输出不会写入任务审计，也不会作为 Agent 完成证据。</p>
    {disabled && snapshot.state !== "running" && <p className="terminal-disabled">Agent 任务运行期间不能启动终端。</p>}
    {error && <p className="terminal-error">{error}</p>}
    <div className="terminal-surface" ref={hostRef} onMouseDown={() => terminalRef.current?.focus()} />
  </section>;
}
