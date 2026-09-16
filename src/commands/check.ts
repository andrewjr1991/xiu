import { builtinTools, executeToolResult, resolveWorkspacePath } from "../tools.js";
import { isSecretField, redactSecrets } from "../secret-redaction.js";
import type { ToolContext } from "../types.js";

export const PROJECT_CHECK_NAMES = ["typecheck", "lint", "test", "build"] as const;
export type ProjectCheckName = typeof PROJECT_CHECK_NAMES[number];
export type ProjectCheckSelection = ProjectCheckName | "all";
export type ProjectCheckStatus = "passed" | "failed" | "cancelled" | "denied" | "skipped";

export interface ProjectCheck {
  name: ProjectCheckName;
  command: string;
  available: boolean;
  /** The package script, with secrets redacted before it reaches the UI. */
  script?: string;
  beforeScript?: string;
  afterScript?: string;
  reason?: string;
}

export interface ProjectCheckDiscovery {
  packagePresent: boolean;
  packageName?: string;
  checks: ProjectCheck[];
  error?: string;
}

export interface ProjectCheckResult extends ProjectCheck {
  status: ProjectCheckStatus;
  output: string;
  elapsedMs: number;
}

export interface ProjectCheckRun {
  selection: ProjectCheckSelection;
  discovery: ProjectCheckDiscovery;
  status: "completed" | "blocked" | "cancelled" | "unavailable";
  checks: ProjectCheckResult[];
  counts: Record<ProjectCheckStatus, number>;
  elapsedMs: number;
}

export interface ProjectCheckOptions {
  planMode?: boolean;
  sensitiveValues?: readonly string[];
  onCheckStart?: (check: ProjectCheck) => void | Promise<void>;
  onCheckResult?: (check: ProjectCheckResult) => void | Promise<void>;
}

function safeText(value: string, sensitiveValues: readonly string[] = []): string {
  const environmentSecrets = Object.entries(process.env)
    .filter(([key, secret]) => isSecretField(key) && secret)
    .map(([, secret]) => secret!);
  return redactSecrets(value, [...environmentSecrets, ...sensitiveValues]);
}

function absentChecks(reason: string): ProjectCheck[] {
  return PROJECT_CHECK_NAMES.map((name) => ({ name, command: `npm run ${name}`, available: false, reason }));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read project metadata only. The caller must establish workspace trust first. */
export async function discoverProjectChecks(context: ToolContext, options: Pick<ProjectCheckOptions, "sensitiveValues"> = {}): Promise<ProjectCheckDiscovery> {
  if (context.signal?.aborted) return { packagePresent: false, checks: absentChecks("Discovery cancelled."), error: "Discovery cancelled." };
  try {
    // project_info reads package.json; prevent a link to an external package first.
    resolveWorkspacePath(context.cwd, "package.json");
    const tool = builtinTools.find((candidate) => candidate.name === "project_info")!;
    const execution = await executeToolResult(tool, {}, context);
    if (execution.status !== "success") throw new Error(execution.output);
    const info: unknown = JSON.parse(execution.output);
    if (!record(info) || !Array.isArray(info.markers)) throw new Error("Project discovery returned invalid metadata.");
    const packagePresent = info.markers.includes("package.json");
    if (!packagePresent) return { packagePresent: false, checks: absentChecks("No package.json in the workspace root.") };
    if (typeof info.package_error === "string") throw new Error(`Cannot read package.json: ${info.package_error}`);
    if (!record(info.scripts)) throw new Error("package.json scripts must be an object.");
    const scripts = info.scripts;
    const checks = PROJECT_CHECK_NAMES.map((name): ProjectCheck => {
      const script = scripts[name];
      const available = typeof script === "string" && script.trim().length > 0;
      const result: ProjectCheck = { name, command: `npm run ${name}`, available };
      if (!available) {
        result.reason = script === undefined ? `No ${name} script in package.json.` : `The ${name} script must be a non-empty string.`;
        return result;
      }
      result.script = safeText(script, options.sensitiveValues);
      for (const [prefix, property] of [["pre", "beforeScript"], ["post", "afterScript"]] as const) {
        const lifecycle = scripts[`${prefix}${name}`];
        if (typeof lifecycle === "string" && lifecycle.trim()) result[property] = safeText(lifecycle, options.sensitiveValues);
        else if (lifecycle !== undefined && typeof lifecycle !== "string") {
          result.available = false;
          result.reason = `The ${prefix}${name} script must be a string.`;
        }
      }
      return result;
    });
    return { packagePresent, packageName: typeof info.name === "string" ? safeText(info.name, options.sensitiveValues) : undefined, checks };
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : String(error), options.sensitiveValues);
    return { packagePresent: false, checks: absentChecks(message), error: message };
  }
}

