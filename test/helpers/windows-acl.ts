import fs from "node:fs/promises";
import type { TestContext } from "node:test";
import { replaceProviderWindowsPrivacyVerifierForTests, verifyProviderWindowsPrivacy } from "../../src/provider-config-migration.js";

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
  replaceProviderWindowsPrivacyVerifierForTests(async (target, directory, initialize) => {
    if (initialize) await verifyProviderWindowsPrivacy(target, directory, true);
    else await fs.lstat(target);
  });
  standInInstalled = true;
}

/** Run this test with the real Windows ACL check, restoring the stand-in afterwards. */
export function useRealWindowsAcl(t: TestContext): void {
  replaceProviderWindowsPrivacyVerifierForTests();
  if (standInInstalled) t.after(() => installWindowsAclStandIn());
}
