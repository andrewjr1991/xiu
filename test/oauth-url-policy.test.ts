import assert from "node:assert/strict";
import test from "node:test";
import { createSafeOAuthFetch, isForbiddenOAuthAddress, validateOAuthUrl } from "../src/oauth-url-policy.js";

test("OAuth URL policy rejects unsafe schemes, credentials, and private or metadata addresses", async () => {
  assert.equal(isForbiddenOAuthAddress("169.254.169.254"), true);
  assert.equal(isForbiddenOAuthAddress("10.1.2.3"), true);
  assert.equal(isForbiddenOAuthAddress("8.8.8.8"), false);
  await assert.rejects(validateOAuthUrl("file:///etc/passwd"), /HTTPS/i);
  await assert.rejects(validateOAuthUrl("https://user:secret@example.com"), /credentials/i);
  await assert.rejects(validateOAuthUrl("http://169.254.169.254/latest/meta-data"), /HTTPS|forbidden/i);
  await assert.rejects(validateOAuthUrl("https://internal.example.test", {
    lookup: async () => [{ address: "192.168.1.8", family: 4 }] as never,
  }), /private|reserved|forbidden/i);
  assert.equal((await validateOAuthUrl("http://127.0.0.1:53121/callback")).origin, "http://127.0.0.1:53121");
});

test("safe OAuth fetch validates every redirect and never follows POST redirects", async () => {
  const calls: string[] = [];
  const safeFetch = createSafeOAuthFetch({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }] as never,
    fetchFn: (async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
    }) as typeof fetch,
  });
  await assert.rejects(safeFetch("https://oauth.example.com/.well-known/oauth-authorization-server"), /HTTPS|forbidden/i);
  assert.equal(calls.length, 1);

  const postFetch = createSafeOAuthFetch({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }] as never,
    fetchFn: (async () => new Response(null, { status: 307, headers: { location: "https://other.example.com/token" } })) as typeof fetch,
  });
  await assert.rejects(postFetch("https://oauth.example.com/token", { method: "POST" }), /must not redirect/i);
});
