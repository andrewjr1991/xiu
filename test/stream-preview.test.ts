import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DRAFT_INPUT_CHARS, MAX_DRAFT_PREVIEW_CHARS, SafeDraftPreview } from "../src/stream-preview.js";

function previews(text: string, secrets: string[] = [], width = 1): string[] {
  const preview = new SafeDraftPreview("en-US", secrets);
  const results: string[] = [];
  for (let offset = 0; offset < text.length; offset += width) {
    const result = preview.push(text.slice(offset, offset + width));
    if (result !== undefined) results.push(result);
  }
  preview.finish();
  return results;
}

test("drafts expose only complete lines and report received characters", () => {
  const preview = new SafeDraftPreview("zh-CN");
  assert.equal(preview.push("設計已"), undefined);
  assert.equal(preview.receivedChars, 3);
  assert.equal(preview.push("完成。\n正在驗"), "设计已完成。\n");
  assert.equal(preview.push("證。\n"), "设计已完成。\n正在验证。\n");
  preview.finish();
  assert.equal(preview.push("ignored\n"), undefined);
});

test("Bearer, sk tokens, and known credentials never leak at any chunk boundary", () => {
  const known = "unique-secret-with-漢字-54321";
  const text = `safe first line\nAuthorization: Bearer abcdef12345_token\nkey sk-partialtoken123456\n${known}\nvisible again\n`;
  for (let width = 1; width <= 13; width++) {
    const results = previews(text, [known], width);
    assert.ok(results.length);
    for (const result of results) {
      assert.doesNotMatch(result, /abcdef|partialtoken|unique-secret|漢字/);
    }
    assert.match(results.at(-1)!, /REDACTED/);
    assert.match(results.at(-1)!, /visible again/);
  }
});

test("credential labels whose values follow on the next line stay redacted", () => {
  const results = previews("Authorization: Bearer\nlong-bearer-canary\napi_key=\nassignment-canary\n");
  for (const result of results) assert.doesNotMatch(result, /long-bearer-canary|assignment-canary/);
});

test("known multiline credentials hold back their unfinished prefix", () => {
  const secret = "credential-prefix\ncredential-suffix";
  const results = previews(`safe\n${secret}\nend\n`, [secret]);
  assert.ok(results.length);
  for (const result of results) assert.doesNotMatch(result, /credential-prefix|credential-suffix/);
  assert.match(results.at(-1)!, /safe\n\[REDACTED\]\nend/);
});

test("private key bodies never escape while PEM blocks remain unclosed", () => {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
    const text = `safe\n-----BEGIN ${label}-----\nprivate-body-canary\nanother-key-line\n-----END ${label}-----\nafter\n`;
    const results = previews(text);
    for (const result of results) assert.doesNotMatch(result, /private-body-canary|another-key-line|BEGIN|END/);
    assert.match(results.at(-1)!, /REDACTED-PRIVATE-KEY/);
    assert.match(results.at(-1)!, /after/);
  }
  const preview = new SafeDraftPreview("en-US");
  assert.equal(preview.push("-----BEGIN PRIVATE KEY-----\n"), "[REDACTED-PRIVATE-KEY]\n");
  assert.equal(preview.push("never-show-unclosed-body\n"), undefined);
  preview.finish();
});

test("Chinese prose is normalized without changing fenced or inline code", () => {
  const preview = new SafeDraftPreview("zh-CN");
  const first = preview.push("設計說明\n```ts\nconst label = '繁體變數';\n");
  assert.equal(first, "设计说明\n```ts\nconst label = '繁體變數';\n");
  assert.equal(preview.push("```\n執行 `git 狀態` 繼續。\n"), "设计说明\n```ts\nconst label = '繁體變數';\n```\n执行 `git 狀態` 继续。\n");
});

test("tilde fences, nested short fences and multiline backtick spans retain code", () => {
  const preview = new SafeDraftPreview("zh-CN");
  const text = "說明\n~~~~\n繁體程式\n~~~\n依然繁體\n~~~~\n執行 ``繁體 ` 狀態\n繼續`` 結束\n";
  assert.equal(preview.push(text), "说明\n~~~~\n繁體程式\n~~~\n依然繁體\n~~~~\n执行 ``繁體 ` 狀態\n繼續`` 结束\n");
});

test("secrets are removed even inside code and before Chinese conversion", () => {
  const preview = new SafeDraftPreview("zh-CN", ["繁體秘密金鑰"]);
  const result = preview.push("說明 繁體秘密金鑰\n```\n繁體秘密金鑰\n```\n");
  assert.equal(result, "说明 [REDACTED]\n```\n[REDACTED]\n```\n");
});

test("preview window is bounded after redaction and retains only whole lines", () => {
  const preview = new SafeDraftPreview("en-US", ["window-canary"]);
  const text = "old line\n" + "visible text\n".repeat(500) + "window-canary\nlast line\n";
  const result = preview.push(text)!;
  assert.ok(result.length <= MAX_DRAFT_PREVIEW_CHARS);
  assert.ok(result.startsWith("visible text\n"));
  assert.ok(result.endsWith("[REDACTED]\nlast line\n"));
  assert.doesNotMatch(result, /window-canary|old line/);
});

test("input hard limit disables previews instead of dropping a secret prefix", () => {
  const preview = new SafeDraftPreview("en-US");
  assert.equal(preview.push("safe\n"), "safe\n");
  assert.equal(preview.push("x".repeat(MAX_DRAFT_INPUT_CHARS)), "");
  assert.equal(preview.disabled, true);
  assert.equal(preview.push("sk-cross-limit-secret\n"), undefined);
  assert.ok(preview.receivedChars > MAX_DRAFT_INPUT_CHARS);
  preview.reset();
  assert.equal(preview.disabled, false);
  assert.equal(preview.receivedChars, 0);
  assert.equal(preview.push("new draft\n"), "new draft\n");
});

test("redaction removing the final newline cannot bypass the preview size limit", () => {
  const preview = new SafeDraftPreview("en-US", ["known-secret\n"]);
  assert.equal(preview.push("earlier preview\n"), "earlier preview\n");
  assert.equal(preview.push("x".repeat(MAX_DRAFT_PREVIEW_CHARS + 100) + "known-secret\n"), "");
  assert.equal(preview.push("next complete line\n"), undefined);
  assert.equal(preview.push("visible again\n"), "visible again\n");
});

test("a giant single line is never emitted partially and finish discards its tail", () => {
  const preview = new SafeDraftPreview("en-US");
  assert.equal(preview.push("x".repeat(MAX_DRAFT_PREVIEW_CHARS + 100)), undefined);
  assert.equal(preview.push("\n"), undefined);
  assert.equal(preview.push("unfinished secret prefix sk-"), undefined);
  preview.finish();
  assert.equal(preview.push("secret-suffix\n"), undefined);
});
