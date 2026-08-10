import assert from "node:assert/strict";
import test from "node:test";
import { isTransientProviderError, safeProviderErrorMessage } from "../src/provider-failover.js";

test("provider failover only classifies retryable transport and server failures as transient", () => {
  assert.equal(isTransientProviderError(Object.assign(new Error("busy"), { status: 429 })), true);
  assert.equal(isTransientProviderError(Object.assign(new Error("unavailable"), { status: 503 })), true);
  assert.equal(isTransientProviderError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientProviderError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" })), true);
  assert.equal(isTransientProviderError(Object.assign(new Error("request failed"), { cause: Object.assign(new Error("unreachable"), { code: "EHOSTUNREACH" }) })), true);
  assert.equal(isTransientProviderError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
  assert.equal(isTransientProviderError(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(isTransientProviderError(Object.assign(new Error("cancelled"), { name: "AbortError" })), false);
});

test("provider failover receipts redact credential-shaped error details", () => {
  const message = safeProviderErrorMessage(new Error("Authorization: Bearer secret-token api_key=top-secret sk-1234567890"));
  assert.doesNotMatch(message, /secret-token|top-secret|1234567890/);
  assert.match(message, /REDACTED/);
});
