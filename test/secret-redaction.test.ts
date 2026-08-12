import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets, sanitizeSecrets } from "../src/secret-redaction.js";

test("shared secret redaction covers provider, bearer, OAuth JSON, and URL forms", () => {
  const secret = "canary-provider-secret";
  const githubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  const slackToken = ["xoxb", "1234567890", "abcdefghijklmnopqrstuvwxyz"].join("-");
  const awsKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const output = redactSecrets([
    `api_key=${secret}`,
    "Authorization: Bearer bearer-token-value",
    '\"refresh_token\":\"refresh-value\"',
    "https://example.test/callback?code=authorization-code&client_secret=client-value",
    "sk-example12345678",
    githubToken,
    slackToken,
    awsKey,
    "-----BEGIN PRIVATE KEY-----\nprivate-key-canary\n-----END PRIVATE KEY-----",
  ].join("\n"), [secret]);
  for (const leaked of [secret, "bearer-token-value", "refresh-value", "authorization-code", "client-value", "example12345678", githubToken, slackToken, awsKey, "private-key-canary"]) {
    assert.doesNotMatch(output, new RegExp(leaked));
  }
  assert.match(output, /\[REDACTED\]/);
});

test("structured secret sanitization redacts credential fields and known values before persistence", () => {
  const result = sanitizeSecrets({
    message: "request failed with canary-value",
    nested: { client_secret: "client-value", safe: "visible" },
    toolCalls: [{ input: { Authorization: "Bearer hidden-value" } }],
  }, ["canary-value"]);
  assert.deepEqual(result, {
    message: "request failed with [REDACTED]",
    nested: { client_secret: "[REDACTED]", safe: "visible" },
    toolCalls: [{ input: { Authorization: "[REDACTED]" } }],
  });
});

test("structured sanitization preserves token metrics while redacting actual token values", () => {
  const result = sanitizeSecrets({
    inputTokens: 120, output_tokens: 30, totalTokens: 150, beforeTokens: 200,
    accessToken: "access-value", refresh_token: "refresh-value", token: "opaque-value", token_type: "Bearer",
  });
  assert.deepEqual(result, {
    inputTokens: 120, output_tokens: 30, totalTokens: 150, beforeTokens: 200,
    accessToken: "[REDACTED]", refresh_token: "[REDACTED]", token: "[REDACTED]", token_type: "Bearer",
  });
});
