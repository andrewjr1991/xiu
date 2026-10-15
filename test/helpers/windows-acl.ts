import fs from "node:fs/promises";
import type { TestContext } from "node:test";
import { replaceProviderWindowsPrivacyVerifierForTests } from "../../src/provider-config-migration.js";

let standInInstalled = false;

/**
 * Speed up provider settings storage on Windows. Every ACL check starts
 * Windows PowerShell (about a second each), and the provider registry tests
 * create many fresh settings files, backups and locks. The stand-in only
 * confirms that each object exists and never starts PowerShell: neither for
 * re-verification nor for initializing a new object's owner-only DACL. The
 * real initialization and verification are covered by the Windows privacy CI
 * step, by `test/provider-windows-privacy.test.ts`, and by tests that call
 * `useRealWindowsAcl`; a test whose CLI child process must accept files this
 * process created has to use the real check, because the child verifies the
 * exact owner-only DACL.
 */
export function installWindowsAclStandIn(): void {
  if (process.platform !== "win32") return;
  replaceProviderWindowsPrivacyVerifierForTests(async (checks) => {
    for (const check of checks) await fs.lstat(check.target);
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
