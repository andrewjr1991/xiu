import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTerminalController, controlledShell, environmentNotice, isSecretEnvironmentVariable, terminalEnvironment, type TerminalPty, type TerminalPtyFactory } from "../apps/desktop/main/terminal-controller.js";
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

test("terminal environment hides credential-looking variables by default and keeps the shell usable", () => {
  const base = {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "zh_CN.UTF-8", SystemRoot: "C:\\Windows", TOKENIZERS_PARALLELISM: "false",
    HTTPS_PROXY: "http://user:proxy-pass@proxy.corp.example:8080", NO_PROXY: "localhost",
    OPENAI_API_KEY: "sk-canary-openai", DASHSCOPE_API_KEY: "canary-dashscope", GITHUB_TOKEN: "ghp_canary", AWS_SECRET_ACCESS_KEY: "canary-aws",
    DB_PASSWORD: "canary-db", NPM_CONFIG__AUTHTOKEN: "canary-npm", ARTIFACTORY_AUTH: "canary-auth", AUTHORIZATION: "Bearer canary",
    MY_GATEWAY_KEY: "canary-gateway", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1",
  };
  const filtered = terminalEnvironment({ hideSecrets: true, secretNames: ["MY_GATEWAY_KEY"] }, base);
  assert.deepEqual(filtered.hidden, ["ARTIFACTORY_AUTH", "AUTHORIZATION", "AWS_SECRET_ACCESS_KEY", "DASHSCOPE_API_KEY", "DB_PASSWORD", "GITHUB_TOKEN", "MY_GATEWAY_KEY", "NPM_CONFIG__AUTHTOKEN", "OPENAI_API_KEY"]);
  for (const name of filtered.hidden) assert.equal(filtered.env[name], undefined, name);
  assert.equal(filtered.env.PATH, "/usr/bin");
  assert.equal(filtered.env.HTTPS_PROXY, base.HTTPS_PROXY, "proxy variables stay even when they embed credentials; the proxy does not work without them");
  assert.equal(filtered.env.TOKENIZERS_PARALLELISM, "false");
  assert.equal(filtered.env.TERM, "xterm-256color");
  assert.equal(filtered.env.NODE_OPTIONS, undefined);
  assert.doesNotMatch(JSON.stringify(filtered.env), /canary/);
  const notice = environmentNotice(filtered)!;
  assert.match(notice, /隐藏 9 个 Key\/Token 类环境变量：ARTIFACTORY_AUTH、AUTHORIZATION、AWS_SECRET_ACCESS_KEY、DASHSCOPE_API_KEY、DB_PASSWORD、GITHUB_TOKEN 等 9 个/);
  assert.match(notice, /终端隐藏凭据变量/);
  assert.doesNotMatch(notice, /canary/);

  const inherited = terminalEnvironment({ hideSecrets: false, secretNames: ["MY_GATEWAY_KEY"] }, base);
  assert.deepEqual(inherited.hidden, []);
  assert.equal(inherited.env.OPENAI_API_KEY, "sk-canary-openai");
  assert.equal(inherited.env.NODE_OPTIONS, undefined, "Electron-only variables are always removed");
  assert.match(environmentNotice(inherited)!, /按你的设置，本终端继承了 9 个 Key\/Token 类环境变量/);
  assert.doesNotMatch(environmentNotice(inherited)!, /canary/);
  assert.equal(environmentNotice(terminalEnvironment({ hideSecrets: true }, { PATH: "/usr/bin" })), undefined, "nothing to say when nothing looked like a secret");

  assert.equal(isSecretEnvironmentVariable("SSH_AUTH_SOCK"), false);
  assert.equal(isSecretEnvironmentVariable("JAVA_HOME"), false);
  assert.equal(isSecretEnvironmentVariable("HF_TOKEN"), true);
  assert.equal(isSecretEnvironmentVariable("XIU_BETA_SEARXNG_TOKEN"), true);
});

test("desktop terminal applies the environment policy at start and fails closed when the policy is unreadable", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.root, { recursive: true, force: true }));
  const canary = "XIU_TEST_TERMINAL_API_KEY";
  process.env[canary] = "canary-terminal-key";
  t.after(() => { delete process.env[canary]; });
  const run = async (policy: () => Promise<{ hideSecrets: boolean }>) => {
    const pty = new FakePty();
    let spawned: Parameters<TerminalPtyFactory> | undefined;
    const events: DesktopTerminalEvent[] = [];
    const controller = new DesktopTerminalController(events.push.bind(events), (...args) => { spawned = args; return pty; }, () => ({ file: "shell", args: [], label: "shell" }), policy);
    const snapshot = await controller.start(item.root);
    await new Promise((resolve) => setImmediate(resolve));
    const output = events.filter((event) => event.kind === "output").map((event) => (event as { data: string }).data).join("");
    controller.stopAll();
    return { env: spawned![2].env, output, replay: controller.snapshot(item.canonical), snapshot };
  };
  const hidden = await run(async () => ({ hideSecrets: true }));
  assert.equal(hidden.env[canary], undefined);
  assert.match(hidden.output, /已对本终端隐藏 \d+ 个 Key\/Token 类环境变量：/);
  assert.doesNotMatch(hidden.output, /canary-terminal-key/);
  assert.match(hidden.snapshot.output ?? "", /已对本终端隐藏/, "the notice is part of the replay a reopened pane receives");

  const inherited = await run(async () => ({ hideSecrets: false }));
  assert.equal(inherited.env[canary], "canary-terminal-key");
  assert.match(inherited.output, /按你的设置，本终端继承了/);
  assert.doesNotMatch(inherited.output, /canary-terminal-key/);

  const unreadable = await run(async () => { throw new Error("preferences unavailable"); });
  assert.equal(unreadable.env[canary], undefined, "an unreadable policy hides secrets rather than inheriting them");
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
