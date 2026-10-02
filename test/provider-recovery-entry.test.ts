import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { ProviderRegistry } from "../src/provider-registry.js";
import { providerWindowsPrivacyFailureStage, verifyProviderWindowsPrivacy } from "../src/provider-config-migration.js";
import { runProviderRecoveryCommand, type ProviderRecoveryCommandIO } from "../src/commands/provider-recovery.js";
import { DesktopProviderRecoveryController } from "../apps/desktop/main/provider-recovery-controller.js";

const canary = "fixture_jE73r!M-only-not-a-real-key";
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-recovery-entry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".xiu");
  await fs.mkdir(directory, { mode: 0o700 });
  const filename = path.join(directory, "providers.json");
  const original = JSON.stringify({ version: 4, profiles: [], credentials: { agnes: canary }, active: "agnes" });
  await fs.writeFile(filename, original, { mode: 0o600 });
  const initial = new ProviderRegistry(filename);
  await initial.load();
  const backup = (await initial.configurationDiagnostics()).backups[0]!;
  assert.ok(backup);
  const malformed = `{"version":5,"private":"${canary}",BROKEN`;
  await fs.writeFile(filename, malformed, { mode: 0o600 });
  const registry = new ProviderRegistry(filename);
  return { root, directory, filename, original, malformed, registry, backupId: backup.id };
}
function io(answer = "", interactive = true) {
  const output: string[] = [];
  let asked = 0;
  const value: ProviderRecoveryCommandIO = { language: "en-US", interactive, write: (text) => output.push(text), ask: async () => { asked++; return answer; } };
  return { value, output, get asked() { return asked; } };
}
function safe(value: unknown, root: string) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.ok(!text.includes(canary), "no credential material");
  assert.ok(!text.includes(root), "no local paths");
  assert.ok(!text.includes('"profiles"'), "no profile payload");
}

async function privateLockFixture(filename: string, pid: number, nonce: string): Promise<void> {
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    // Match the production writer: a new file can inherit the private DACL
    // while an elevated Windows token still selects Administrators as owner.
    // Initialize this empty fixture before writing its synthetic lock payload.
    if (process.platform === "win32") await verifyProviderWindowsPrivacy(filename, false, true);
    await handle.writeFile(JSON.stringify({ pid, nonce }));
    await handle.sync();
  } finally { await handle.close(); }
  if (process.platform === "win32") await verifyProviderWindowsPrivacy(filename, false, false);
}

function recoveryAssertionSummary(output: { output: string[]; asked: number }): string {
  // Never print captured CLI text, even on assertion failure. Derive only
  // fixed labels from a bounded suffix and pass stages through the allowlist.
  const text = output.output.slice(-4).map((value) => value.slice(0, 1024)).join("\n");
  const stage = /Windows ACL failure: [a-z-]+; stage: ([a-z-]{1,40});/.exec(text)?.[1];
  const aclStage = providerWindowsPrivacyFailureStage({ stdout: `XIU_ACL_V1:${stage ?? ""}` });
  const reason = text.includes("protected regular file/directory") ? "storage-privacy"
    : text.includes("active or interrupted write lock") ? "write-lock"
      : text.includes("changed in another client") ? "revision-changed"
        : text.includes("storage operation failed") ? "storage-io" : "other";
  return `Provider current recovery: confirmation=${output.asked > 0 ? "requested" : "not-requested"}; reason=${reason}; acl-stage=${aclStage}`;
}

test("recovery assertion diagnostics expose only bounded fixed labels", () => {
  const root = "fixture-private-directory";
  const summary = recoveryAssertionSummary({ output: ["x".repeat(10_000), `${root} ${canary} Windows ACL failure: nonzero-exit; stage: verify-owner; category: unknown.`], asked: 0 });
  assert.equal(summary, "Provider current recovery: confirmation=not-requested; reason=other; acl-stage=verify-owner");
  safe(summary, root);
  const unknown = recoveryAssertionSummary({ output: [`Windows ACL failure: nonzero-exit; stage: ${canary}; category: unknown.`], asked: 1 });
  assert.equal(unknown, "Provider current recovery: confirmation=requested; reason=other; acl-stage=process");
  safe(unknown, root);
});

