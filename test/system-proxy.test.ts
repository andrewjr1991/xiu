import assert from "node:assert/strict";
import test from "node:test";
import { parseProxyServer, parseWindowsInternetSettings, resolveProxySnapshot, resolveSystemProxy } from "../src/system-proxy.js";

test("Windows system proxy settings select the protocol and honor bypass rules", () => {
  const snapshot = parseWindowsInternetSettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=127.0.0.1:7890;https=proxy.example:8443
    ProxyOverride  REG_SZ       <local>;*.internal.example
  `);
  assert.equal(resolveProxySnapshot(snapshot, "https://api.anthropic.com/v1"), "http://proxy.example:8443/");
  assert.equal(resolveProxySnapshot(snapshot, "http://intranet/"), undefined);
  assert.equal(resolveProxySnapshot(snapshot, "https://models.internal.example/v1"), undefined);
});

test("system proxy accepts one HTTP proxy for both protocols and rejects unsupported schemes", () => {
  assert.equal(parseProxyServer("127.0.0.1:7890", "https:"), "http://127.0.0.1:7890/");
  assert.equal(parseProxyServer("socks5://127.0.0.1:1080", "https:"), undefined);
  assert.equal(resolveProxySnapshot({ enabled: false, server: "127.0.0.1:7890" }, "https://example.com"), undefined);
});

test("system proxy uses standard proxy environment variables without exposing credentials", () => {
  assert.equal(resolveSystemProxy("https://api.example.com", { HTTPS_PROXY: "http://127.0.0.1:7890" }), "http://127.0.0.1:7890/");
  assert.equal(resolveSystemProxy("https://api.example.com", { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "api.example.com" }), undefined);
  assert.equal(resolveSystemProxy("https://api.example.com", { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: ".example.com" }), undefined);
});
