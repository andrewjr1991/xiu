const SECRET_FIELD = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|authorization|cookie|credential)/i;
const SAFE_TOKEN_METRICS = new Set([
  "inputtokens", "outputtokens", "totaltokens", "estimatedtokens", "cachereadinputtokens", "cachecreationinputtokens",
  "beforetokens", "aftertokens", "maxtokens", "tokencount", "tokenbudget", "tokenusage", "tokentype",
]);

export function isSecretField(key: string): boolean {
  if (SAFE_TOKEN_METRICS.has(key.replace(/[-_]/g, "").toLowerCase())) return false;
  return SECRET_FIELD.test(key);
}

export function redactSecrets(value: string, sensitiveValues: readonly string[] = []): string {
  let result = value;
  for (const secret of sensitiveValues.filter((item) => item.length >= 4)) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/([?&](?:code|token|access_token|refresh_token|id_token|client_secret)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/("?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|client[-_]?secret|secret|authorization|cookie|credential)"?\s*[:=]\s*"?)[^"\s,;}]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?\b/g, "[REDACTED-JWT]");
}

export function sanitizeSecrets<T>(value: T, sensitiveValues: readonly string[] = []): T {
  const visit = (candidate: unknown, key = "", seen = new WeakSet<object>()): unknown => {
    if (key && isSecretField(key)) {
      if (candidate === "configured" || candidate === "missing" || candidate === "[REDACTED]") return candidate;
      return "[REDACTED]";
    }
    if (typeof candidate === "string") return redactSecrets(candidate, sensitiveValues);
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) return "[circular]";
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map((item) => visit(item));
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]));
  };
  return visit(value) as T;
}