test("CLI recovery diagnostics and preview work without loading malformed settings and never restore", async (t) => {
  const f = await fixture(t);
  const output = io();
  assert.deepEqual(await runProviderRecoveryCommand(f.registry, { action: "list" }, output.value), { exitCode: 0, restartRequired: false });
  assert.match(output.output.join("\n"), /invalid/);
  assert.match(output.output.join("\n"), new RegExp(f.backupId));
  assert.deepEqual(await runProviderRecoveryCommand(f.registry, { action: "preview", backupId: f.backupId }, output.value), { exitCode: 0, restartRequired: false });
  assert.equal(output.asked, 0);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
  safe(output.output, f.root);
});

for (const answer of ["", "yes", "y", "recover", "CANCEL"]) test(`CLI typed confirmation fails closed for ${JSON.stringify(answer)}`, async (t) => {
  const f = await fixture(t);
  const output = io(answer);
  const result = await runProviderRecoveryCommand(f.registry, { action: "recover", backupId: f.backupId }, output.value);
  assert.equal(result.restartRequired, false);
  assert.match(output.output.join("\n"), /Cancelled/);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
});

test("CLI cannot restore via noninteractive input, and explicit RECOVER restores then stops for restart", async (t) => {
  const f = await fixture(t);
  const noninteractive = io("RECOVER", false);
  assert.equal((await runProviderRecoveryCommand(f.registry, { action: "recover", backupId: f.backupId }, noninteractive.value)).exitCode, 1);
  assert.equal(noninteractive.asked, 0);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
  const interactive = io("RECOVER");
  assert.deepEqual(await runProviderRecoveryCommand(f.registry, { action: "recover", backupId: f.backupId }, interactive.value), { exitCode: 0, restartRequired: true });
  assert.equal(await fs.readFile(f.filename, "utf8"), f.original);
  assert.match(interactive.output.join("\n"), /Restart Xiu/);
  safe(interactive.output, f.root);
  await assert.rejects(f.registry.load(), /Restart/);
});

test("CLI stale settings and unsupported future schema cannot be restored", async (t) => {
  const f = await fixture(t);
  const output = io("RECOVER");
  output.value.ask = async () => { await fs.writeFile(f.filename, '{"version":5,"profiles":[]}'); return "RECOVER"; };
  assert.equal((await runProviderRecoveryCommand(f.registry, { action: "recover", backupId: f.backupId }, output.value)).exitCode, 1);
  assert.equal(await fs.readFile(f.filename, "utf8"), '{"version":5,"profiles":[]}');
  await fs.writeFile(f.filename, '{"version":999,"profiles":[]}');
  const future = io("RECOVER");
  assert.equal((await runProviderRecoveryCommand(f.registry, { action: "recover", backupId: f.backupId }, future.value)).exitCode, 1);
  assert.equal(future.asked, 0);
});

async function cli(home: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, HOME: home, USERPROFILE: home, XIU_LANGUAGE: "en-US", FORCE_COLOR: "0" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => { output += String(value); }); child.stderr.on("data", (value) => { output += String(value); });
  child.stdin.end("RECOVER\n");
  const timer = setTimeout(() => child.kill(), 20_000);
  try { return await new Promise<{ code: number | null; output: string }>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve({ code, output })); }); }
  finally { clearTimeout(timer); }
}

test("real CLI early flags bypass broken startup and --yes cannot approve piped recovery", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, "settings.json"), `broken ${canary}`);
  const diagnostics = await cli(f.root, ["--provider-config-diagnostics"]);
  assert.equal(diagnostics.code, 0, diagnostics.output);
  assert.match(diagnostics.output, /invalid/);
  assert.doesNotMatch(diagnostics.output, /Do you trust|workspace trusted|preparing/i);
  safe(diagnostics.output, f.root);
  const recover = await cli(f.root, ["--provider-config-recover", f.backupId, "--yes"]);
  assert.equal(recover.code, 1, recover.output);
  assert.match(recover.output, /interactive terminal/);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
  safe(recover.output, f.root);
});

