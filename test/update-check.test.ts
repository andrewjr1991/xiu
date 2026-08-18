import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdates, compareVersions, formatUpdateCheck, formatUpdateCheckError, updateProxyFromEnvironment, upgradeCommand } from "../src/update-check.js";

function response(body: string, status = 200, contentLength?: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === "content-length" && contentLength !== undefined ? String(contentLength) : null },
    text: async () => body,
  };
}

test("semantic version comparison follows release and prerelease precedence", () => {
  assert.equal(compareVersions("0.15.7", "0.16.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("999999999999999999999999.0.0", "1000000000000000000000000.0.0"), -1);
  assert.throws(() => compareVersions("1.0.0-01", "1.0.0"), /Invalid semantic version/);
  assert.throws(() => compareVersions("1.0.0+broken..metadata", "1.0.0"), /Invalid semantic version/);
});

test("update check reports an available official npm release", async () => {
  let requestedUrl = "";
  const result = await checkForUpdates("0.15.7", {
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    fetcher: async (url, init) => {
      requestedUrl = url;
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "GET");
      return response('{"version":"0.16.0"}');
    },
  });
  assert.equal(requestedUrl, "https://registry.npmjs.org/%40xiu-ai%2Fcli/latest");
  assert.deepEqual(result, {
    currentVersion: "0.15.7",
    latestVersion: "0.16.0",
    status: "update-available",
    registry: "https://registry.npmjs.org",
    checkedAt: "2026-08-18T00:00:00.000Z",
  });
});

test("update check rejects malformed, failed, and oversized registry responses", async () => {
  await assert.rejects(checkForUpdates("0.15.7", { fetcher: async () => response("missing", 503) }), /HTTP 503/);
  await assert.rejects(checkForUpdates("0.15.7", { fetcher: async () => response("not-json") }), /invalid JSON/);
  await assert.rejects(checkForUpdates("0.15.7", { fetcher: async () => response('{"version":"latest"}') }), /Invalid semantic version/);
  await assert.rejects(checkForUpdates("0.15.7", { fetcher: async () => response("{}", 200, 300_000) }), /too large/);
  await assert.rejects(checkForUpdates("0.15.7", {
    fetcher: async () => ({
      ...response(""),
      body: (async function* () {
        yield Buffer.alloc(200_000);
        yield Buffer.alloc(100_000);
      })(),
    }),
  }), /too large/);
});

test("formatting is localized and never claims to execute the upgrade", () => {
  const result = {
    currentVersion: "0.15.7",
    latestVersion: "0.16.0",
    status: "update-available" as const,
    registry: "https://registry.npmjs.org",
    checkedAt: "2026-08-18T00:00:00.000Z",
  };
  const chinese = formatUpdateCheck(result, "zh-CN", "win32");
  assert.match(chinese, /发现新版本/);
  assert.match(chinese, /仅显示，尚未执行/);
  assert.match(chinese, /npm\.cmd install --global/);
  assert.equal(upgradeCommand("linux").startsWith("npm install"), true);
  assert.equal(formatUpdateCheckError(new Error("npm registry response is too large"), "zh-CN"), "npm Registry 响应超过 256 KiB 安全上限");
  assert.equal(formatUpdateCheckError(new Error("network unavailable"), "en-US"), "network unavailable");
});

test("update checks use only the dedicated or standard HTTPS proxy variables", () => {
  assert.equal(updateProxyFromEnvironment({ XIU_UPDATE_PROXY: "http://127.0.0.1:12334", XIU_WEB_PROXY: "http://wrong:1" }), "http://127.0.0.1:12334/");
  assert.equal(updateProxyFromEnvironment({ HTTPS_PROXY: "http://proxy.example:8080" }), "http://proxy.example:8080/");
  assert.equal(updateProxyFromEnvironment({ XIU_WEB_PROXY: "http://wrong:1", AGNES_PROXY: "http://wrong:2" }), undefined);
  assert.throws(() => updateProxyFromEnvironment({ XIU_UPDATE_PROXY: "http://user:secret@proxy.example:8080" }), /must not contain credentials/);
});
