import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPreferences, parsePreferences } from "../apps/desktop/shared/preferences.js";
import { PreferencesStore } from "../apps/desktop/main/preferences-store.js";

test("desktop preferences defaults are non-secret and conservative", () => {
  assert.deepEqual(parsePreferences({}), defaultPreferences);
  assert.equal(defaultPreferences.theme, "system");
  assert.equal(defaultPreferences.notifyComplete, false);
  assert.equal(defaultPreferences.sound, false);
});
test("desktop preferences reject unknown authority, credentials and invalid values", () => {
  for (const value of [{ fullAccess: true }, { apiKey: "canary" }, { theme: ["dark"] }, { density: 1 }, { fontSize: 99 }, { codeSize: 12.5 }, { sound: "true" }, [], null]) assert.throws(() => parsePreferences(value));
  assert.equal(parsePreferences({ theme: "dark", sendKey: "ctrl-enter" }).theme, "dark");
});
test("desktop preferences persist and serialize saves without touching workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-prefs-"));
  try {
    const file = path.join(root, "preferences.json");
    const store = new PreferencesStore(file);
    await store.load();
    await Promise.all([store.save({ ...defaultPreferences, theme: "dark" }), store.save({ ...defaultPreferences, theme: "light", fontSize: 16 })]);
    const reopened = new PreferencesStore(file); await reopened.load();
    assert.equal(reopened.value.theme, "light"); assert.equal(reopened.value.fontSize, 16);
    assert.deepEqual(await fs.readdir(root), ["preferences.json"]);
    assert.throws(() => store.save({ approvalMode: "full" }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("corrupt preferences and failed writes cannot alter active preferences", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-prefs-"));
  try {
    const file = path.join(root, "preferences.json"); await fs.writeFile(file, '{"theme":"dark","fullAccess":true}');
    const store = new PreferencesStore(file); await store.load(); assert.deepEqual(store.value, defaultPreferences);
    const broken = new PreferencesStore(path.join(root, "missing", "preferences.json"));
    await assert.rejects(broken.save({ ...defaultPreferences, theme: "dark" })); assert.deepEqual(broken.value, defaultPreferences);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