test("desktop diagnostics work before provider startup, cancellation consumes preview and success latches restart", async (t) => {
  const f = await fixture(t);
  let confirmed = false, confirmations = 0, detached = 0;
  const controller = new DesktopProviderRecoveryController({ registry: f.registry, isBusy: () => false,
    confirm: async () => { confirmations++; return confirmed; }, onRecovered: () => { detached++; } });
  const initial = await controller.handle({ action: "snapshot" });
  assert.equal(initial.diagnostics.state, "invalid");
  const preview = await controller.handle({ action: "preview", contextId: initial.contextId, backupId: f.backupId });
  const cancelled = await controller.handle({ action: "recover", contextId: initial.contextId, token: preview.preview!.token });
  assert.equal(cancelled.preview, undefined);
  assert.equal(cancelled.restartRequired, false);
  assert.equal(confirmations, 1);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
  await assert.rejects(controller.handle({ action: "recover", contextId: initial.contextId, token: preview.preview!.token }), /失效/);
  confirmed = true;
  const again = await controller.handle({ action: "preview", contextId: initial.contextId, backupId: f.backupId });
  const result = await controller.handle({ action: "recover", contextId: initial.contextId, token: again.preview!.token });
  assert.equal(result.restartRequired, true);
  assert.equal(result.completedAction, "restore-backup");
  assert.equal(detached, 1);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.original);
  assert.throws(() => controller.assertCanContinue(), /重启/);
  safe([initial, preview, result], f.root);
});

for (const label of ["task", "terminal", "OAuth"]) test(`desktop blocks recovery while ${label} is active`, async (t) => {
  const f = await fixture(t);
  let busy = false, confirmed = false;
  const controller = new DesktopProviderRecoveryController({ registry: f.registry, isBusy: () => busy, confirm: async () => { confirmed = true; return true; } });
  const state = await controller.handle({ action: "snapshot" });
  const preview = await controller.handle({ action: "preview", contextId: state.contextId, backupId: f.backupId });
  busy = true;
  await assert.rejects(controller.handle({ action: "recover", contextId: state.contextId, token: preview.preview!.token }), /结束任务/);
  assert.equal(confirmed, false);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
});

test("desktop rejects host changes and busy races during confirmation; actions cannot overlap native dialog", async (t) => {
  const f = await fixture(t);
  let hostContext = "first";
  let finish!: (value: boolean) => void;
  const controller = new DesktopProviderRecoveryController({ registry: f.registry, isBusy: () => false, contextIdentity: () => hostContext,
    confirm: () => new Promise<boolean>((resolve) => { finish = resolve; }) });
  const state = await controller.handle({ action: "snapshot" });
  const preview = await controller.handle({ action: "preview", contextId: state.contextId, backupId: f.backupId });
  const applying = controller.handle({ action: "recover", contextId: state.contextId, token: preview.preview!.token });
  assert.throws(() => controller.assertCanContinue(), /正在进行/);
  await assert.rejects(controller.handle({ action: "recover", contextId: state.contextId, token: preview.preview!.token }), /正在进行/);
  hostContext = "reopened";
  finish(true);
  await assert.rejects(applying, /上下文已变化/);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
  controller.assertCanContinue();
  const next = await controller.handle({ action: "snapshot" });
  assert.notEqual(next.contextId, state.contextId);
});

test("desktop busy transition after native confirmation and unexpected errors fail closed without secret output", async (t) => {
  const f = await fixture(t);
  let busy = false;
  const controller = new DesktopProviderRecoveryController({ registry: f.registry, isBusy: () => busy, confirm: async () => { busy = true; return true; } });
  const state = await controller.handle({ action: "snapshot" });
  const preview = await controller.handle({ action: "preview", contextId: state.contextId, backupId: f.backupId });
  await assert.rejects(controller.handle({ action: "recover", contextId: state.contextId, token: preview.preview!.token }), /结束任务/);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
  const broken = new DesktopProviderRecoveryController({ registry: f.registry, isBusy: () => false, confirm: async () => { throw new Error(canary); } });
  const ready = await broken.handle({ action: "snapshot" });
  const selected = await broken.handle({ action: "preview", contextId: ready.contextId, backupId: f.backupId });
  await assert.rejects(broken.handle({ action: "recover", contextId: ready.contextId, token: selected.preview!.token }), (error) => { safe(String(error), f.root); return true; });
});

