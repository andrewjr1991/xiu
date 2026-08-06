export type UiLanguage = "zh-CN" | "en-US";

export function normalizeLanguage(value?: string): UiLanguage | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (["zh", "zh-cn", "zh-hans", "chinese", "中文"].includes(normalized)) return "zh-CN";
  if (["en", "en-us", "english", "英文"].includes(normalized)) return "en-US";
  throw new Error(`Unsupported language: ${value}. Use zh-CN or en-US.`);
}

export function defaultLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale): UiLanguage {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function localize(language: UiLanguage, chinese: string, english: string): string {
  return language === "zh-CN" ? chinese : english;
}

export function languageName(language: UiLanguage, target: UiLanguage = language): string {
  return localize(target, language === "zh-CN" ? "简体中文" : "英文", language === "zh-CN" ? "Simplified Chinese" : "English");
}
