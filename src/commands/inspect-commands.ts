import chalk from "chalk";
import type { ActivityLog } from "../activity.js";
import type { Agent } from "../agent.js";
import type { BackgroundManager } from "../background.js";
import type { AgentConfig } from "../config.js";
import { formatTaskDiagnosticSummary } from "../diagnostics.js";
import { collectDoctorReport, type DoctorProviderRegistry, type DoctorReport, formatDoctorReport } from "../doctor.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import { formatLocalTime } from "../local-time.js";
import type { McpManager } from "../mcp.js";
import type { MultiAgentCoordinator } from "../multi-agent.js";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import type { XiuSettings } from "../settings.js";
import { explainUnhandledSlashInput, formatHelpEntries, formatSlashInputProblem, helpEntriesFor } from "../slash-commands.js";
import type { StatusLine } from "../status.js";
import { contextLimitModeLabel, contextWindowSourceLabel, runOutcomeLabel } from "../status-labels.js";
import { formatUserFacingError } from "../user-facing-errors.js";

export interface InspectCommandContext {
  activities: Pick<ActivityLog, "list" | "get">;
  agent: Pick<Agent, "status">;
  background: Pick<BackgroundManager, "list">;
  /** Capability-probe line for a profile/model pair, as the CLI formats it (`探测：…` / `Probe: …`). */
  capabilityProbeSummary: (profile: ProviderProfile, model?: string) => string;
  /** The live runtime config: `/status` and `/model` read the provider that is current when they run. */
  config: Pick<AgentConfig, "apiKey" | "cwd" | "provider" | "providerId">;
  coordinator: Pick<MultiAgentCoordinator, "list">;
  /** Feature names for a profile/model pair, as the CLI formats them (`文本/工具/…`). */
  featureNames: (profile: ProviderProfile, model?: string) => string;
  language: UiLanguage;
  mcpManager: Pick<McpManager, "status" | "tools">;
  /** `get` serves `/status`; the doctor-facing methods serve `/doctor`. */
  providerRegistry: Pick<ProviderRegistry, "get"> & DoctorProviderRegistry;
  settings: XiuSettings;
  startupProfile: ProviderProfile;
  status: Pick<StatusLine, "start" | "stop">;
  version: string;
  /** Builds the `/doctor` report; defaults to the real collector and is injectable for tests. */
  collectDoctor?: () => Promise<DoctorReport>;
}

/**
 * Read-only inspection slash commands moved out of the interactive loop in cli.ts
 * (`/model`, `/details`, the idle notice for `/queue`, `/clear-queue` and `/cancel`, `/status`, `/doctor`, `/help`);
 * returns false when `task` is not one of them. Output is unchanged, and none of them changes agent state.
 */