test("desktop cancel and refresh discard pending previews; arbitrary paths never reach backup contents", async (t) => {
  const f = await fixture(t);
  const controller = new DesktopProviderRecoveryController({ registry: f.registry, isBusy: () => false, confirm: async () => true });
  const state = await controller.handle({ action: "snapshot" });
  const preview = await controller.handle({ action: "preview", contextId: state.contextId, backupId: f.backupId });
  const cancelled = await controller.handle({ action: "cancel", contextId: state.contextId, token: preview.preview!.token });
  assert.equal(cancelled.preview, undefined);
  const again = await controller.handle({ action: "preview", contextId: state.contextId, backupId: f.backupId });
  await controller.handle({ action: "snapshot" });
  await assert.rejects(controller.handle({ action: "recover", contextId: state.contextId, token: again.preview!.token }), /失效/);
  await assert.rejects(controller.handle({ action: "preview", contextId: state.contextId, backupId: f.filename }), (error) => { safe(String(error), f.root); return true; });
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
});

test("slow read-only recovery diagnostics leave active task stop and approval controls available", async (t) => {
  const f = await fixture(t);
  let finishDiagnostics!: () => void;
  const delayed = new Promise<void>((resolve) => { finishDiagnostics = resolve; });
  let activeTask = true;
  let approvalDecisions = 0;
  const controller = new DesktopProviderRecoveryController({
    registry: {
      configurationDiagnostics: async () => { await delayed; return f.registry.configurationDiagnostics(); },
      previewConfigurationRecovery: (id) => f.registry.previewConfigurationRecovery(id),
      confirmConfigurationRecovery: (token, confirmed) => f.registry.confirmConfigurationRecovery(token, confirmed),
    },
    isBusy: () => activeTask,
    confirm: async () => { throw new Error("read-only diagnostics must never request confirmation"); },
  });
  const reading = controller.handle({ action: "snapshot" });
  // Main-process Stop, steer and approval IPC use this same guard before dispatch.
  controller.assertCanContinue();
  approvalDecisions++;
  controller.assertCanContinue();
  activeTask = false;
  assert.equal(approvalDecisions, 1);
  assert.equal(activeTask, false, "Stop must remain available before diagnostics finish");
  // Recovery requests still cannot overlap one another.
  await assert.rejects(controller.handle({ action: "snapshot" }), /正在进行/);
  finishDiagnostics();
  const result = await reading;
  assert.equal(result.diagnostics.state, "invalid");
  assert.equal(result.restartRequired, false);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.malformed);
});

test("CLI current action keeps valid settings and clearly distinguishes dead-lock cleanup from restore", async (t) => {
  const f = await fixture(t);
  const current = '{"version":5,"profiles":[]}';
  await fs.writeFile(f.filename, current);
  if (process.platform === "win32") await verifyProviderWindowsPrivacy(f.filename, false, false);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const lock = path.join(`${f.filename}.recovery`, "write.lock");
  await privateLockFixture(lock, pid, "fixture");
  const output = io("RECOVER");
  const recovered = await runProviderRecoveryCommand(f.registry, { action: "recover", backupId: "current" }, output.value);
  safe(output.output, f.root);
  assert.deepEqual(recovered, { exitCode: 0, restartRequired: true }, recoveryAssertionSummary(output));
  assert.equal(await fs.readFile(f.filename, "utf8"), current);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  assert.match(output.output.join("\n"), /Keep current settings/);
  assert.match(output.output.join("\n"), /schema 5 \(unchanged\)/);
  assert.doesNotMatch(output.output.join("\n"), /Configuration backup restored|schema 5 →/);
  await privateLockFixture(lock, pid, "fixture-desktop");
  const desktop = new DesktopProviderRecoveryController({ registry: new ProviderRegistry(f.filename), isBusy: () => false, confirm: async (preview) => {
    assert.equal(preview.action, "keep-current");
    return true;
  } });
  const state = await desktop.handle({ action: "snapshot" });
  const preview = await desktop.handle({ action: "preview", contextId: state.contextId, backupId: "current" });
  const result = await desktop.handle({ action: "recover", contextId: state.contextId, token: preview.preview!.token });
  assert.equal(result.completedAction, "keep-current");
  assert.equal(result.restartRequired, true);
  assert.equal(await fs.readFile(f.filename, "utf8"), current);
});
