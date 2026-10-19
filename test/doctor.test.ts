import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDoctorReport, describeProxyValue, formatDoctorReport, probeWorkspaceRecords, type DoctorProviderRegistry, type WorkspaceRecordsProbe } from "../src/doctor.js";
import { TASK_RUN_SCHEMA_VERSION, TaskRunJournal, type TaskRunRecord } from "../src/task-run.js";
import { ProviderConfigurationError } from "../src/provider-config-migration.js";
import type { ProviderProfile } from "../src/provider-registry.js";
import type { UpdateDoctorResult } from "../src/update-check.js";

const FEATURES = { text: true as const, tools: true, vision: false, image: false, video: false };

/** A trusted workspace with nothing saved yet, for the tests that are about other sections. */
const NO_RECORDS = async (): Promise<WorkspaceRecordsProbe> => ({ trusted: true, runs: 0, unreadableRuns: [], sessions: 0, unreadableSessions: [] });

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
    version: "0.21.0", workspaceRecords: NO_RECORDS,
    settings: { webSearch: { enabled: true, provider: "free-search", baseURL: "https://search.example", managedAuth: "xiu-device", authBaseURL: "https://search.example/xiu-auth", proxy: "http://corp:Secret%40Pass@proxy.corp.example:8080" } },
    registry: fakeRegistry(profiles),
    env: { HTTPS_PROXY: "http://proxy.corp.example:8080", OPENAI_API_KEY: "sk-env-canary-5678", PATH: "" },
    platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1", cwd: "/work/project", homeDirectory: "/home/user",
    now: new Date("2026-10-15T12:00:00.000Z"),
    updateDoctor: async () => updateResult(),
    uvAvailable: async () => "/home/user/.xiu/uv/uvx",
  });
  assert.equal(report.status, "pass");
  assert.deepEqual(report.sections.map((section) => section.id), ["installation", "providers", "web-search", "proxy", "workspace", "system"]);
  const zh = formatDoctorReport(report, "zh-CN");
  assert.match(zh, /\[工作区记录\]\n✓ 运行记录: 0 条，全部可读\n✓ 会话日志: 0 个，全部可读\n✓ 中断任务: 没有待处理的中断任务/);
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
    version: "0.21.0", workspaceRecords: NO_RECORDS,
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
    version: "0.21.0", workspaceRecords: NO_RECORDS,
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
    version: "0.21.0", workspaceRecords: NO_RECORDS,
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
    version: "0.21.0", workspaceRecords: NO_RECORDS, settings: {}, registry: new ProviderRegistry(path.join(home, "providers.json")),
    env: { PATH: "" }, platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1", cwd: home, homeDirectory: home,
    updateDoctor: async () => updateResult(), uvAvailable: async () => undefined,
  });
  const text = formatDoctorReport(report, "en-US");
  assert.match(text, /! Providers: No provider is configured yet/);
  assert.match(text, /Configuration file: missing · schema none \(supported 5\) · 0 backup\(s\)/);
  assert.equal(await fs.stat(path.join(home, "providers.json")).then(() => true, () => false), false, "the doctor writes nothing");
});

async function workspaceFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-doctor-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(path.join(cwd, ".xiu", "sessions"), { recursive: true });
  const taskRunRoot = path.join(root, "task-runs");
  const journal = new TaskRunJournal(cwd, taskRunRoot);
  const directory = path.join(taskRunRoot, journal.workspaceId);
  await fs.mkdir(directory, { recursive: true });
  const record = (runId: string, status: TaskRunRecord["status"]): TaskRunRecord => ({
    version: TASK_RUN_SCHEMA_VERSION, runId, workspaceId: journal.workspaceId, sessionId: "session-1", taskPreview: "task", providerId: "p", model: "m", status,
    startedAt: "2026-10-19T01:00:00.000Z", updatedAt: "2026-10-19T01:00:10.000Z", ...(status === "running" ? { ownerStartedAt: "2000-01-01T00:00:00.000Z" } : { finishedAt: "2026-10-19T01:00:10.000Z" }),
    ownerPid: 1, ownerInstance: "instance", operations: [], recoveryPoints: [], events: [],
  });
  return { cwd, taskRunRoot, directory, record };
}

