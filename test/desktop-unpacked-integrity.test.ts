import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ComponentIntegrityError, parseUnpackedManifest, sha256Hex, unpackedComponentLocation, verifiedComponentPath, verifyComponentFile } from "../apps/desktop/main/unpacked-integrity.js";

const worker = "main/background-worker.mjs";

test("the unpacked manifest must be version 1 with hex SHA-256 entries", () => {
  const good = parseUnpackedManifest(JSON.stringify({ version: 1, files: { [worker]: "a".repeat(64) } }));
  assert.deepEqual(good.files, { [worker]: "a".repeat(64) });
  for (const bad of ["", "[]", "null", JSON.stringify({ version: 2, files: {} }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, files: { [worker]: "nope" } }), JSON.stringify({ version: 1, files: { [worker]: "A".repeat(64) } })]) {
    assert.throws(() => parseUnpackedManifest(bad), (error: unknown) => error instanceof ComponentIntegrityError && error.code === "manifest-invalid");
  }
});

test("a packaged component is verified against the manifest and every failure refuses the start", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-unpacked-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, "unpacked-manifest.json");
  const file = path.join(root, "background-worker.mjs");
  const bytes = Buffer.from("console.log('worker');\n");
  await fs.writeFile(file, bytes);
  await fs.writeFile(manifest, JSON.stringify({ version: 1, files: { [worker]: sha256Hex(bytes) } }));
  assert.doesNotThrow(() => verifyComponentFile(worker, manifest, file));
  const code = (fn: () => void) => { try { fn(); } catch (error) { return error instanceof ComponentIntegrityError ? error.code : String(error); } return "ok"; };
  await fs.writeFile(file, Buffer.concat([bytes, Buffer.from("// appended\n")]));
  assert.equal(code(() => verifyComponentFile(worker, manifest, file)), "mismatch");
  await fs.writeFile(file, bytes);
  assert.equal(code(() => verifyComponentFile("native/XiuComputerBridge.exe", manifest, file)), "not-listed");
  assert.equal(code(() => verifyComponentFile(worker, manifest, path.join(root, "missing.mjs"))), "unreadable");
  assert.equal(code(() => verifyComponentFile(worker, path.join(root, "absent.json"), file)), "manifest-missing");
  await fs.writeFile(manifest, "{not json");
  assert.equal(code(() => verifyComponentFile(worker, manifest, file)), "manifest-invalid");
  assert.match(new ComponentIntegrityError("mismatch", worker).message, /XIU_COMPONENT_INTEGRITY.*重新安装/);
});

test("components resolve to app.asar.unpacked only inside a packaged build, and development paths are not checked", async (t) => {
  // path.resolve keeps the drive letter on Windows, which pathToFileURL adds to a bare "\\Xiu" root.
  const install = path.resolve(path.sep, "Xiu", "resources");
  const packaged = unpackedComponentLocation("native/XiuComputerBridge.exe", pathToFileURL(path.join(install, "app.asar", "dist", "main", "index.js")).href);
  assert.equal(packaged.packaged, true);
  assert.equal(packaged.path, path.join(install, "app.asar.unpacked", "dist", "native", "XiuComputerBridge.exe"));
  assert.equal(packaged.manifestPath, path.join(install, "app.asar", "dist", "main", "unpacked-manifest.json"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-unpacked-dev-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.join(root, "dist", "main", "index.js")).href;
  // No manifest and no file exist here; a development checkout starts the worker from its ordinary path.
  assert.equal(verifiedComponentPath(worker, moduleUrl), path.join(root, "dist", "main", "background-worker.mjs"));
  // The same layout under app.asar is checked and, with nothing on disk, refused.
  const asarUrl = pathToFileURL(path.join(root, "app.asar", "dist", "main", "index.js")).href;
  assert.throws(() => verifiedComponentPath(worker, asarUrl), (error: unknown) => error instanceof ComponentIntegrityError && error.code === "manifest-missing");
});
