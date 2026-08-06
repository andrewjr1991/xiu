import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/settings.js";

test("language preference persists outside the project", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-settings-"));
  const filename = path.join(directory, "settings.json");
  const store = new SettingsStore(filename);
  assert.deepEqual(await store.load(), {});
  await store.save({ language: "zh-CN" });
  assert.deepEqual(await store.load(), { language: "zh-CN" });
  assert.match(await fs.readFile(filename, "utf8"), /"zh-CN"/);
});