test("the workspace section counts records, names unreadable ones and warns about an interrupted task", async (t) => {
  const f = await workspaceFixture(t);
  await fs.writeFile(path.join(f.directory, "3f2a9c1e-0000-4000-8000-000000000001.json"), JSON.stringify(f.record("3f2a9c1e-0000-4000-8000-000000000001", "completed")));
  await fs.writeFile(path.join(f.directory, "bad-version.json"), JSON.stringify({ version: 99, runId: "bad-version" }));
  await fs.writeFile(path.join(f.cwd, ".xiu", "sessions", "session-1.jsonl"), `${JSON.stringify({ type: "task", task: "task", timestamp: "2026-10-19T01:00:00.000Z" })}\n`);
  await fs.mkdir(path.join(f.cwd, ".xiu", "sessions", "broken.jsonl"));

  const probe = await probeWorkspaceRecords(f.cwd, { trusted: async () => true, taskRunRoot: f.taskRunRoot });
  assert.deepEqual(probe, {
    trusted: true, runs: 1, unreadableRuns: [{ runId: "bad-version", reason: "corrupt" }],
    sessions: 1, unreadableSessions: [{ id: "broken", reason: "EISDIR" }],
    interruptedCheckFailure: "Unsupported or corrupt task-run journal",
  }, "a corrupt record also blocks the strict interrupted-task check, which the report must say");
  assert.doesNotMatch(JSON.stringify(probe), new RegExp(f.cwd.replace(/[\\/]/g, "[\\\\/]")), "no path in the probe");

  const report = await collectDoctorReport({
    version: "0.21.0", settings: {}, registry: fakeRegistry([]), env: { PATH: "" }, platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1",
    cwd: f.cwd, homeDirectory: "/home/user", updateDoctor: async () => updateResult(), uvAvailable: async () => undefined, workspaceRecords: async () => probe,
  });
  assert.equal(report.status, "failure");
  const zh = formatDoctorReport(report, "zh-CN");
  assert.match(zh, /! 运行记录: 1 条可读，另有 1 条无法读取（corrupt ×1）\n {2}无法读取的记录不会出现在 \/report runs/);
  assert.match(zh, /! 会话日志: 1 个可读，另有 1 个无法读取（EISDIR ×1）/);
  assert.match(zh, /✗ 中断任务: 中断任务检查无法完成（Unsupported or corrupt task-run journal）\n {2}新的一次性运行（xiu <任务>、xiu --json）会返回 not_started/);
  const en = formatDoctorReport(report, "en-US");
  assert.match(en, /! Run records: 1 readable, 1 more could not be read \(corrupt ×1\)/);
  assert.match(en, /✗ Interrupted task: The interrupted-task check could not complete \(Unsupported or corrupt task-run journal\)/);

  await fs.rm(path.join(f.directory, "bad-version.json"));
  await fs.writeFile(path.join(f.directory, "7b00c0de-0000-4000-8000-000000000002.json"), JSON.stringify(f.record("7b00c0de-0000-4000-8000-000000000002", "running")));
  const interrupted = await probeWorkspaceRecords(f.cwd, { trusted: async () => true, taskRunRoot: f.taskRunRoot });
  assert.deepEqual(interrupted.unreadableRuns, []);
  assert.deepEqual(interrupted.interrupted, { runId: "7b00c0de-0000-4000-8000-000000000002", status: "running", startedAt: "2026-10-19T01:00:00.000Z" });
  const warned = formatDoctorReport(await collectDoctorReport({
    version: "0.21.0", settings: {}, registry: fakeRegistry([]), env: { PATH: "" }, platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1",
    cwd: f.cwd, homeDirectory: "/home/user", updateDoctor: async () => updateResult(), uvAvailable: async () => undefined, workspaceRecords: async () => interrupted,
  }), "zh-CN");
  assert.match(warned, /结论: 可用，但有需要留意的警告/);
  assert.match(warned, /! 中断任务: 有一条待处理的中断任务：7b00c0de（running，2026-10-19T01:00:00）\n {2}新的一次性运行会返回 not_started 直到处理它：.*xiu recover abandon 7b00c0de/);
});

test("an untrusted workspace's records are not read and the section says so", async (t) => {
  const f = await workspaceFixture(t);
  await fs.mkdir(path.join(f.cwd, ".xiu", "sessions", "broken.jsonl"));
  const probe = await probeWorkspaceRecords(f.cwd, { trusted: async () => false, taskRunRoot: f.taskRunRoot });
  assert.deepEqual(probe, { trusted: false, runs: 0, unreadableRuns: [], sessions: 0, unreadableSessions: [] });
  const report = await collectDoctorReport({
    version: "0.21.0", settings: {}, registry: fakeRegistry([]), env: { PATH: "" }, platform: "linux", arch: "x64", nodeVersion: "22.12.0", osRelease: "6.1",
    cwd: f.cwd, homeDirectory: "/home/user", updateDoctor: async () => updateResult(), uvAvailable: async () => undefined, workspaceRecords: async () => probe,
  });
  const section = report.sections.find((candidate) => candidate.id === "workspace");
  assert.deepEqual(section?.items.map((entry) => [entry.id, entry.level]), [["workspace-trust", "info"]], "an untrusted workspace is information, not a warning");
  assert.match(formatDoctorReport(report, "en-US"), /\[Workspace records\]\n· Trust: This workspace is not trusted yet, so its task records and session logs were not read\n {2}Run xiu interactively once/);
});
