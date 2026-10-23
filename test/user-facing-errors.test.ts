import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { ConfigFileError } from "../src/config-file-error.js";
import { ProviderConfigurationError } from "../src/provider-config-migration.js";
import { describeFailure, errorCatalog, explainError, formatUserFacingError, summarizeUserFacingError } from "../src/user-facing-errors.js";
import { UsageError } from "../src/usage-error.js";

test("provider configuration errors become a cause, a next step and the diagnostics command", () => {
  const unsafe = new ProviderConfigurationError("unsafe", "Provider configuration storage is not a protected regular file/directory. stage: verify-owner");
  const zh = explainError(unsafe, "zh-CN");
  assert.equal(zh.code, "provider-config/unsafe");
  assert.match(zh.cause, /渠道配置文件/);
  assert.match(zh.nextStep, /关闭其他 Xiu 窗口/);
  assert.equal(zh.diagnostic, "xiu --provider-config-diagnostics");
  assert.match(zh.detail ?? "", /verify-owner/);
  const text = formatUserFacingError("添加 Provider 失败", unsafe, "zh-CN");
  assert.deepEqual(text.split("\n").map((line) => line.split("：")[0]), ["添加 Provider 失败", "下一步", "诊断", "详情"]);
  assert.match(text, /详情：provider-config\/unsafe · /);
  const en = formatUserFacingError("Could not add provider", new ProviderConfigurationError("reload", "x"), "en-US");
  assert.match(en, /^Could not add provider: The previous provider settings write failed/);
  assert.match(en, /\nNext step: Reopen the provider settings \(\/providers in the CLI\)/);
  assert.equal(explainError(new ProviderConfigurationError("never-seen", "x"), "en-US").code, "provider-config/io", "unknown codes fall back to the I/O explanation");
});

