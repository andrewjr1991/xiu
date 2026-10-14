import fs from "node:fs/promises";
import type { TestContext } from "node:test";
import { replaceProviderWindowsPrivacyVerifierForTests, verifyProviderWindowsPrivacyBatch } from "../../src/provider-config-migration.js";

let standInInstalled = false;

/**
 * Speed up provider settings storage on Windows. Every ACL check starts
 * Windows PowerShell, and most of them only re-verify objects this process
 * already made private. The stand-in still applies the real owner-only DACL
 * when an object is created (so CLI child processes, which use the real check,
 * accept it) but skips re-verification. Re-verification is covered by the
 * Windows privacy CI step and by tests that call `useRealWindowsAcl`.
 */
export function installWindowsAclStandIn(): void {
  if (process.platform !== "win32") return;
  replaceProviderWindowsPrivacyVerifierForTests(async (checks) => {
    const initialize = checks.filter((check) => check.initialize);
    for (const check of checks) if (!check.initialize) await fs.lstat(check.target);
    if (initialize.length) await verifyProviderWindowsPrivacyBatch(initialize);
  });
  standInInstalled = true;
}

/** Run this test with the real Windows ACL check, restoring the stand-in afterwards. */
export function useRealWindowsAcl(t: TestContext): void {
  replaceProviderWindowsPrivacyVerifierForTests();
  if (standInInstalled) t.after(() => installWindowsAclStandIn());
}

/**
 * Record each storage ACL helper process (one entry per batch) without
 * running PowerShell. Off Windows, also report win32 so the Windows storage
 * path runs; both changes are undone after the test.
 */
export function countWindowsAclBatches(t: TestContext): string[][] {
  const batches: string[][] = [];
  replaceProviderWindowsPrivacyVerifierForTests(async (checks) => {
    for (const check of checks) await fs.lstat(check.target);
    batches.push(checks.map((check) => `${check.directory ? "directory" : "file"}:${check.initialize ? "initialize" : "verify"}`));
  });
  t.after(() => { if (standInInstalled) installWindowsAclStandIn(); else replaceProviderWindowsPrivacyVerifierForTests(); });
  if (process.platform !== "win32") {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    t.after(() => { Object.defineProperty(process, "platform", { value: platform, configurable: true }); });
  }
  return batches;
}