export async function handleInspectCommand(task: string, ctx: InspectCommandContext): Promise<boolean> {
  const { activities, agent, background, capabilityProbeSummary, config, coordinator, featureNames, language, mcpManager, providerRegistry, settings, startupProfile, status } = ctx;
  if (task === "/model" || task.startsWith("/model ")) {
    console.log(chalk.dim(localize(language, `使用 /models 选择模型。当前 Provider/模型：${config.providerId}/${agent.status().model}\n`, `Use /models to choose a model. Current provider/model: ${config.providerId}/${agent.status().model}\n`)));
    return true;
  }
  if (task === "/details") {
    const records = activities.list();
    if (!records.length) {
      console.log(chalk.dim(localize(language, "尚未记录工具或 Agent 活动。\n", "No tool or Agent activity has been recorded yet.\n")));
      return true;
    }
    const selected = await selectTerminalOption(localize(language, "活动详情", "Activity details"), records.map((record) => ({
      label: `${record.state} ${record.title}`,
      description: `${formatLocalTime(record.startedAt)}  ${record.description}`,
      value: record.id,
    })), language);
    if (selected) {
      const record = activities.get(selected)!;
      const kind = localize(language, ({ tool: "工具", agent: "Agent", system: "系统" } as Record<string, string>)[record.kind] ?? record.kind, record.kind);
      const state = localize(language, ({ running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[record.state] ?? record.state, record.state);
      console.log(`${chalk.cyan(`${kind} ${record.title}`)} ${chalk.dim(`[${state}]`)}\n${record.description}\n\n${record.detail ?? record.summary ?? localize(language, "暂无详情。", "No detail yet.")}\n`);
    }
    return true;
  }
  if (task === "/queue" || task.startsWith("/queue ") || task === "/clear-queue" || task === "/cancel") {
    const word = task.split(/\s+/)[0]!;
    console.log(chalk.dim(localize(language, `${word} 仅在任务运行时可用。\n`, `${word} is available while a task is running.\n`)));
    return true;
  }
  if (task === "/status") {
    const current = agent.status();
    const zh = language === "zh-CN";
    const index = current.index;
    const indexModeZh = index?.mode === "full" ? "全量构建" : index?.mode === "incremental" ? "增量更新" : index?.mode === "cache" ? "缓存复用" : "未初始化";
    const indexModeEn = index?.mode === "full" ? "full build" : index?.mode === "incremental" ? "incremental" : index?.mode === "cache" ? "cache reused" : "not initialized";
    const indexStatusZh = `索引：${index?.files ?? 0} 个文件${index?.truncated ? "（已截断）" : ""} · ${index?.analyzedModules ?? 0} 个已分析模块 · ${index?.symbols ?? 0} 个符号 · ${index?.dependencies ?? 0} 条依赖 · ${indexModeZh} · ${index?.durationMs ?? 0} 毫秒${index?.dirty ? " · 等待刷新" : ""}`;
    const indexStatusEn = `Index: ${index?.files ?? 0} files${index?.truncated ? " (truncated)" : ""} · ${index?.analyzedModules ?? 0} analyzed modules · ${index?.symbols ?? 0} symbols · ${index?.dependencies ?? 0} dependencies · ${indexModeEn} · ${index?.durationMs ?? 0}ms${index?.dirty ? " · refresh pending" : ""}`;
    console.log(zh ? [
      `会话：${current.sessionId ?? "尚未开始"}`, `Provider：${config.providerId}（${config.provider}）`, `模型：${current.model}`, `能力：${featureNames(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `能力探测：${capabilityProbeSummary(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `语言：简体中文`,
      `规划模式：${current.planMode ? "开启（只读）" : "关闭"}`, `上次结果：${runOutcomeLabel(current.outcome, language)}`,
      `轮次：${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : "（无限制）"}`, `待处理补充：${current.pendingSteering}`, `消息：${current.messages}`,
      `上下文估算：约 ${current.stats.estimatedTokens.toLocaleString()} tokens`, `自动压缩：${current.contextLimit.toLocaleString()} tokens（${contextLimitModeLabel(current.contextLimitMode, language)}）`,
      `模型窗口：${current.contextWindow.toLocaleString()} tokens（${contextWindowSourceLabel(current.contextWindowSource, language)}）`, `API Token：输入 ${current.stats.inputTokens.toLocaleString()} / 输出 ${current.stats.outputTokens.toLocaleString()}`,
      `调用：模型 ${current.stats.modelCalls} / 工具 ${current.stats.toolCalls}`, `压缩次数：${current.stats.compactions}`, `活跃时间：${(current.stats.activeMs / 1000).toFixed(1)} 秒`,
      `最近任务诊断：${current.diagnostics ? formatTaskDiagnosticSummary(current.diagnostics, language) : "暂无"}`,
      indexStatusZh, `MCP：${mcpManager.status().filter((server) => server.state === "connected").length} 个服务 / ${mcpManager.tools().length} 个工具`,
      `Agents：${coordinator.list().filter((run) => run.status === "running").length} 个运行中 / ${coordinator.list().length} 个已保存`, `后台：${background.list().filter((item) => item.running).length} 个运行中`,
      `活动：${activities.list().length} 条记录（/details）`,
    ].join("\n") + "\n" : [
      `Session: ${current.sessionId ?? "not started"}`, `Provider: ${config.providerId} (${config.provider})`, `Model: ${current.model}`, `Capabilities: ${featureNames(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `Capability probe: ${capabilityProbeSummary(providerRegistry.get(config.providerId) ?? startupProfile, current.model)}`, `Language: English`, `Plan mode: ${current.planMode ? "ON (read-only)" : "OFF"}`, `Last outcome: ${runOutcomeLabel(current.outcome, language)}`,
      `Turn: ${current.turn || "-"}${current.maxTurns ? `/${current.maxTurns}` : " (unlimited)"}`, `Pending steering: ${current.pendingSteering}`, `Messages: ${current.messages}`,
      `Context estimate: ~${current.stats.estimatedTokens.toLocaleString()} tokens`, `Auto compact: ${current.contextLimit.toLocaleString()} tokens (${contextLimitModeLabel(current.contextLimitMode, language)})`,
      `Model window: ${current.contextWindow.toLocaleString()} tokens (${contextWindowSourceLabel(current.contextWindowSource, language)})`, `API tokens: ${current.stats.inputTokens.toLocaleString()} in / ${current.stats.outputTokens.toLocaleString()} out`,
      `Calls: ${current.stats.modelCalls} model / ${current.stats.toolCalls} tool`, `Compactions: ${current.stats.compactions}`, `Active time: ${(current.stats.activeMs / 1000).toFixed(1)}s`,
      `Latest task diagnostics: ${current.diagnostics ? formatTaskDiagnosticSummary(current.diagnostics, language) : "none"}`,
      indexStatusEn, `MCP: ${mcpManager.status().filter((server) => server.state === "connected").length} servers / ${mcpManager.tools().length} tools`,
      `Agents: ${coordinator.list().filter((run) => run.status === "running").length} running / ${coordinator.list().length} saved runs`, `Background: ${background.list().filter((item) => item.running).length} running`,
      `Activities: ${activities.list().length} recorded (/details)`,
    ].join("\n") + "\n");
    return true;
  }
  if (task === "/doctor") {
    status.start(localize(language, "正在生成诊断报告", "Collecting diagnostics"));
    try {
      const report = await (ctx.collectDoctor ?? (() => collectDoctorReport({ version: ctx.version, settings, registry: providerRegistry, cwd: config.cwd, sensitive: config.apiKey ? [config.apiKey] : [] })))();
      status.stop();
      console.log(`${formatDoctorReport(report, language)}\n`);
    } catch (error) {
      status.stop();
      console.error(chalk.red(`${formatUserFacingError(localize(language, "诊断报告生成失败", "Could not build the diagnostics report"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/help" || task.startsWith("/help ")) {
    const topic = task.slice("/help".length).trim();
    const entries = helpEntriesFor(topic, language);
    if (entries.length) console.log(`${formatHelpEntries(entries)}\n`);
    else console.log(chalk.yellow(`${formatSlashInputProblem(explainUnhandledSlashInput(topic.startsWith("/") ? topic : `/${topic}`, { pathExists: () => false }) ?? { kind: "unknown-command", word: topic, suggestions: [] }, language)}\n`));
    return true;
  }
  return false;
}