test("HTTP and network failures are classified from status codes and error codes", () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error("401 Incorrect API key provided"), { status: 401 }), "http/401"],
    [Object.assign(new Error("Forbidden"), { status: 403 }), "http/403"],
    [Object.assign(new Error("404 model not found"), { status: 404 }), "http/404"],
    [Object.assign(new Error("Unsupported parameter"), { status: 400 }), "http/400"],
    [Object.assign(new Error("Rate limit reached"), { status: 429 }), "http/429"],
    [Object.assign(new Error("Bad gateway"), { status: 502 }), "http/5xx"],
    [Object.assign(new Error("Proxy Authentication Required"), { status: 407 }), "network/proxy-auth"],
    [new Error("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.invalid"), { code: "ENOTFOUND" }) }), "network/dns"],
    [new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) }), "network/refused"],
    [new Error("fetch failed", { cause: Object.assign(new Error("self signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) }), "network/tls"],
    [new Error("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }), "network/unreachable"],
    [new Error("XIU_CA_CERT_INVALID: /etc/ssl/gateway.pem contains no PEM certificate block"), "network/ca-file"],
    [Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }), "network/timeout"],
    [new Error("OPENAI_API_KEY is not set"), "credential/missing"],
    [new Error("XIU_NODE_NOT_FOUND: Background commands require a local Node.js runtime."), "background/node-missing"],
    [new Error("XIU_BACKGROUND_STOP_UNCONFIRMED: Process cleanup timed out; the background task remains active or unknown."), "background/stop-unconfirmed"],
    [Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), "cancelled"],
  ];
  for (const [error, code] of cases) {
    assert.equal(explainError(error, "zh-CN").code, code, (error as Error).message);
    assert.equal(explainError(error, "en-US").code, code);
  }
  const refused = explainError(cases[8][0], "zh-CN");
  assert.match(refused.nextStep, /Ollama、LM Studio 或 vLLM/);
  assert.equal(explainError(cases[15][0], "en-US").diagnostic, "/background list");
});

test("a damaged configuration file is explained by its kind, points at xiu doctor and keeps the owner's message as the detail", () => {
  const cases: Array<[ConfigFileError, string, RegExp, RegExp]> = [
    [new ConfigFileError("settings", "/home/u/.xiu/settings.json", "Could not read Xiu settings file /home/u/.xiu/settings.json: Unexpected token. Fix its JSON or move the file away; it holds the language and web-search settings."), "config/settings", /设置文件（~\/\.xiu\/settings\.json）/, /^Xiu's settings file \(~\/\.xiu\/settings\.json\) cannot be read/],
    [new ConfigFileError("trust-store", "/home/u/.xiu/trusted-workspaces.json", "Unable to read Xiu trust store at /home/u/.xiu/trusted-workspaces.json: invalid trust store structure", { code: undefined, cause: new Error("invalid trust store structure") }), "config/trust-store", /信任名单（~\/\.xiu\/trusted-workspaces\.json）无法读取/, /^The trust list .* cannot be read, so Xiu cannot tell whether any workspace is trusted/],
    [new ConfigFileError("extension-permissions", "/home/u/.xiu/extension-permissions.json", "Unable to read the extension permission store at /home/u/.xiu/extension-permissions.json: EISDIR: illegal operation on a directory, read", { code: "EISDIR" }), "config/extension-permissions", /扩展授权记录.*无法读取，插件、Skill 与 MCP/, /no plugin, skill or MCP server can be confirmed as approved/],
    [new ConfigFileError("mcp", "/repo/.xiu/mcp.json", "MCP server docs requires exactly one of command or url"), "config/mcp", /MCP 配置文件无法读取，或其中某个服务条目无效/, /^An MCP configuration file cannot be read or one of its server entries is invalid/],
  ];
  for (const [error, code, zh, en] of cases) {
    const explanation = explainError(error, "zh-CN");
    assert.equal(explanation.code, code);
    assert.match(explanation.cause, zh);
    assert.equal(explanation.diagnostic, "xiu doctor");
    assert.equal(explanation.detail, error.message, "the owner's message, path included, is the detail");
    assert.match(explainError(error, "en-US").cause, en);
    assert.equal(explainError(new Error("startup failed", { cause: error }), "en-US").code, code, "a wrapped configuration error is still recognised");
  }
  assert.equal(cases[2][0].code, "EISDIR", "the system error code is kept for callers that classify by errno");
  assert.equal(cases[1][0].code, undefined);
  const text = formatUserFacingError("Xiu could not start", cases[1][0], "en-US");
  assert.deepEqual(text.split("\n").map((line) => line.split(": ")[0]), ["Xiu could not start", "Next step", "Diagnose", "Detail"]);
  assert.match(text, /\nDiagnose: xiu doctor\nDetail: config\/trust-store · Unable to read Xiu trust store at \/home\/u\/\.xiu\/trusted-workspaces\.json: invalid trust store structure$/);
  assert.match(formatUserFacingError("Xiu 无法启动", cases[0][0], "zh-CN"), /^Xiu 无法启动：Xiu 的设置文件.*\n下一步：修好它的 JSON.*\n诊断：xiu doctor\n详情：config\/settings · Could not read Xiu settings file/);
});

test("unknown errors keep their redacted message as the cause and never leak secrets", () => {
  const secret = "sk-live-canary-9f8e7d6c";
  const error = new Error(`Something odd happened with key ${secret}`);
  const explanation = explainError(error, "en-US", { sensitive: [secret], diagnostic: "/diagnostics" });
  assert.equal(explanation.code, "unknown");
  assert.doesNotMatch(explanation.cause, new RegExp(secret));
  assert.match(explanation.cause, /Something odd happened/);
  assert.equal(explanation.detail, undefined, "the cause already is the message");
  assert.equal(explanation.diagnostic, "/diagnostics");
  const text = formatUserFacingError("Error", error, "en-US", { sensitive: [secret] });
  assert.equal(text.split("\n").length, 2);
  assert.doesNotMatch(text, new RegExp(secret));
  const authenticated = Object.assign(new Error(`401 Incorrect API key provided: ${secret}`), { status: 401 });
  assert.doesNotMatch(formatUserFacingError("x", authenticated, "zh-CN", { sensitive: [secret] }), new RegExp(secret));
  assert.match(summarizeUserFacingError(authenticated, "zh-CN"), /^服务拒绝了这个 API Key.*重新保存 Key（CLI 为 \/provider key）。$/);
});

test("describeFailure explains a catalogued failure and keeps one redacted line for anything else", () => {
  const damaged = new ConfigFileError("extension-permissions", "/home/u/.xiu/extension-permissions.json", "Unable to read the extension permission store at /home/u/.xiu/extension-permissions.json: EISDIR: illegal operation on a directory, read", { code: "EISDIR" });
  assert.match(describeFailure("MCP permission operation failed", damaged, "en-US"), /^MCP permission operation failed: The extension permission record \(~\/\.xiu\/extension-permissions\.json\) cannot be read.*\nNext step: Fix its JSON or move the file away.*\nDiagnose: xiu doctor\nDetail: config\/extension-permissions · Unable to read the extension permission store at /);
  assert.match(describeFailure("MCP 登录失败", Object.assign(new Error("Forbidden"), { status: 403 }), "zh-CN"), /^MCP 登录失败：服务拒绝访问.*\n下一步：.*\n详情：http\/403 · Forbidden$/);
  const secret = "sk-live-canary-9f8e7d6c";
  const long = `Plugin not found: nope (${"x".repeat(400)}) key ${secret}`;
  const plain = describeFailure("Could not change plugin state", new Error(long), "en-US", { sensitive: [secret] });
  assert.equal(plain.split("\n").length, 1, "an unexplained failure stays one line, without a generic next step");
  assert.match(plain, /^Could not change plugin state: Plugin not found: nope \(x{400}\) key /, "the message is not truncated");
  assert.doesNotMatch(plain, new RegExp(secret));
  assert.equal(describeFailure("错误", new Error("boom"), "zh-CN"), "错误：boom");
});

test("a usage error is never classified by its words: an option named timeout is not a network timeout", () => {
  const error = new UsageError("stall-timeout-seconds must be a positive integer when provided");
  assert.equal(explainError(new Error("plain " + error.message), "en-US").code, "network/timeout", "the same words in an ordinary error still read as a timeout");
  const explanation = explainError(error, "en-US");
  assert.equal(explanation.code, "unknown");
  assert.equal(explanation.cause, error.message);
  assert.equal(explainError(new Error("startup failed", { cause: error }), "en-US").code, "unknown", "wrapped, too");
  assert.equal(describeFailure("Error", error, "en-US", { diagnostic: "xiu doctor" }), `Error: ${error.message}`, "one line, no generic next step");
  assert.equal(describeFailure("Error", new UsageError("Unsupported language: xx. Use zh-CN or en-US."), "zh-CN"), "Error：Unsupported language: xx. Use zh-CN or en-US.");
});

test("every explanation code is documented in the usage guide", async () => {
  const usage = await fs.readFile(new URL("../docs/guide/troubleshooting.zh-CN.md", import.meta.url), "utf8");
  const catalog = errorCatalog();
  assert.ok(catalog.length >= 29);
  assert.equal(new Set(catalog.map((entry) => entry.code)).size, catalog.length, "codes are unique");
  for (const entry of catalog) assert.ok(usage.includes(`\`${entry.code}\``), `docs/guide/troubleshooting.zh-CN.md must document ${entry.code}`);
});
