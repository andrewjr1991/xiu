import assert from "node:assert/strict";
import test from "node:test";
import { handleWebCommand, type WebCommandContext } from "../src/commands/web-commands.js";
import type { ManagedWebSearchAuth, ManagedWebSearchCredentialStatus, ManagedWebSearchDevices } from "../src/managed-web-search-auth.js";
import type { SecurityAuditOutcome } from "../src/security-audit.js";
import type { SettingsStore, XiuSettings } from "../src/settings.js";

interface Captured { out: string[]; err: string[]; audits: Array<[string, string | undefined, SecurityAuditOutcome]>; deviceQueries: number }

async function runDevices(credential: ManagedWebSearchCredentialStatus, language: "zh-CN" | "en-US" = "zh-CN"): Promise<Captured> {
  const captured: Captured = { out: [], err: [], audits: [], deviceQueries: 0 };
  const devices: ManagedWebSearchDevices = { devices: [{ id: "device_a", status: "active", createdAt: "2026-08-01T00:00:00Z" }], audit: [], requestId: "req-1" };
  const auth = {
    credentialStatus: async () => credential,
    listDevices: async () => { captured.deviceQueries += 1; return devices; },
  } as unknown as ManagedWebSearchAuth;
  const ctx: WebCommandContext = {
    auditCredential: async (action, subject, outcome) => { captured.audits.push([action, subject, outcome]); },
    language,
    managedWebSearchAuth: () => auth,
    refreshWebSearchRuntime: () => {},
    settings: { webSearch: { enabled: true, managedAuth: "xiu-device" } } as unknown as XiuSettings,
    settingsStore: {} as SettingsStore,
  };
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { captured.out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { captured.err.push(args.map(String).join(" ")); };
  try { assert.equal(await handleWebCommand("/web devices", ctx), true); }
  finally { console.log = log; console.error = error; }
  return captured;
}

test("/web devices before the first search says the device is not registered yet and sends nothing", async () => {
  const zh = await runDevices({ present: false, storage: "none", tokenCached: false });
  assert.equal(zh.deviceQueries, 0);
  assert.equal(zh.err.length, 0, "an unregistered device is not a failure");
  assert.deepEqual(zh.audits, [], "no credential was used, so nothing is audited");
  assert.match(zh.out.join("\n"), /尚未注册托管搜索凭证.*首次联网搜索时会自动注册.*没有发送任何请求/s);
  assert.doesNotMatch(zh.out.join("\n"), /credential is not available|重试/);
  const en = await runDevices({ present: false, storage: "none", tokenCached: false }, "en-US");
  assert.match(en.out.join("\n"), /no managed search credential yet.*first web search registers it automatically.*No request was sent/s);
});

test("/web devices names an unavailable system credential backend instead of a generic failure", async () => {
  const zh = await runDevices({ present: false, storage: "system-unavailable", tokenCached: false });
  assert.equal(zh.deviceQueries, 0);
  assert.match(zh.err.join("\n"), /系统凭证管理器.*当前不可用.*\/web doctor/s);
  assert.deepEqual(zh.audits, [["web-search-devices", "managed-search-device", "failed"]]);
});

test("/web devices queries the server once a credential is present", async () => {
  const zh = await runDevices({ present: true, storage: "system", tokenCached: false });
  assert.equal(zh.deviceQueries, 1);
  assert.equal(zh.err.length, 0);
  assert.match(zh.out.join("\n"), /服务端设备（只读） · 请求 req-1\n- device_a · 有效 · 创建 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.deepEqual(zh.audits, [["web-search-devices", "managed-search-device", "allowed"]]);
});