export function projectCheckPreview(check: ProjectCheck): string {
  return [
    check.command,
    check.beforeScript !== undefined ? `pre${check.name}: ${check.beforeScript}` : undefined,
    `${check.name}: ${check.script ?? "(unavailable)"}`,
    check.afterScript !== undefined ? `post${check.name}: ${check.afterScript}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

/** Run named checks through the same approval and cancellation path as tools. */
export async function runProjectChecks(selection: ProjectCheckSelection, context: ToolContext, options: ProjectCheckOptions = {}): Promise<ProjectCheckRun> {
  if (selection !== "all" && !(PROJECT_CHECK_NAMES as readonly string[]).includes(selection)) {
    throw new Error("Usage: /check [typecheck|lint|test|build|all]");
  }
  const started = Date.now();
  const discovery = await discoverProjectChecks(context, options);
  const selected = discovery.checks.filter((check) => selection === "all" || check.name === selection);
  const result: ProjectCheckRun = {
    selection,
    discovery,
    status: context.signal?.aborted ? "cancelled" : options.planMode ? "blocked" : selected.some((check) => check.available) ? "completed" : "unavailable",
    checks: [],
    counts: { passed: 0, failed: 0, cancelled: 0, denied: 0, skipped: 0 },
    elapsedMs: 0,
  };
  let stopped: "cancelled" | "denied" | undefined;
  const tool = builtinTools.find((candidate) => candidate.name === "validate_project")!;
  for (const check of selected) {
    const checkStarted = Date.now();
    let status: ProjectCheckStatus = "skipped";
    let output = check.reason ?? "";
    if (options.planMode) output = "Plan mode is read-only. Check discovery is allowed; script execution is blocked.";
    else if (stopped) output = `Not started after ${stopped === "denied" ? "approval was denied" : "cancellation"}.`;
    else if (context.signal?.aborted) {
      status = "cancelled";
      output = "Checks cancelled by user.";
      stopped = "cancelled";
      result.status = "cancelled";
    } else if (check.available) {
      // Refresh before each execution: an earlier script may change package.json.
      const fresh = await discoverProjectChecks(context, options);
      const current = fresh.checks.find((candidate) => candidate.name === check.name)!;
      if (context.signal?.aborted) {
        status = "cancelled";
        output = "Checks cancelled by user.";
        stopped = "cancelled";
        result.status = "cancelled";
      } else if (!current.available) output = current.reason ?? fresh.error ?? "Check is no longer available.";
      else {
        Object.assign(check, current);
        await options.onCheckStart?.(check);
        try {
          const execution = await executeToolResult(tool, { check: check.name }, context);
          output = execution.output;
          status = context.signal?.aborted || execution.status === "cancelled" ? "cancelled"
            : execution.status === "denied" ? "denied"
              : execution.status === "success" && execution.exitCode === 0 ? "passed" : "failed";
        } catch (error) {
          output = error instanceof Error ? error.message : String(error);
          status = context.signal?.aborted ? "cancelled" : "failed";
        }
        if (status === "cancelled" || status === "denied") {
          stopped = status;
          result.status = status === "cancelled" ? "cancelled" : "blocked";
        }
      }
    }
    const item: ProjectCheckResult = { ...check, status, output: safeText(output, options.sensitiveValues), elapsedMs: Date.now() - checkStarted };
    result.checks.push(item);
    result.counts[status] += 1;
    await options.onCheckResult?.(item);
  }
  result.elapsedMs = Date.now() - started;
  return result;
}
