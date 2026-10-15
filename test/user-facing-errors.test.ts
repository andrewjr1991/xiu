import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { ProviderConfigurationError } from "../src/provider-config-migration.js";
import { errorCatalog, explainError, formatUserFacingError, summarizeUserFacingError } from "../src/user-facing-errors.js";

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
  assert.equal(explainError(cases[14][0], "en-US").diagnostic, "/background list");
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

test("every explanation code is documented in the usage guide", async () => {
  const usage = await fs.readFile(new URL("../USAGE.zh-CN.md", import.meta.url), "utf8");
  const catalog = errorCatalog();
  assert.ok(catalog.length >= 25);
  assert.equal(new Set(catalog.map((entry) => entry.code)).size, catalog.length, "codes are unique");
  for (const entry of catalog) assert.ok(usage.includes(`\`${entry.code}\``), `USAGE.zh-CN.md must document ${entry.code}`);
});
