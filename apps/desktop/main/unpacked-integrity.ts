import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Integrity check for the few files electron-builder unpacks next to app.asar
 * (S6). The asar itself is covered by the EmbeddedAsarIntegrityValidation
 * fuse, but `app.asar.unpacked/` is plain files on disk. The build writes
 * `dist/main/unpacked-manifest.json` (inside the asar) with the SHA-256 of
 * each unpacked component; before the main process starts one of them it
 * hashes the unpacked copy and compares. Outside a packaged build nothing is
 * unpacked, so nothing is checked. node-pty's native module is loaded by Node
 * itself and is not covered here; this is not code signing.
 */
export const UNPACKED_MANIFEST_VERSION = 1 as const;
export const UNPACKED_MANIFEST_NAME = "unpacked-manifest.json";
/** Paths relative to `dist/`, matching the `asarUnpack` patterns in apps/desktop/package.json. */
export type UnpackedComponent = "main/background-worker.mjs" | "native/XiuComputerBridge.exe";

export interface UnpackedManifest { version: typeof UNPACKED_MANIFEST_VERSION; files: Record<string, string> }

export type ComponentIntegrityCode = "manifest-missing" | "manifest-invalid" | "not-listed" | "unreadable" | "mismatch";

export class ComponentIntegrityError extends Error {
  constructor(readonly code: ComponentIntegrityCode, readonly component: string) {
    super(`XIU_COMPONENT_INTEGRITY: ${component} failed the installed-component check (${code}); refusing to start it. Reinstall Xiu. 组件与安装包内清单不一致，已拒绝启动，请重新安装 Xiu。`);
    this.name = "ComponentIntegrityError";
  }
}

export function sha256Hex(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function parseUnpackedManifest(text: string, component = "manifest"): UnpackedManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ComponentIntegrityError("manifest-invalid", component); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ComponentIntegrityError("manifest-invalid", component);
  const manifest = parsed as Partial<UnpackedManifest>;
  const files = manifest.files;
  if (manifest.version !== UNPACKED_MANIFEST_VERSION || !files || typeof files !== "object" || Array.isArray(files)
    || !Object.entries(files).every(([key, value]) => typeof key === "string" && key.length > 0 && typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) {
    throw new ComponentIntegrityError("manifest-invalid", component);
  }
  return { version: UNPACKED_MANIFEST_VERSION, files: { ...files } };
}

export function assertComponentMatches(manifest: UnpackedManifest, component: string, bytes: Uint8Array): void {
  const expected = manifest.files[component];
  if (!expected) throw new ComponentIntegrityError("not-listed", component);
  if (sha256Hex(bytes) !== expected) throw new ComponentIntegrityError("mismatch", component);
}

/** Reads the manifest and the unpacked file from disk and compares them; every failure is a ComponentIntegrityError. */
export function verifyComponentFile(component: string, manifestPath: string, filePath: string, readFile: (file: string) => Buffer = (file) => fs.readFileSync(file)): void {
  let manifestText: string;
  try { manifestText = readFile(manifestPath).toString("utf8"); }
  catch (error) { throw new ComponentIntegrityError((error as NodeJS.ErrnoException).code === "ENOENT" ? "manifest-missing" : "manifest-invalid", component); }
  const manifest = parseUnpackedManifest(manifestText, component);
  let bytes: Buffer;
  try { bytes = readFile(filePath); } catch { throw new ComponentIntegrityError("unreadable", component); }
  assertComponentMatches(manifest, component, bytes);
}

/**
 * Where a dist-relative component lives for the main bundle at `moduleUrl`
 * (`dist/main/index.js`), and whether it is served from `app.asar.unpacked`.
 */
export function unpackedComponentLocation(component: UnpackedComponent, moduleUrl: string): { path: string; manifestPath: string; packaged: boolean } {
  const packedPath = fileURLToPath(new URL(`../${component}`, moduleUrl));
  const packaged = /app\.asar[\\/]/.test(packedPath);
  return {
    path: packaged ? packedPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1") : packedPath,
    manifestPath: fileURLToPath(new URL(`./${UNPACKED_MANIFEST_NAME}`, moduleUrl)),
    packaged,
  };
}

/** The path to start a component from; in a packaged build the unpacked copy is verified against the asar's manifest first. */
export function verifiedComponentPath(component: UnpackedComponent, moduleUrl: string = import.meta.url): string {
  const location = unpackedComponentLocation(component, moduleUrl);
  if (location.packaged) verifyComponentFile(component, location.manifestPath, location.path);
  return location.path;
}
