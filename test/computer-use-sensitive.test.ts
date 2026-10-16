import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { BLOCKED_APP_PATTERN, CONSEQUENTIAL_CONTROL_PATTERN, SENSITIVE_WINDOW_TITLE_PATTERN, isBlockedApp, isConsequentialControlName, isSensitiveWindowTitle } from "../apps/desktop/shared/computer-use-sensitive.js";
import { BRIDGE_ERROR_REASONS } from "../apps/desktop/main/windows-computer.js";

const bridge = fs.readFileSync(new URL("../apps/desktop/native/ComputerBridge.cs", import.meta.url), "utf8");
const constant = (name: string) => { const match = bridge.match(new RegExp(`const string ${name}=@"([^"]*)";`)); assert.ok(match, `${name} missing from ComputerBridge.cs`); return match[1]; };

test("the native helper embeds the same sensitivity patterns as the main process", () => {
  assert.equal(constant("SensitiveWindowTitlePattern"), SENSITIVE_WINDOW_TITLE_PATTERN);
  assert.equal(constant("BlockedAppPattern"), BLOCKED_APP_PATTERN);
  assert.equal(constant("ConsequentialControlPattern"), CONSEQUENTIAL_CONTROL_PATTERN);
  // Patterns stay portable between .NET and JavaScript: no lookarounds, backreferences, named groups or flags.
  for (const pattern of [SENSITIVE_WINDOW_TITLE_PATTERN, BLOCKED_APP_PATTERN, CONSEQUENTIAL_CONTROL_PATTERN]) assert.doesNotMatch(pattern, /\(\?|\\\d|\\[pPkK]/);
});

test("sensitive windows, blocked applications and consequential controls are recognised case-insensitively", () => {
  for (const title of ["登录 - 微信", "Sign in to GitHub", "Log In", "PayPal Checkout", "KeePass 密码库", "Enter your verification code", "Administrator: Command Prompt"]) assert.equal(isSensitiveWindowTitle(title), true, title);
  for (const title of ["Xiu isolated window fixture", "Untitled - Notepad", "Inbox - Mail"]) assert.equal(isSensitiveWindowTitle(title), false, title);
  for (const app of ["xiu", "PowerShell", "WindowsTerminal", "OpenConsole", "putty", "mstsc", "KeePassXC", "1Password", "Bitwarden", "explorer", "regedit"]) assert.equal(isBlockedApp(app), true, app);
  for (const app of ["notepad", "chrome", "XiuWindowFixture", "code"]) assert.equal(isBlockedApp(app), false, app);
  for (const name of ["Delete fixture", "Send", "Pay now", "发布", "Uninstall", "Grant access"]) assert.equal(isConsequentialControlName(name), true, name);
  for (const name of ["Fixture click", "Load fixture", "Editable field", ""]) assert.equal(isConsequentialControlName(name), false, name);
});

test("every error code the native helper can report has a user-facing reason", () => {
  const match = bridge.match(/string\[\] codes=\{([^}]*)\};/);
  assert.ok(match);
  const codes = [...match[1].matchAll(/"([^"]+)"/g)].map(entry => entry[1]);
  assert.ok(codes.includes("control-uninspected") && codes.includes("sensitive-window-denied"));
  for (const code of codes) assert.ok(BRIDGE_ERROR_REASONS[code], `no reason for ${code}`);
  // Refusals that stem from an unreadable control are gated in the helper on an explicit per-step flag only.
  assert.match(bridge, /AllowUninspected\(\)/);
  assert.doesNotMatch(bridge, /allowUninspected"\]=|allowUninspected=true/);
});

test("popups the target opened count as the target only when they are same-process, overlapping and not sensitively titled", () => {
  // The predicate is the single gate for compositing, control listing, occlusion and foreground checks.
  const predicate = bridge.slice(bridge.indexOf("static bool OwnedPopup("), bridge.indexOf("static List<IntPtr> OwnedPopups("));
  assert.match(predicate, /GetAncestor\(h,2\)!=h\)return false/);
  assert.match(predicate, /pid\.ToString\(\)!=S\("pid"\)\)return false/);
  assert.match(predicate, /0x80000000/);
  assert.match(predicate, /SensitiveWindowTitlePattern/);
  for (const site of [/Belongs\(GetAncestor\(WindowFromPoint\(p\),2\),target\)\)throw new Exception\("target-occluded"\)/, /Belongs\(GetAncestor\(WindowFromPoint\(q\),2\),target\)\)throw new Exception\("target-occluded"\)/, /Belongs\(GetForegroundWindow\(\),target\)\)throw new Exception\("target-not-foreground"\)/, /Belongs\(GetForegroundWindow\(\),target\)\)throw new Exception\("focus-changed-outcome-unknown"\)/]) assert.match(bridge, site);
  // A popup is painted only from its own pixels: PrintWindow first, screen copy only where the popup itself is on top.
  assert.match(bridge, /GetAncestor\(WindowFromPoint\(centre\),2\)!=popup\)continue;/);
});
