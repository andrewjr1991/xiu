import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addedPermissions, parseExtensionPermissions, PermissionGrantStore, type ExtensionPermissionManifest } from "../src/extension-permissions.js";

test("permission parser separates known and unknown names", () => {
  assert.deepEqual(parseExtensionPermissions("workspace:read, network:access mystery:power"), {
    permissions: ["network:access", "workspace:read"],
    unknown: ["mystery:power"],
  });
});

test("permission grants are fingerprinted and detect expansion", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-permissions-"));
  const store = new PermissionGrantStore(path.join(directory, "grants.json"));
  const base: ExtensionPermissionManifest = {
    kind: "mcp", name: "docs", origin: "user:docs", permissions: ["network:access", "external:read"], declared: true,
  };
  assert.equal(await store.isApproved(base), false);
  await store.approve(base);
  assert.equal(await store.isApproved(base), true);
  const expanded = { ...base, permissions: [...base.permissions, "external:write"] as ExtensionPermissionManifest["permissions"] };
  assert.equal(await store.isApproved(expanded), false);
  assert.deepEqual(addedPermissions(await store.approvedManifest(expanded), expanded), ["external:write"]);
  const saved = await fs.readFile(path.join(directory, "grants.json"), "utf8");
  assert.doesNotMatch(saved, /user:docs/);
  await fs.rm(directory, { recursive: true, force: true });
});
