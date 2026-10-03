/** Bound silence, not task length. Streaming tool arguments count as progress. */
export class ModelRequestSilenceError extends Error {
  override readonly name = "ModelRequestSilenceError";
  constructor(readonly idleMs: number, readonly phase: "first-response" | "stream-idle" | "complete" = "stream-idle") {
    super(`${phase === "complete" ? "No complete model response received" : "No model data received"} for ${idleMs / 1000} seconds. Request stopped; incomplete tool calls were not executed. Retry or switch models.`);
  }
}

export async function watchModelRequest<T>(
  parent: AbortSignal,
  request: (signal: AbortSignal, progress: () => void) => Promise<T>,
  policy: number | { firstResponseMs: number; streamIdleMs: number; completeMs?: number } = { firstResponseMs: 600_000, streamIdleMs: 180_000 },
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (reason: unknown) => { controller.abort(reason); rejectAbort(reason); };
  const onAbort = () => abort(parent.reason ?? new Error("Model request cancelled."));
  let received = false;
  const arm = () => {
    clearTimeout(timer);
    const ms = typeof policy === "number" ? policy : policy.completeMs ?? (received ? policy.streamIdleMs : policy.firstResponseMs);
    const phase = typeof policy !== "number" && policy.completeMs !== undefined ? "complete" : received ? "stream-idle" : "first-response";
    timer = setTimeout(() => abort(new ModelRequestSilenceError(ms, phase)), ms);
  };
  const progress = () => { received = true; arm(); };
  parent.addEventListener("abort", onAbort, { once: true });
  arm();
  try {
    if (parent.aborted) { onAbort(); return await aborted; }
    return await Promise.race([request(controller.signal, progress), aborted]);
  } finally {
    clearTimeout(timer!);
    parent.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
