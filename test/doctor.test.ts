import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDoctorReport, describeProxyValue, formatDoctorReport, type DoctorProviderRegistry } from "../src/doctor.js";
import { ProviderConfigurationError } from "../src/provider-config-migration.js";
import type { ProviderProfile } from "../src/provider-registry.js";
import type { UpdateDoctorResult } from "../src/update-check.js";

const FEATURES = { text: true as const, tools: true, vision: false, image: false, video: false };

function updateResult(overrides: Partial<UpdateDoctorResult> = {}): UpdateDoctorResult {
  return {
    status: "pass",
    items: [
      { id: "runtime", level: "pass", summary: "Node.js 22.12.0", summaryZh: "Node.js 22.12.0" },
      { id: "package", level: "pass", summary: "required files present", summaryZh: "必需文件齐全" },
      { id: "registry", level: "pass", summary: "latest 0.20.11", summaryZh: "最新 0.20.11" },
    ],
    ...overrides,
  };
}

function fakeRegistry(profiles: ProviderProfile[], options: { loadError?: unknown; active?: string } = {}): DoctorProviderRegistry {
  return {
    async load() { if (options.loadError) throw options.loadError; },
    list: () => profiles,
    activeId: () => options.active ?? profiles[0]?.id,
    activeModel: (id) => profiles.find((profile) => profile.id === id)?.model,
    credentialInfo: () => profiles.map((profile) => ({
      providerId: profile.id, providerName: profile.name, legacyCopyPresent: Boolean(profile.apiKey), systemCopyPresent: false, interruptedMigration: false,
      source: profile.apiKey ? "legacy-file" as const : profile.apiKeyEnv && process.env[profile.apiKeyEnv] ? "environment" as const : "missing" as const,
    })),
    async configurationDiagnostics() {
      return { supportedVersion: 5, sourceVersion: 5, state: "current", backups: [], issues: [], compatibilityNotice: "ok" };
    },
  };
}

