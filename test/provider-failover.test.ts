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

test("provider failure redaction removes opaque active API keys", () => {
  const key = "opaque-provider-canary-without-standard-prefix";
  const message = safeProviderErrorMessage(new Error(`upstream echoed ${key}`), [key]);
  assert.doesNotMatch(message, new RegExp(key));
  assert.match(message, /REDACTED/);
});

test("provider failure messages keep a gateway's HTML error page down to its title", () => {
  const html = `502 <!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>502 Bad Gateway</title>\n</head><body>\n<center><h1>502 Bad Gateway</h1></center>\n<hr><center>nginx</center>\n</body></html>`;
  const message = safeProviderErrorMessage(Object.assign(new Error(html), { status: 502 }));
  assert.equal(message, "502 Bad Gateway (HTML error page from the gateway; body omitted)");
  assert.doesNotMatch(message, /<|nginx/);
  assert.equal(safeProviderErrorMessage(new Error("<html><body>busy</body></html>")), "HTML error page (HTML error page from the gateway; body omitted)");
  assert.equal(safeProviderErrorMessage(new Error("plain failure")), "plain failure");
});
