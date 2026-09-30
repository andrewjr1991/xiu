import assert from "node:assert/strict";
import test from "node:test";
import {
  runUpdateCheckOnce,
  runUpdateDoctorOnce,
  UpdateCommandController,
} from "../src/commands/update.js";
import type { XiuSettings } from "../src/settings.js";
import type { CachedUpdateCheck, UpdateCheckResult, UpdateDoctorResult } from "../src/update-check.js";

function available(version = "0.19.1"): UpdateCheckResult {
  return {
    currentVersion: "0.19.0",
    latestVersion: version,
    status: "update-available",
    registry: "https://registry.npmjs.org",
    checkedAt: "2026-09-28T00:00:00.000Z",
  };
}

function memoryCache(initial?: CachedUpdateCheck) {
  let cached = initial;
  return {
    load: async () => cached,
    save: async (result: UpdateCheckResult) => { cached = { result, fresh: true }; },
    value: () => cached,
  };
}

function doctor(status: UpdateDoctorResult["status"]): UpdateDoctorResult {
  return {
    status,
    items: [{ id: "runtime", level: status, summary: status === "failure" ? "Runtime failed" : "Runtime ready" }],
  };
}

test("update command controller owns status, checks, doctor, and usage routing", async () => {
  const cache = memoryCache({ result: available(), fresh: true });
  const settings: XiuSettings = {};
  const controller = new UpdateCommandController({
    currentVersion: "0.19.0",
    language: "en-US",
    settings,
    saveSettings: async () => undefined,
    cache,
    check: async () => available("0.19.2"),
    diagnose: async () => doctor("pass"),
  });

  assert.equal((await controller.execute("/status")).handled, false);
  assert.match((await controller.execute("/update status")).messages[0].text, /disabled/i);
  assert.match((await controller.execute("/update doctor")).messages[0].text, /Runtime ready/);
  assert.match((await controller.execute("/update unexpected")).messages[0].text, /Usage/);
  const checked = await controller.execute("/update");
  assert.match(checked.messages[0].text, /0\.19\.2/);
  assert.equal(cache.value()?.result.latestVersion, "0.19.2");
});

test("notification commands persist state and show a fresh reminder only once", async () => {
  const cache = memoryCache({ result: available(), fresh: true });
  const settings: XiuSettings = {};
  let saves = 0;
  const controller = new UpdateCommandController({
    currentVersion: "0.19.0",
    language: "en-US",
    settings,
    saveSettings: async () => { saves += 1; },
    cache,
  });

  const enabled = await controller.execute("/update notifications on");
  assert.equal(settings.update?.notifications, true);
  assert.equal(enabled.messages.length, 2);
  assert.equal(enabled.messages[1].kind, "warning");
  assert.deepEqual(await controller.initialize(), []);

  const disabled = await controller.execute("/update notifications off");
  assert.equal(settings.update?.notifications, false);
  assert.equal(disabled.messages[0].kind, "success");
  assert.equal(saves, 2);
});

test("disabling notifications suppresses an in-flight background reminder", async () => {
  const cache = memoryCache();
  const settings: XiuSettings = { update: { notifications: true } };
  let resolveCheck!: (result: UpdateCheckResult) => void;
  const controller = new UpdateCommandController({
    currentVersion: "0.19.0",
    language: "en-US",
    settings,
    saveSettings: async () => undefined,
    cache,
    check: async () => new Promise((resolve) => { resolveCheck = resolve; }),
  });

  assert.deepEqual(await controller.initialize(), []);
  await controller.execute("/update notifications off");
  resolveCheck(available());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.flushPendingReminder(), []);
});

test("background refresh is silent on failure", async () => {
  const controller = new UpdateCommandController({
    currentVersion: "0.19.0",
    language: "en-US",
    settings: { update: { notifications: true } },
    saveSettings: async () => undefined,
    cache: memoryCache(),
    check: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(await controller.initialize(), []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.flushPendingReminder(), []);
});

test("one-shot update check reports failures with a non-zero exit code", async () => {
  const result = await runUpdateCheckOnce({
    currentVersion: "0.19.0",
    language: "en-US",
    cache: memoryCache(),
    check: async () => { throw new Error("network unavailable"); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.message.kind, "error");
  assert.match(result.message.text, /network unavailable/);
});

test("one-shot update doctor fails only for local hard failures", async () => {
  const warning = await runUpdateDoctorOnce({
    currentVersion: "0.19.0",
    language: "en-US",
    diagnose: async () => doctor("warning"),
  });
  const failure = await runUpdateDoctorOnce({
    currentVersion: "0.19.0",
    language: "en-US",
    diagnose: async () => doctor("failure"),
  });
  assert.equal(warning.exitCode, 0);
  assert.equal(failure.exitCode, 1);
});
