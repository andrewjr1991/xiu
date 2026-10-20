import chalk from "chalk";
import { localize, type UiLanguage } from "../i18n.js";
import { formatAgentRun, formatIntegrationPlan, type MultiAgentCoordinator } from "../multi-agent.js";
import { askYesNo } from "../terminal-prompts.js";
import { describeFailure } from "../user-facing-errors.js";

export interface AgentCommandContext {
  coordinator: Pick<MultiAgentCoordinator, "analyzeIntegration" | "cancel" | "get" | "integrate" | "list" | "retry">;
  /** The main workspace an Agent patch is integrated into; named in the confirmation prompt. */
  cwd: string;
  language: UiLanguage;
  /** Runs after an integration rewrote workspace files (the CLI invalidates its project index). */
  onIntegrated: () => void;
  /** The yes/no before the main workspace is written; defaults to the terminal prompt and is injectable for tests. */
  confirmIntegrate?: (prompt: string) => Promise<boolean>;
}

/**
 * The multi-agent slash command moved out of the interactive loop in cli.ts
 * (`/agents`, `/agents <run-id>`, `/agents cancel|retry|integrate <run-id> <task-id>`); returns false for anything else.
 * Output is unchanged. Integration still analyzes first, refuses when conflicts or evidence gates block it, and writes
 * the main workspace only after the explicit [write] confirmation.
 */
export async function handleAgentCommand(task: string, ctx: AgentCommandContext): Promise<boolean> {
  if (task !== "/agents" && !task.startsWith("/agents ")) return false;
  const { coordinator, cwd, language, onIntegrated } = ctx;
  const confirmIntegrate = ctx.confirmIntegrate ?? askYesNo;
  const parts = task.split(/\s+/);
  try {
    if (parts.length === 1) {
      const runs = coordinator.list();
      console.log(runs.length ? `${runs.map((run) => formatAgentRun(run, language)).join("\n\n")}\n` : chalk.dim(localize(language, "没有多 Agent 运行记录。\n", "No multi-agent runs.\n")));
    } else if (parts[1] === "cancel" && parts[2] && parts[3]) {
      const cancelled = await coordinator.cancel(parts[2], parts[3]);
      console.log(chalk.yellow(localize(language, `Agent ${cancelled.id} 状态：${cancelled.status}。\n`, `Agent ${cancelled.id} is ${cancelled.status}.\n`)));
    } else if (parts[1] === "retry" && parts[2] && parts[3]) {
      console.log(`${formatAgentRun(await coordinator.retry(parts[2], parts[3]), language)}\n`);
    } else if (parts[1] === "integrate" && parts[2] && parts[3]) {
      const plan = await coordinator.analyzeIntegration(parts[2], parts[3]);
      console.log(`${formatIntegrationPlan(plan, language)}\n`);
      if (!plan.canIntegrate) {
        console.log(chalk.red(localize(language, "合并已被冲突或证据门禁阻止；主工作区和 Agent Worktree 均未修改。\n", "Integration is blocked by conflicts or evidence gates; the main workspace and Agent Worktree were not modified.\n")));
        return true;
      }
      if (!(await confirmIntegrate(chalk.yellow("[write]") + localize(language, ` 将此 Agent 补丁合并到 ${cwd}？[y/N] `, ` Integrate this Agent patch into ${cwd}? [y/N] `)))) console.log(chalk.dim(localize(language, "已取消 Agent 集成。\n", "Agent integration cancelled.\n")));
      else {
        console.log(chalk.green(`${await coordinator.integrate(parts[2], parts[3])}\n`));
        onIntegrated();
      }
    } else if (parts.length === 2) {
      console.log(`${formatAgentRun(coordinator.get(parts[1]), language)}\n`);
    } else {
      console.log(chalk.yellow(localize(language, "用法：/agents [运行ID] | /agents cancel|retry|integrate <运行ID> <任务ID>\n", "Usage: /agents [run-id] | /agents cancel|retry|integrate <run-id> <task-id>\n")));
    }
  } catch (error) {
    console.error(chalk.red(`${describeFailure(localize(language, "Agent 命令失败", "Agent command failed"), error, language)}\n`));
  }
  return true;
}
