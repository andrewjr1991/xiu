import assert from "node:assert/strict";
import test from "node:test";
import { defaultLanguage, languageName, normalizeLanguage } from "../src/i18n.js";
import { resolveConfig } from "../src/config.js";

test("language aliases normalize to supported UI languages", () => {
  assert.equal(normalizeLanguage("中文"), "zh-CN");
  assert.equal(normalizeLanguage("zh_Hans"), "zh-CN");
  assert.equal(normalizeLanguage("English"), "en-US");
  assert.throws(() => normalizeLanguage("fr-FR"), /Unsupported language/);
});

test("language follows explicit configuration and locale fallback", () => {
  assert.equal(resolveConfig({ language: "zh-CN" }).language, "zh-CN");
  assert.equal(resolveConfig({ language: "en" }).language, "en-US");
  assert.equal(defaultLanguage("zh-CN"), "zh-CN");
  assert.equal(defaultLanguage("en-GB"), "en-US");
  assert.equal(languageName("zh-CN", "zh-CN"), "简体中文");
});
