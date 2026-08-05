import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isWorkspaceTrusted, trustWorkspace } from "../src/trust.js";

test("workspace trust persists after approval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-trust-"));
  const workspace = path.join(root, "project");
  const store = path.join(root, "config", "trusted-workspaces.json");
  await fs.mkdir(workspace);
  assert.equal(await isWorkspaceTrusted(workspace, store), false);
  await trustWorkspace(workspace, store);
  assert.equal(await isWorkspaceTrusted(workspace, store), true);
  const saved = JSON.parse(await fs.readFile(store, "utf8")) as { version: number; workspaces: string[] };
  assert.equal(saved.version, 1);
  assert.equal(saved.workspaces.length, 1);
});

test("trusting a workspace twice does not duplicate it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-trust-repeat-"));
  const store = path.join(root, "trusted.json");
  await trustWorkspace(root, store);
  await trustWorkspace(root, store);
  const saved = JSON.parse(await fs.readFile(store, "utf8")) as { workspaces: string[] };
  assert.equal(saved.workspaces.length, 1);
});
