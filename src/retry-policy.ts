export type RetryOperation = "model" | "tool" | "mcp" | "media";
export type RetryCategory = "cancelled" | "authentication" | "authorization" | "invalid-request" | "not-found" | "conflict" | "rate-limit" | "timeout" | "transport" | "server" | "unknown";
export type ReplaySafety = "safe" | "idempotent" | "side-effecting" | "unknown";
export type CommitState = "not-started" | "not-committed" | "committed" | "unknown";

export interface RetryDecisionInput {
  operation: RetryOperation;
  error: unknown;
  attempt: number;
  maxAttempts: number;
  replaySafety: ReplaySafety;
  commitState?: CommitState;
  outputEmitted?: boolean;
}

export interface RetryDecision { category: RetryCategory; retry: boolean; delayMs?: number; reason: string }

type ErrorShape = { name?: string; message?: string; code?: string | number; status?: number; statusCode?: number; retryAfterMs?: number; headers?: Headers | Record<string, string | string[] | undefined>; cause?: unknown };

function errorChain(error: unknown): ErrorShape[] {
  const values: ErrorShape[] = [];
  let current = error as ErrorShape | undefined;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    values.push(current);
    current = current.cause as ErrorShape | undefined;
  }
  return values;
}

function statusOf(chain: ErrorShape[]): number | undefined {
  for (const item of chain) {
    const status = item.status ?? item.statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function requestedDelay(chain: ErrorShape[]): number | undefined {
  for (const item of chain) {
    if (typeof item.retryAfterMs === "number" && Number.isFinite(item.retryAfterMs)) return Math.max(0, item.retryAfterMs);
    const headers = item.headers;
    let value: string | undefined;
    if (headers instanceof Headers) value = headers.get("retry-after") ?? undefined;
    else if (headers) {
      const raw = headers["retry-after"] ?? headers["Retry-After"];
      value = Array.isArray(raw) ? raw[0] : raw;
    }
    if (!value) continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

export function classifyRetryError(error: unknown): RetryCategory {
  const chain = errorChain(error);
  const status = statusOf(chain);
  const names = chain.map((item) => item.name ?? "").join(" ").toLowerCase();
  const codes = chain.map((item) => String(item.code ?? "")).join(" ").toUpperCase();
  const detail = chain.map((item) => item.message ?? "").join(" ").toLowerCase();
  if (/abort|cancel/.test(names) || /\b(aborted|cancelled|canceled)\b/.test(detail) || /ABORT_ERR/.test(codes)) return "cancelled";
  if (status === 401 || /unauthenticated|invalid[_ -]?api[_ -]?key|authentication failed/.test(detail)) return "authentication";
  if (status === 403 || /permission denied|insufficient[_ -]?scope|forbidden/.test(detail)) return "authorization";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if ([400, 405, 406, 410, 413, 415, 422].includes(status ?? 0)) return "invalid-request";
  if (status === 429 || /rate.?limit|too many requests|quota temporarily/.test(detail)) return "rate-limit";
  if (status === 408 || status === 425 || /timeout|timed out|deadline exceeded|ETIMEDOUT/i.test(`${detail} ${codes}`)) return "timeout";
  if (typeof status === "number" && status >= 500 && status <= 599) return "server";
  if (/ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT|UND_ERR_SOCKET/.test(codes)
    || /connection error|connection reset|network error|fetch failed|socket hang up|temporarily unavailable/.test(detail)) return "transport";
  return "unknown";
}

export function retryDecision(input: RetryDecisionInput): RetryDecision {
  const category = classifyRetryError(input.error);
  if (category === "cancelled") return { category, retry: false, reason: "user cancellation is final" };
  if (input.outputEmitted) return { category, retry: false, reason: "streaming output was already emitted" };
  const commitState = input.commitState ?? "not-started";
  if (commitState === "committed" || commitState === "unknown") return { category, retry: false, reason: `side-effect commit state is ${commitState}` };
  if (input.replaySafety !== "safe" && input.replaySafety !== "idempotent") return { category, retry: false, reason: `operation replay safety is ${input.replaySafety}` };
  if (!(["rate-limit", "timeout", "transport", "server"] as RetryCategory[]).includes(category)) return { category, retry: false, reason: `${category} errors are not transient` };
  if (input.attempt >= input.maxAttempts) return { category, retry: false, reason: "retry budget exhausted" };
  const exponential = 500 * 2 ** Math.max(0, input.attempt - 1);
  return { category, retry: true, delayMs: Math.min(30_000, Math.max(0, requestedDelay(errorChain(input.error)) ?? exponential)), reason: `${category} error on a safely replayable ${input.operation} operation` };
}

export async function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("Task cancelled."), { name: "AbortError" }));
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Task cancelled."), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
