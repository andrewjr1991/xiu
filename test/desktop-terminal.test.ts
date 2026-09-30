import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTerminalController, controlledShell, type TerminalPty, type TerminalPtyFactory } from "../apps/desktop/main/terminal-controller.js";
import { desktopTerminalVisuals } from "../apps/desktop/renderer/src/terminal-visuals.js";
import type { DesktopTerminalEvent } from "../apps/desktop/shared/protocol.js";

class FakePty implements TerminalPty {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills = 0;
  pauses = 0;
  resumes = 0;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };
  onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };
  write(data: string | Buffer) { this.writes.push(String(data)); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill() { this.kills += 1; }
  pause() { this.pauses += 1; }
  resume() { this.resumes += 1; }
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
  emitExit(exitCode: number, signal?: number) { for (const listener of this.exitListeners) listener({ exitCode, ...(signal === undefined ? {} : { signal }) }); }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu terminal 空格 "));
  return { root, canonical: await fs.realpath(root) };
}

test("desktop terminal binds a controlled PTY to the canonical trusted workspace", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const pty = new FakePty();
  let spawned: Parameters<TerminalPtyFactory> | undefined;
  const events: DesktopTerminalEvent[] = [];
  const controller = new DesktopTerminalController(events.push.bind(events), (...args) => { spawned = args; return pty; }, () => ({ file: "safe-shell", args: ["--login"], label: "Safe Shell" }));
  const snapshot = await controller.start(item.root, { cols: 4, rows: 999 });

  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.shell, "Safe Shell");
  assert.equal(snapshot.cols, 20);
  assert.equal(snapshot.rows, 200);
  assert.equal(spawned?.[0], "safe-shell");
  assert.deepEqual(spawned?.[1], ["--login"]);
  assert.equal(spawned?.[2].cwd, item.canonical);
  assert.equal(spawned?.[2].env.NODE_OPTIONS, undefined);
  assert.equal(spawned?.[2].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(events[0]?.kind, "state");
});

test("desktop terminal validates session input and clamps resize requests", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const pty = new FakePty();
  const controller = new DesktopTerminalController(() => undefined, () => pty, () => ({ file: "shell", args: [], label: "shell" }));
  const started = await controller.start(item.root);
  const sessionId = started.sessionId!;

  controller.write(item.canonical, { sessionId, data: "echo 你好\r" });
  assert.deepEqual(pty.writes, ["echo 你好\r"]);
  assert.throws(() => controller.write(item.canonical, { sessionId: "stale", data: "x" }), /不存在|结束|其他工作区/);
  assert.throws(() => controller.write(item.canonical, { sessionId, data: "x".repeat(65 * 1024) }), /64 KiB/);
  const resized = controller.resize(item.canonical, { sessionId, cols: 1_000, rows: 1 });
  assert.deepEqual(pty.resizes, [[500, 5]]);
  assert.equal(resized.output, undefined);
});

test("desktop terminal bounds output events, applies backpressure, and keeps bounded in-memory replay", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const pty = new FakePty();
  const events: DesktopTerminalEvent[] = [];
  const controller = new DesktopTerminalController(events.push.bind(events), () => pty, () => ({ file: "shell", args: [], label: "shell" }));
  await controller.start(item.root);
  pty.emitData("界".repeat(300_000));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const output = events.filter((event): event is Extract<DesktopTerminalEvent, { kind: "output" }> => event.kind === "output");
  assert.ok(output.length > 1);
  assert.ok(output.every((event) => event.data.length <= 16 * 1024));
  assert.ok(pty.pauses >= 1);
  assert.ok(pty.resumes >= 1);
  assert.ok((controller.snapshot(item.canonical).output?.length ?? 0) <= 128 * 1024);
});

test("desktop terminal reports child exit and closes cleanly on workspace lifecycle changes", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const first = new FakePty();
  const second = new FakePty();
  let next = first;
  const events: DesktopTerminalEvent[] = [];
  const controller = new DesktopTerminalController(events.push.bind(events), () => next, () => ({ file: "shell", args: [], label: "shell" }));
  const started = await controller.start(item.root);
  first.emitData("before exit\r\n");
  first.emitExit(7, 9);
  assert.equal(controller.snapshot(item.canonical).state, "exited");
  assert.equal(controller.snapshot(item.canonical).exitCode, 7);
  assert.equal(events.at(-1)?.kind, "exit");

  next = second;
  const restarted = await controller.start(item.root);
  assert.notEqual(restarted.sessionId, started.sessionId);
  controller.stopAll("workspace switched");
  assert.equal(second.kills, 1);
  assert.deepEqual(controller.snapshot(item.canonical), { state: "idle", message: "workspace switched" });
});

test("controlled shell ignores arbitrary SHELL values", () => {
  assert.deepEqual(controlledShell("linux", { SHELL: "/tmp/not-approved" }), { file: "/bin/sh", args: [], label: "sh" });
  assert.deepEqual(controlledShell("linux", { SHELL: "/tmp/bash" }), { file: "/bin/sh", args: [], label: "sh" });
  assert.deepEqual(controlledShell("darwin", { SHELL: "/bin/zsh" }), { file: "/bin/zsh", args: [], label: "zsh" });
  assert.deepEqual(controlledShell("win32", { COMSPEC: "C:\\evil.exe", SystemRoot: "C:\\Windows" }), { file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoLogo"], label: "PowerShell" });
});

test("desktop terminal keeps default and ANSI input colors readable on its dark surface", () => {
  const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  const luminance = (hex: string) => {
    const linear = [1, 3, 5].map((offset) => {
      const value = channel(hex, offset);
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const contrast = (first: string, second: string) => {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light! + 0.05) / (dark! + 0.05);
  };

  assert.ok(desktopTerminalVisuals.minimumContrastRatio >= 7);
  assert.ok(contrast(desktopTerminalVisuals.theme.foreground, desktopTerminalVisuals.theme.background) >= 7);
  assert.ok(contrast(desktopTerminalVisuals.theme.black, desktopTerminalVisuals.theme.background) >= 4.5);
  assert.ok(contrast(desktopTerminalVisuals.theme.blue, desktopTerminalVisuals.theme.background) >= 4.5);
});
