import chalk from "chalk";
import type { ActivityLog } from "../activity.js";
import type { Agent } from "../agent.js";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import type { StatusLine } from "../status.js";
import { projectCheckReason } from "../status-labels.js";
import type { ApprovalRequest } from "../types.js";
import { describeFailure } from "../user-facing-errors.js";
import { discoverProjectChecks, projectCheckPreview, PROJECT_CHECK_NAMES, runProjectChecks, type ProjectCheckRun, type ProjectCheckSelection, type ProjectCheckStatus } from "./check.js";

export interface ProjectCheckCommandContext {
  activities: Pick<ActivityLog, "start" | "finish">;
  agent: Pick<Agent, "status">;
  /** The CLI's approval prompt: a check's script runs only after it allows the `validate_project` operation (Plan mode blocks execution before that). */
  approve: (request: ApprovalRequest) => Promise<boolean>;
  /** `cwd` is the workspace checked; `apiKey` is redacted from scripts, output and errors. */
  config: Pick<AgentConfig, "cwd" | "apiKey">;
  language: UiLanguage;
  /** This session's last completed run, which a bare `/check` lists without rerunning; `setLatestProjectCheck` stores the next one. */
  latestProjectCheck: () => ProjectCheckRun | undefined;
  setLatestProjectCheck: (run: ProjectCheckRun) => void;
  /** Receives the controller of a run while scripts execute and undefined when the run ends, so Ctrl+C can cancel it. */
  setActiveCheck: (controller: AbortController | undefined) => void;
  /** Runs after scripts executed (the CLI invalidates its project index, since a script may have written files). */
  onChecksExecuted: () => void;
  /** Redacts a line the way the CLI redacts everything it prints. */
  redact: (value: string) => string;
  status: Pick<StatusLine, "start" | "stop">;
}

export function checkStatusLabel(value: ProjectCheckStatus, language: UiLanguage): string {
  return {
    passed: localize(language, "脚本通过（退出码 0）", "script passed (exit 0)"),
    failed: localize(language, "失败", "failed"),
    cancelled: localize(language, "已取消", "cancelled"),
    denied: localize(language, "已拒绝", "denied"),
    skipped: localize(language, "已跳过", "skipped"),
  }[value];
}

function printCheckSummary(result: ProjectCheckRun, language: UiLanguage): void {
  console.log(localize(language,
    `检查结果：${result.counts.passed} 通过 / ${result.counts.failed} 失败 / ${result.counts.cancelled} 取消 / ${result.counts.denied} 拒绝 / ${result.counts.skipped} 跳过 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`,
    `Checks: ${result.counts.passed} passed / ${result.counts.failed} failed / ${result.counts.cancelled} cancelled / ${result.counts.denied} denied / ${result.counts.skipped} skipped · ${(result.elapsedMs / 1000).toFixed(1)}s`));
  console.log(chalk.dim(localize(language, "通过仅表示脚本退出码为 0，不保证功能正确；后续改动需要重新检查。\n", "Passed means the script exited with code 0, not a guarantee of functional correctness; rerun after changes.\n")));
}

/**
 * The `/check` command moved out of the interactive loop in cli.ts (`/check` lists the package scripts and the last
 * record, `/check <name>|all` runs them through the tool approval path); returns false when `task` is not it. Output,
 * approval and cancellation are unchanged.
 */
export async function handleProjectCheckCommand(task: string, ctx: ProjectCheckCommandContext): Promise<boolean> {
  if (task !== "/check" && !task.startsWith("/check ")) return false;
  const { activities, agent, approve, config, language, redact, status } = ctx;
  const selection = task.slice("/check".length).trim();
  if (selection && selection !== "all" && !(PROJECT_CHECK_NAMES as readonly string[]).includes(selection)) {
    console.log(chalk.yellow(localize(language, "用法：/check [typecheck|lint|test|build|all]\n", "Usage: /check [typecheck|lint|test|build|all]\n")));
    return true;
  }
  const controller = new AbortController();
  ctx.setActiveCheck(controller);
  const checkContext = { cwd: config.cwd, signal: controller.signal, approve };
  const sensitiveValues = config.apiKey ? [config.apiKey] : [];
  try {
    if (!selection) {
      const discovery = await discoverProjectChecks(checkContext, { sensitiveValues });
      if (discovery.error) console.log(chalk.yellow(redact(discovery.error)));
      for (const check of discovery.checks) {
        console.log(check.available
          ? `${chalk.cyan(check.name)}\n${redact(projectCheckPreview(check))}\n`
          : chalk.dim(`${check.name}: ${redact(projectCheckReason(check, language))}`));
      }
      const previous = ctx.latestProjectCheck();
      if (previous) {
        console.log(chalk.dim(localize(language, "上次检查记录（未重新运行）：", "Previous check record (not rerun):")));
        for (const check of previous.checks) console.log(`${check.name}: ${checkStatusLabel(check.status, language)}`);
        printCheckSummary(previous, language);
      }
      console.log(chalk.dim(localize(language, "使用 /check <检查名> 或 /check all 执行。\n", "Run /check <name> or /check all to execute.\n")));
      return true;
    }
    const checkActivities = new Map<string, string>();
    const run = await runProjectChecks(selection as ProjectCheckSelection, checkContext, {
      planMode: agent.status().planMode,
      sensitiveValues,
      onCheckStart: (check) => {
        console.log(`${chalk.cyan(localize(language, "准备运行项目检查", "Preparing project check"))}\n${redact(projectCheckPreview(check))}`);
        checkActivities.set(check.name, activities.start("tool", "validate_project", check.command));
        status.start(localize(language, `正在检查 ${check.name} · Ctrl+C 取消`, `Checking ${check.name} · Ctrl+C to cancel`));
      },
      onCheckResult: (check) => {
        status.stop();
        const activity = checkActivities.get(check.name);
        if (activity) activities.finish(activity, check.output, check.status !== "passed");
        const label = `${check.name}: ${checkStatusLabel(check.status, language)} · ${(check.elapsedMs / 1000).toFixed(1)}s`;
        console.log(check.status === "passed" ? chalk.green(label) : check.status === "failed" ? chalk.red(label) : chalk.yellow(label));
        if (check.status !== "passed" && check.output) {
          const output = redact(check.output);
          console.log(chalk.dim(output.length > 2_000 ? `${output.slice(0, 2_000)}\n${localize(language, "（使用 /details 查看完整输出）", "(/details for full output)")}` : output));
        }
      },
    });
    ctx.setLatestProjectCheck(run);
    printCheckSummary(run, language);
    ctx.onChecksExecuted();
  } catch (error) {
    console.error(chalk.red(redact(`${describeFailure(localize(language, "项目检查失败", "Project check failed"), error, language)}\n`)));
  } finally {
    status.stop();
    ctx.setActiveCheck(undefined);
  }
  return true;
}
