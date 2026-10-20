import assert from "node:assert/strict";
import test from "node:test";
import { contextLimitModeLabel, contextWindowSourceLabel, formatCredentialBackendStatus, projectCheckReason, runOutcomeLabel } from "../src/status-labels.js";

test("/credentials does not repeat the storage description as the reason", () => {
  // Before: "Provider env: environment · available · 1 item(s) · process environment · process environment".
  assert.equal(formatCredentialBackendStatus("Provider env", { backend: "environment", available: true, secure: false, entries: 1, reason: "process environment" }, "en-US"),
    "Provider env: environment · available · 1 item(s) · process environment");
  assert.equal(formatCredentialBackendStatus("MCP OAuth", { backend: "legacy-file", available: true, secure: false, entries: 0, reason: "local plaintext compatibility storage" }, "zh-CN"),
    "MCP OAuth: legacy-file · 可用 · 0 项 · 本机明文兼容存储");
  // A reason that says something the storage column does not is kept.
  assert.equal(formatCredentialBackendStatus("System", { backend: "system", available: false, secure: true, entries: 0, reason: "No system credential backend is available on freebsd" }, "en-US"),
    "System: system · unavailable · 0 item(s) · system secure storage · No system credential backend is available on freebsd");
  assert.equal(formatCredentialBackendStatus("MCP OAuth", { backend: "system", available: true, secure: true, entries: 2, reason: "explicitly migrated OAuth references" }, "zh-CN"),
    "MCP OAuth: system · 可用 · 2 项 · 系统安全存储 · explicitly migrated OAuth references");
  assert.equal(formatCredentialBackendStatus("Provider", { backend: "legacy-file", available: true, secure: false, entries: 1 }, "en-US"),
    "Provider: legacy-file · available · 1 item(s) · local plaintext compatibility storage");
});

test("/check says why a check is unavailable in the user's language", () => {
  assert.equal(projectCheckReason({ name: "typecheck", reason: "No package.json in the workspace root.", reasonCode: "no-package" }, "zh-CN"), "工作区根目录没有 package.json。");
  assert.equal(projectCheckReason({ name: "typecheck", reason: "No package.json in the workspace root.", reasonCode: "no-package" }, "en-US"), "No package.json in the workspace root.");
  assert.equal(projectCheckReason({ name: "lint", reason: "No lint script in package.json.", reasonCode: "no-script" }, "zh-CN"), "package.json 中没有 lint 脚本。");
  assert.equal(projectCheckReason({ name: "test", reason: "The test script must be a non-empty string.", reasonCode: "empty-script" }, "zh-CN"), "test 脚本必须是非空字符串。");
  assert.equal(projectCheckReason({ name: "build", reason: "The prebuild script must be a string.", reasonCode: "not-string", reasonDetail: "pre" }, "zh-CN"), "prebuild 脚本必须是字符串。");
  assert.equal(projectCheckReason({ name: "build", reason: "The prebuild script must be a string.", reasonCode: "not-string", reasonDetail: "pre" }, "en-US"), "The prebuild script must be a string.");
  assert.equal(projectCheckReason({ name: "typecheck", reason: "Discovery cancelled.", reasonCode: "cancelled" }, "zh-CN"), "发现已取消。");
  // A free-text discovery error (for example a package.json that cannot be parsed) is shown as it is.
  assert.equal(projectCheckReason({ name: "typecheck", reason: "Cannot read package.json: Unexpected token" }, "zh-CN"), "Cannot read package.json: Unexpected token");
  assert.equal(projectCheckReason({ name: "typecheck" }, "zh-CN"), "不可用");
});

test("/status shows its outcome, compact mode and window source in the user's language", () => {
  assert.equal(runOutcomeLabel("idle", "zh-CN"), "空闲");
  assert.equal(runOutcomeLabel("waiting_user", "zh-CN"), "等待用户");
  assert.equal(runOutcomeLabel("waiting_user", "en-US"), "waiting for user");
  assert.equal(runOutcomeLabel("completed", "en-US"), "completed");
  assert.equal(contextLimitModeLabel("automatic", "zh-CN"), "自动");
  assert.equal(contextLimitModeLabel("configured", "en-US"), "configured");
  assert.equal(contextWindowSourceLabel("fallback", "zh-CN"), "默认值");
  assert.equal(contextWindowSourceLabel("official", "en-US"), "official");
  assert.equal(contextWindowSourceLabel("api", "zh-CN"), "API 返回");
  assert.equal(contextWindowSourceLabel("something-new", "zh-CN"), "something-new");
});
