import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkForUpdates, checkOfficialRelease, compareVersions, diagnoseUpdateInstallation, formatUpdateCheck, formatUpdateCheckError, formatUpdateDoctor, formatUpdateNotificationStatus, formatUpdateReminder, inspectXiuCommandResolution, UpdateCheckCache, updateDoctorHasHardFailure, updateProxyFromEnvironment, updateProxySourceFromEnvironment, upgradeCommand, type OfficialReleaseMetadata } from "../src/update-check.js";

function response(body: string, status = 200, contentLength?: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === "content-length" && contentLength !== undefined ? String(contentLength) : null },
    text: async () => body,
  };
}

const TEST_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function officialRelease(version: string, checkedAt = "2026-08-18T01:00:00.000Z"): OfficialReleaseMetadata {
  return {
    name: "@xiu-ai/cli",
    version,
    tarball: `https://registry.npmjs.org/@xiu-ai/cli/-/cli-${version}.tgz`,
    integrity: TEST_INTEGRITY,
    shasum: "a".repeat(40),
    registry: "https://registry.npmjs.org",
    checkedAt,
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

test("official release check validates exact package provenance metadata", async () => {
  let requestedUrl = "";
  const result = await checkOfficialRelease("0.16.4", {
    now: () => new Date("2026-08-18T02:00:00.000Z"),
    fetcher: async (url, init) => {
      requestedUrl = url;
      assert.equal(init.redirect, "error");
      return response(JSON.stringify({
        name: "@xiu-ai/cli",
        version: "0.16.4",
        dist: {
          tarball: "https://registry.npmjs.org/@xiu-ai/cli/-/cli-0.16.4.tgz",
          integrity: TEST_INTEGRITY,
          shasum: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        },
      }));
    },
  });
  assert.equal(requestedUrl, "https://registry.npmjs.org/%40xiu-ai%2Fcli/0.16.4");
  assert.equal(result.integrity, TEST_INTEGRITY);
  assert.equal(result.shasum, "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(result.checkedAt, "2026-08-18T02:00:00.000Z");
});

test("official release check rejects mismatched or non-official metadata", async () => {
  const payload = (overrides: Record<string, unknown>) => response(JSON.stringify({
    name: "@xiu-ai/cli",
    version: "0.16.4",
    dist: { tarball: "https://registry.npmjs.org/@xiu-ai/cli/-/cli-0.16.4.tgz", integrity: TEST_INTEGRITY },
    ...overrides,
  }));
  await assert.rejects(checkOfficialRelease("0.16.4", { fetcher: async () => payload({ name: "lookalike" }) }), /package name/);
  await assert.rejects(checkOfficialRelease("0.16.4", { fetcher: async () => payload({ version: "0.16.3" }) }), /version does not match/);
  await assert.rejects(checkOfficialRelease("0.16.4", { fetcher: async () => payload({ dist: { tarball: "https://evil.example/xiu.tgz", integrity: TEST_INTEGRITY } }) }), /not hosted on the official registry/);
  await assert.rejects(checkOfficialRelease("0.16.4", { fetcher: async () => payload({ dist: { tarball: "not a URL", integrity: TEST_INTEGRITY } }) }), /invalid tarball URL/);
  await assert.rejects(checkOfficialRelease("0.16.4", { fetcher: async () => payload({ dist: { tarball: "https://registry.npmjs.org/xiu.tgz", integrity: "sha512-invalid" } }) }), /SHA-512/);
  await assert.rejects(checkOfficialRelease("0.16.4", { fetcher: async () => response("{}", 404) }), /HTTP 404/);
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

test("update cache is bounded to official public metadata and expires after 24 hours", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-update-cache-"));
  const filename = path.join(directory, "update-cache.json");
  const cache = new UpdateCheckCache(filename);
  await cache.save({
    currentVersion: "0.16.0",
    latestVersion: "0.16.1",
    status: "update-available",
    registry: "https://registry.npmjs.org",
    checkedAt: "2026-08-18T00:00:00.000Z",
  });
  assert.deepEqual(await cache.load("0.16.0", new Date("2026-08-18T23:59:59.000Z")), {
    fresh: true,
    result: {
      currentVersion: "0.16.0",
      latestVersion: "0.16.1",
      status: "update-available",
      registry: "https://registry.npmjs.org",
      checkedAt: "2026-08-18T00:00:00.000Z",
    },
  });
  assert.equal((await cache.load("0.16.1", new Date("2026-08-19T00:00:01.000Z")))?.fresh, false);
  const persisted = await fs.readFile(filename, "utf8");
  assert.doesNotMatch(persisted, /proxy|credential|currentVersion|status/);
  await fs.writeFile(filename, "not json", "utf8");
  assert.equal(await cache.load("0.16.0"), undefined);
  await fs.rm(directory, { recursive: true, force: true });
});

test("update reminder and status explicitly state that no installation occurs", () => {
  const result = {
    currentVersion: "0.16.0",
    latestVersion: "0.16.1",
    status: "update-available" as const,
    registry: "https://registry.npmjs.org",
    checkedAt: "2026-08-18T00:00:00.000Z",
  };
  assert.match(formatUpdateReminder(result, "en-US"), /displayed only; not executed/);
  assert.match(formatUpdateNotificationStatus(false, undefined, "en-US"), /disabled \(default\)/);
  assert.match(formatUpdateNotificationStatus(true, { result, fresh: true }, "en-US"), /24-hour cache/);
});

async function createCompletePackageRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-update-doctor-"));
  for (const filename of ["dist/cli.js", "README.md", "USAGE.zh-CN.md"]) {
    const target = path.join(root, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "test\n", "utf8");
  }
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@xiu-ai/cli", version: "0.16.2" }), "utf8");
  return root;
}

test("update doctor reports a healthy local installation without mutating npm", async () => {
  const root = await createCompletePackageRoot();
  await fs.mkdir(path.join(root, "bin"), { recursive: true });
  await fs.writeFile(path.join(root, "bin", "xiu"), "#!/usr/bin/env node\n", "utf8");
  const cache = new UpdateCheckCache(path.join(root, "update-cache.json"));
  await cache.save({
    currentVersion: "0.16.2",
    latestVersion: "0.16.2",
    status: "up-to-date",
    registry: "https://registry.npmjs.org",
    checkedAt: "2026-08-18T00:00:00.000Z",
  });
  const result = await diagnoseUpdateInstallation("0.16.2", {
    packageRoot: root,
    runtimeVersion: "20.19.0",
    environment: { XIU_UPDATE_PROXY: "http://127.0.0.1:12334" },
    platform: "linux",
    pathEntries: [path.join(root, "bin")],
    now: new Date("2026-08-18T01:00:00.000Z"),
    cache,
    checker: async (proxy) => {
      assert.equal(proxy, "http://127.0.0.1:12334/");
      return {
        currentVersion: "0.16.2",
        latestVersion: "0.16.2",
        status: "up-to-date",
        registry: "https://registry.npmjs.org",
        checkedAt: "2026-08-18T01:00:00.000Z",
      };
    },
    releaseChecker: async (version, proxy) => {
      assert.equal(version, "0.16.2");
      assert.equal(proxy, "http://127.0.0.1:12334/");
      return officialRelease(version);
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(updateDoctorHasHardFailure(result), false);
  assert.match(formatUpdateDoctor(result, "zh-CN"), /只执行只读检查/);
  assert.match(formatUpdateDoctor(result, "zh-CN"), /已是最新版本/);
  assert.doesNotMatch(formatUpdateDoctor(result, "zh-CN"), /up-to-date/);
  assert.doesNotMatch(formatUpdateDoctor(result, "en-US"), /npm install/);
  assert.match(formatUpdateDoctor(result, "zh-CN"), /未下载发布包，也未对本地安装文件计算哈希/);
  await fs.rm(root, { recursive: true, force: true });
});

async function createWindowsGlobalInstall(directory: string, version: string): Promise<string> {
  const packageRoot = path.join(directory, "node_modules", "@xiu-ai", "cli");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@xiu-ai/cli", version }), "utf8");
  await fs.writeFile(path.join(packageRoot, "dist", "cli.js"), "export {};\n", "utf8");
  await fs.writeFile(path.join(packageRoot, "README.md"), "test\n", "utf8");
  await fs.writeFile(path.join(packageRoot, "USAGE.zh-CN.md"), "test\n", "utf8");
  await fs.writeFile(path.join(directory, "xiu.cmd"), "@node node_modules/@xiu-ai/cli/dist/cli.js %*\n", "utf8");
  await fs.writeFile(path.join(directory, "xiu.ps1"), "& node $PSScriptRoot/node_modules/@xiu-ai/cli/dist/cli.js $args\n", "utf8");
  return packageRoot;
}

test("command resolution groups npm shims and reports duplicate installations in PATH order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-command-resolution-"));
  const oldBin = path.join(root, "old-bin");
  const currentBin = path.join(root, "current-bin");
  const oldPackage = await createWindowsGlobalInstall(oldBin, "0.15.9");
  const currentPackage = await createWindowsGlobalInstall(currentBin, "0.16.2");
  const resolution = await inspectXiuCommandResolution({
    packageRoot: currentPackage,
    platform: "win32",
    environment: { npm_config_prefix: currentBin },
    pathEntries: [oldBin, currentBin],
  });
  assert.equal(resolution.first?.version, "0.15.9");
  assert.equal(resolution.installations.length, 2);
  assert.equal(resolution.prefixBinOnPath, true);
  assert.equal(resolution.installations[0]?.packageRoot.toLowerCase(), (await fs.realpath(oldPackage)).toLowerCase());

  const doctor = await diagnoseUpdateInstallation("0.16.2", {
    packageRoot: currentPackage,
    runtimeVersion: "22.0.0",
    platform: "win32",
    environment: { npm_config_prefix: currentBin },
    pathEntries: [oldBin, currentBin],
    cache: new UpdateCheckCache(path.join(root, "missing-cache.json")),
    checker: async () => ({
      currentVersion: "0.16.2",
      latestVersion: "0.16.2",
      status: "up-to-date",
      registry: "https://registry.npmjs.org",
      checkedAt: "2026-08-18T00:00:00.000Z",
    }),
    releaseChecker: async (version) => officialRelease(version),
  });
  assert.equal(doctor.status, "warning");
  const output = formatUpdateDoctor(doctor, "zh-CN");
  assert.match(output, /PATH 当前解析到 0\.15\.9/);
  assert.match(output, /请调整 PATH 顺序或清理旧的全局安装/);
  assert.match(output, /npm prefix/);
  await fs.rm(root, { recursive: true, force: true });
});

test("command resolution reports stale launchers and a prefix bin missing from PATH without failing the install", async () => {
  const root = await createCompletePackageRoot();
  const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-stale-launcher-"));
  const staleBin = path.join(staleRoot, "bin");
  await fs.mkdir(staleBin, { recursive: true });
  await fs.writeFile(path.join(staleBin, "xiu.cmd"), "@node missing/xiu.js %*\n", "utf8");
  const result = await diagnoseUpdateInstallation("0.16.2", {
    packageRoot: root,
    runtimeVersion: "22.0.0",
    platform: "win32",
    environment: { npm_config_prefix: path.join(root, "expected-bin") },
    pathEntries: [staleBin],
    cache: new UpdateCheckCache(path.join(root, "missing-cache.json")),
    checker: async () => ({
      currentVersion: "0.16.2",
      latestVersion: "0.16.2",
      status: "up-to-date",
      registry: "https://registry.npmjs.org",
      checkedAt: "2026-08-18T00:00:00.000Z",
    }),
    releaseChecker: async (version) => officialRelease(version),
  });
  assert.equal(updateDoctorHasHardFailure(result), false);
  assert.match(formatUpdateDoctor(result, "en-US"), /stale or unrecognized/);
  assert.match(formatUpdateDoctor(result, "en-US"), /npm prefix bin is not on PATH/);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(staleRoot, { recursive: true, force: true });
});

test("update doctor distinguishes local hard failures from external warnings", async () => {
  const root = await createCompletePackageRoot();
  await fs.rm(path.join(root, "dist/cli.js"));
  const failed = await diagnoseUpdateInstallation("0.16.2", {
    packageRoot: root,
    runtimeVersion: "18.20.0",
    environment: { XIU_UPDATE_PROXY: "http://user:secret@proxy.example:8080" },
    cache: new UpdateCheckCache(path.join(root, "missing-cache.json")),
    checker: async () => { throw new Error("must not be called with an invalid proxy"); },
  });
  assert.equal(failed.status, "failure");
  assert.equal(updateDoctorHasHardFailure(failed), true);
  assert.match(formatUpdateDoctor(failed, "en-US"), /Node\.js 18\.20\.0/);
  assert.match(formatUpdateDoctor(failed, "en-US"), /dist\/cli\.js/);
  assert.doesNotMatch(formatUpdateDoctor(failed, "en-US"), /secret/);

  const warningRoot = await createCompletePackageRoot();
  const warning = await diagnoseUpdateInstallation("0.16.2", {
    packageRoot: warningRoot,
    runtimeVersion: "22.0.0",
    environment: {},
    cache: new UpdateCheckCache(path.join(warningRoot, "missing-cache.json")),
    checker: async () => { throw new Error("DNS unavailable"); },
    releaseChecker: async () => { throw new Error("DNS unavailable"); },
  });
  assert.equal(warning.status, "warning");
  assert.equal(updateDoctorHasHardFailure(warning), false);
  assert.match(formatUpdateDoctor(warning, "en-US"), /usable with external warnings/);
  assert.match(formatUpdateDoctor(warning, "zh-CN"), /DNS unavailable/);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(warningRoot, { recursive: true, force: true });
});

test("update doctor enforces the dependency-compatible Node.js minimum", async () => {
  const root = await createCompletePackageRoot();
  const common = {
    packageRoot: root,
    environment: {},
    platform: "linux" as const,
    pathEntries: [] as string[],
    cache: new UpdateCheckCache(path.join(root, "missing-cache.json")),
    checker: async () => ({
      currentVersion: "0.16.2",
      latestVersion: "0.16.2",
      status: "up-to-date" as const,
      registry: "https://registry.npmjs.org",
      checkedAt: "2026-08-18T00:00:00.000Z",
    }),
    releaseChecker: async (version: string) => officialRelease(version),
  };

  const tooOld = await diagnoseUpdateInstallation("0.16.2", {
    ...common,
    runtimeVersion: "20.18.0",
  });
  assert.equal(tooOld.items.find((item) => item.id === "runtime")?.level, "failure");
  assert.equal(updateDoctorHasHardFailure(tooOld), true);
  assert.match(formatUpdateDoctor(tooOld, "en-US"), /requires Node\.js 20\.18\.1 or newer/);

  const minimum = await diagnoseUpdateInstallation("0.16.2", {
    ...common,
    runtimeVersion: "20.18.1",
  });
  assert.equal(minimum.items.find((item) => item.id === "runtime")?.level, "pass");
  assert.equal(updateDoctorHasHardFailure(minimum), false);

  await fs.rm(root, { recursive: true, force: true });
});

test("official release metadata failures are localized without becoming hard failures", async () => {
  const root = await createCompletePackageRoot();
  const result = await diagnoseUpdateInstallation("0.16.4", {
    packageRoot: root,
    runtimeVersion: "22.20.0",
    environment: {},
    cache: new UpdateCheckCache(path.join(root, "missing-cache.json")),
    checker: async () => ({ currentVersion: "0.16.4", latestVersion: "0.16.4", status: "up-to-date", registry: "https://registry.npmjs.org", checkedAt: "2026-08-18T01:00:00.000Z" }),
    releaseChecker: async () => { throw new Error("npm release tarball is not hosted on the official registry"); },
  });
  assert.equal(result.status, "warning");
  assert.equal(updateDoctorHasHardFailure(result), false);
  assert.match(formatUpdateDoctor(result, "zh-CN"), /npm 发布包不在官方 Registry 域名上/);
  await fs.rm(root, { recursive: true, force: true });
});

test("update proxy source reports precedence without exposing credentials", () => {
  assert.deepEqual(updateProxySourceFromEnvironment({
    XIU_UPDATE_PROXY: "http://127.0.0.1:12334",
    HTTPS_PROXY: "http://proxy.example:8080",
  }), { source: "XIU_UPDATE_PROXY", proxy: "http://127.0.0.1:12334/" });
  assert.deepEqual(updateProxySourceFromEnvironment({}), {});
  assert.throws(() => updateProxySourceFromEnvironment({ HTTPS_PROXY: "http://user:secret@proxy.example" }), /must not contain credentials/);
});
