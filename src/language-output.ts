import { Converter } from "opencc-js";
import type { UiLanguage } from "./i18n.js";

const toSimplified = Converter({ from: "hk", to: "cn" });

/**
 * Keep code literals byte-for-byte stable while normalizing natural-language
 * assistant output for the selected UI language.
 */
export function normalizeAssistantText(text: string, language: UiLanguage): string {
  if (language !== "zh-CN" || !text) return text;
  return text.split(/(```[\s\S]*?```|`[^`\r\n]*`)/g).map((part, index) => index % 2 ? part : toSimplified(part)).join("");
}
