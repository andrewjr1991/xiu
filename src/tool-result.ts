import type { ToolResult } from "./types.js";

export function toolResult(output: string, status: ToolResult["status"] = "success", extra: Partial<ToolResult> = {}): ToolResult {
  return { status, output, retryable: false, sideEffectState: "none", ...extra };
}

export function toolErrorCode(message: string): string {
  if (/ENOENT|not found|no such file/i.test(message)) return "not_found";
  if (/outside|escape|workspace-relative/i.test(message)) return "outside_workspace";
  if (/exactly one|match|stale/i.test(message)) return "match_count";
  if (/EACCES|EPERM|permission/i.test(message)) return "permission";
  if (/invalid|must be|required|argument/i.test(message)) return "invalid_input";
  return "tool_error";
}

/** Compatibility boundary only. Native tools should supply status and exitCode directly. */
export function normalizeToolResult(value: string | ToolResult): ToolResult {
  if (typeof value !== "string") return value;
  if (/^(?:Tool execution denied|Tool execution blocked)/i.test(value)) return toolResult(value, "denied", { errorCode: "denied" });
  if (/^(?:(?:Process|Command|Verification|Tool) cancelled|Task cancelled)/i.test(value)) return toolResult(value, "cancelled", { errorCode: "cancelled", sideEffectState: "unknown" });
  if (/^(?:Process|Command|Verification) timed out/i.test(value)) return toolResult(value, "failure", { errorCode: "timeout", sideEffectState: "unknown" });
  const exit = /^Exit code: (\S+)/.exec(value);
  if (exit) {
    const code = Number(exit[1]);
    return toolResult(value, code === 0 ? "success" : "failure", {
      ...(Number.isInteger(code) ? { exitCode: code } : {}),
      ...(code === 0 ? {} : { errorCode: "execution_failed" }), sideEffectState: "possible",
    });
  }
  if (/^(?:Tool error:|Unknown tool:|Verification (?:failed|unavailable)|Unable to )/i.test(value)) {
    return toolResult(value, "failure", { errorCode: toolErrorCode(value) });
  }
  return toolResult(value);
}
