import type { UiLanguage } from "./i18n.js";
import { normalizeAssistantText } from "./language-output.js";
import { redactSecrets } from "./secret-redaction.js";

export const MAX_DRAFT_INPUT_CHARS = 65_536;
export const MAX_DRAFT_PREVIEW_CHARS = 4_096;

/** Return only whole lines which do not end inside a known multi-line secret. */
function completeSafeLines(text: string, secrets: readonly string[]): string {
  let end = text.lastIndexOf("\n") + 1;
  if (!end) return "";
  for (const secret of secrets) {
    // Ordinary one-line credentials cannot cross our complete-line boundary.
    if (!secret.includes("\n")) continue;
    const start = Math.max(0, end - secret.length + 1);
    for (let index = text.indexOf(secret[0]!, start); index >= 0 && index < end; index = text.indexOf(secret[0]!, index + 1)) {
      const suffix = text.slice(index, end);
      if (suffix.length < secret.length && secret.startsWith(suffix)) {
        end = text.lastIndexOf("\n", index - 1) + 1;
        break;
      }
    }
  }
  return text.slice(0, end);
}

function redactDraft(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  // The shared redactor handles complete PEMs; previews must also hide an open
  // block, including encrypted/legacy key labels, before its final line arrives.
  result = result.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED-PRIVATE-KEY]\n");
  return redactSecrets(result).replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]");
}

/** Preserve open fences and code spans as well as complete Markdown code. */
function normalizeDraft(text: string, language: UiLanguage): string {
  if (language !== "zh-CN") return text;
  let fence: { marker: string; width: number } | undefined;
  let inlineWidth = 0;
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.width && !marker[2]!.trim()) fence = undefined;
      return line;
    }
    if (!inlineWidth && marker) {
      fence = { marker: marker[1]![0]!, width: marker[1]!.length };
      return line;
    }
    let result = "";
    let cursor = 0;
    for (const match of line.matchAll(/`+/g)) {
      const index = match.index!;
      let escaped = 0;
      for (let previous = index - 1; previous >= 0 && line[previous] === "\\"; previous--) escaped++;
      if (!inlineWidth && escaped % 2) continue;
      const preceding = line.slice(cursor, index);
      result += inlineWidth ? preceding : normalizeAssistantText(preceding, language);
      result += match[0];
      if (!inlineWidth) inlineWidth = match[0].length;
      else if (inlineWidth === match[0].length) inlineWidth = 0;
      cursor = index + match[0].length;
    }
    const remaining = line.slice(cursor);
    return result + (inlineWidth ? remaining : normalizeAssistantText(remaining, language));
  }).join("");
}

/** Ephemeral, replaceable draft only. It is never a completed answer or a log. */
export class SafeDraftPreview {
  private source = "";
  private previous = "";
  private received = 0;
  private closed = false;
  private overLimit = false;
  private readonly secrets: string[];

  constructor(private readonly language: UiLanguage, sensitiveValues: readonly string[] = []) {
    this.secrets = [...new Set(sensitiveValues.filter((value) => value.length > 0))].sort((left, right) => right.length - left.length);
  }

  get receivedChars(): number { return this.received; }
  get disabled(): boolean { return this.overLimit; }

  /** Full replacement text, undefined when unchanged; an empty string clears it. */
  push(delta: string): string | undefined {
    if (this.closed || !delta) return undefined;
    this.received = Math.min(Number.MAX_SAFE_INTEGER, this.received + delta.length);
    if (this.overLimit) return undefined;
    if (this.received > MAX_DRAFT_INPUT_CHARS) {
      this.overLimit = true;
      this.source = "";
      this.previous = "";
      return "";
    }
    this.source += delta;
    if (!delta.includes("\n")) return undefined;
    const complete = completeSafeLines(this.source, this.secrets);
    // Redact before normalization or display truncation: either may otherwise
    // change a credential so that later exact matching can no longer find it.
    let preview = normalizeDraft(redactDraft(complete, this.secrets), this.language);
    if (preview.length > MAX_DRAFT_PREVIEW_CHARS) {
      const boundary = preview.indexOf("\n", preview.length - MAX_DRAFT_PREVIEW_CHARS);
      preview = boundary < 0 ? "" : preview.slice(boundary + 1);
    }
    if (preview === this.previous) return undefined;
    this.previous = preview;
    return preview;
  }

  /** Discard the unterminated tail; the ordinary final-answer path owns it. */
  finish(): void {
    this.closed = true;
    this.source = "";
    this.previous = "";
  }

  reset(): void {
    this.source = "";
    this.previous = "";
    this.received = 0;
    this.closed = false;
    this.overLimit = false;
  }
}