test("the report covers every section, redacts keys and proxy passwords, and stays pass when nothing is wrong", async () => {
  const profiles: ProviderProfile[] = [
    { id: "deepseek", name: "DeepSeek", kind: "openai-compatible", model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1", apiKey: "sk-doctor-canary-1234", features: FEATURES },
    { id: "ollama", name: "Ollama", kind: "ollama", model: "qwen3:8b", baseURL: "http://127.0.0.1:11434/v1", features: FEATURES },
  ];
  const report = await collectDoctorReport({
    version: "0.21.0",
    settings: { webSearch: { enabled: true, provider: "free-search", baseURL: "https://search.example", managedAuth: "xiu-device", authBaseURL: "https://search.example/xiu-auth", proxy: "http://corp:Secret%40Pass@proxy.corp.example:8080" } },
    registry: fakeRegistry(profiles),
    env: { HTTPS_PROXY: "http://proxy.corp.example:8080", OPENAI_API_KEY: "sk-env-canary-5678", PATH: "" },
    platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1", cwd: "/work/project", homeDirectory: "/home/user",
    now: new Date("2026-10-15T12:00:00.000Z"),
    updateDoctor: async () => updateResult(),
    uvAvailable: async () => "/home/user/.xiu/uv/uvx",
  });
  assert.equal(report.status, "pass");
  assert.deepEqual(report.sections.map((section) => section.id), ["installation", "providers", "web-search", "proxy", "system"]);
  const zh = formatDoctorReport(report, "zh-CN");
  const en = formatDoctorReport(report, "en-US");
  for (const text of [zh, en]) {
    assert.doesNotMatch(text, /sk-doctor-canary|sk-env-canary|Secret%40Pass|Secret@Pass/);
    assert.match(text, /\*\*\*@proxy\.corp\.example:8080/);
  }
  assert.match(zh, /结论: 通过/);
  assert.match(zh, /2 个渠道，当前 deepseek \/ deepseek-chat/);
  assert.match(zh, /deepseek: openai-compatible · deepseek-chat · api\.deepseek\.com · Key：本机配置文件/);
  assert.match(zh, /uv: 已就绪/);
  assert.match(zh, /HTTPS_PROXY: http:\/\/proxy\.corp\.example:8080/);
  assert.match(zh, /代理用途/);
  assert.doesNotMatch(zh, /代理一致性/, "one proxy host is consistent");
  assert.match(en, /Result: passed/);
  assert.match(en, /\[Proxy and certificates\]/);
});

test("different proxy hosts, a TLS-intercepted registry and Node 20 each produce a warning with a next step", async () => {
  const report = await collectDoctorReport({
    version: "0.21.0",
    settings: {},
    registry: fakeRegistry([]),
    env: { HTTPS_PROXY: "http://a.example:3128", npm_config_https_proxy: "http://b.example:3128", NODE_EXTRA_CA_CERTS: "/nonexistent/corp-root.pem", PATH: "" },
    platform: "linux", arch: "x64", nodeVersion: "20.18.1", osRelease: "6.1", cwd: "/work", homeDirectory: "/home/user",
    updateDoctor: async () => updateResult({ status: "warning", items: [{ id: "registry", level: "warning", summary: "npm registry unreachable: SELF_SIGNED_CERT_IN_CHAIN", summaryZh: "无法访问：SELF_SIGNED_CERT_IN_CHAIN" }] }),
    uvAvailable: async () => undefined,
  });
  assert.equal(report.status, "warning");
  const text = formatDoctorReport(report, "zh-CN");
  assert.match(text, /! 代理一致性: 2 个不同的代理地址：a\.example:3128（HTTPS_PROXY）；b\.example:3128（npm_config_https_proxy）/);
  assert.match(text, /! 证书拦截: .*公司网关替换了证书/);
  assert.match(text, /NODE_EXTRA_CA_CERTS 指向的文件不存在/);
  assert.match(text, /! Node\.js 版本: Node 20\.18\.1 已于 2026-04-30 停止维护/);
  assert.match(text, /! 渠道: 还没有任何渠道/);
  assert.match(text, /联网搜索: 未启用/);
});

test("a provider configuration that cannot be loaded is a failure explained in plain words, and NODE_TLS_REJECT_UNAUTHORIZED=0 is flagged", async () => {
  const report = await collectDoctorReport({
    version: "0.21.0",
    settings: { webSearch: { enabled: true, provider: "tavily", baseURL: "https://api.tavily.com" } },
    registry: fakeRegistry([], { loadError: new ProviderConfigurationError("unsafe", "Provider configuration storage is not a protected regular file/directory") }),
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", PATH: "" },
    platform: "darwin", arch: "arm64", nodeVersion: "22.12.0", osRelease: "24.0", cwd: "/work", homeDirectory: "/Users/u",
    updateDoctor: async () => { throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org"); },
    uvAvailable: async () => undefined,
  });
  assert.equal(report.status, "failure");
  const text = formatDoctorReport(report, "zh-CN");
  assert.match(text, /✗ 渠道配置: 渠道配置文件或它所在的目录不是普通文件/);
  assert.match(text, /xiu --provider-config-diagnostics（provider-config\/unsafe）/);
  assert.match(text, /✗ 证书校验: NODE_TLS_REJECT_UNAUTHORIZED=0/);
  assert.match(text, /! 更新诊断: 未能完成：/);
  assert.match(text, /! 认证: 缺少环境变量 TAVILY_API_KEY/);
  assert.match(text, /结论: 存在需要处理的错误/);
});

test("Windows adds the PowerShell language mode and warns in a constrained mode", async () => {
  const report = await collectDoctorReport({
    version: "0.21.0",
    settings: {},
    registry: fakeRegistry([]),
    env: { WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "" },
    platform: "win32", arch: "x64", nodeVersion: "22.12.0", osRelease: "10.0.26100", cwd: "C:\\Users\\u\\project", homeDirectory: "C:\\Users\\u",
    updateDoctor: async () => updateResult(),
    powerShell: async () => ({ languageMode: "ConstrainedLanguage", executionPolicy: "RemoteSigned" }),
    uvAvailable: async () => undefined,
  });
  const windows = report.sections.find((section) => section.id === "windows");
  assert.ok(windows);
  const text = formatDoctorReport(report, "zh-CN");
  assert.match(text, /! PowerShell: 语言模式 ConstrainedLanguage · 执行策略 RemoteSigned/);
  assert.match(text, /用 npm\.cmd/);
  assert.match(text, /ComSpec: C:\\Windows\\System32\\cmd\.exe/);
});

test("describeProxyValue keeps host and port, hides credentials and marks unparsable values", () => {
  assert.deepEqual(describeProxyValue("http://user:pw@proxy.example:3128"), { display: "http://***@proxy.example:3128", host: "proxy.example:3128", hadCredentials: true, invalid: false });
  assert.deepEqual(describeProxyValue("proxy.example:3128"), { display: "http://proxy.example:3128", host: "proxy.example:3128", hadCredentials: false, invalid: false });
  assert.equal(describeProxyValue("http://[bad").invalid, true);
});

test("the real ProviderRegistry works as the doctor's registry against an empty home", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-doctor-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { ProviderRegistry } = await import("../src/provider-registry.js");
  const report = await collectDoctorReport({
    version: "0.21.0", settings: {}, registry: new ProviderRegistry(path.join(home, "providers.json")),
    env: { PATH: "" }, platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1", cwd: home, homeDirectory: home,
    updateDoctor: async () => updateResult(), uvAvailable: async () => undefined,
  });
  const text = formatDoctorReport(report, "en-US");
  assert.match(text, /! Providers: No provider is configured yet/);
  assert.match(text, /Configuration file: missing · schema none \(supported 5\) · 0 backup\(s\)/);
  assert.equal(await fs.stat(path.join(home, "providers.json")).then(() => true, () => false), false, "the doctor writes nothing");
});
