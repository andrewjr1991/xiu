import chalk from "chalk";
import { BackgroundApprovalRequiredError } from "./agent.js";
import type { AgentConfig } from "./config.js";
import { localize, type UiLanguage } from "./i18n.js";
import { selectTerminalOption } from "./interactive-ui.js";
import type { SecurityAuditLog } from "./security-audit.js";
import type { ApprovalRequest } from "./types.js";

export type ApprovalChoice = "deny" | "once" | "session";

export interface TerminalApprovalsIo {
  /** True when a person can answer a prompt on this terminal. */
  interactive: () => boolean;
  log: (line: string) => void;
  select: (title: string, options: Array<{ label: string; description: string; value: ApprovalChoice }>, language: UiLanguage) => Promise<ApprovalChoice | undefined>;
}

export interface TerminalApprovalsContext {
  config: Pick<AgentConfig, "autoApprove" | "backgroundMode">;
  language: () => UiLanguage;
  securityAudit: Pick<SecurityAuditLog, "record">;
  status: { stop: () => void };
  /** Runs right before a prompt is shown: the interactive loop stops its queued-input reader and discards the live task view. */
  beforePrompt: () => void;
  /** The terminal; the real one unless a test injects its own. */
  io?: TerminalApprovalsIo;
}

export interface TerminalApprovals {
  /** The tool approval handler: automatic policy, remembered session scopes, then one prompt at a time. */
  approve: (request: ApprovalRequest) => Promise<boolean>;
  /** Resolves once the prompt currently on screen, if any, has been answered. */
  activePrompt: () => Promise<void>;
}

const realIo: TerminalApprovalsIo = {
  interactive: () => Boolean(process.stdin.isTTY),
  log: (line) => console.log(line),
  select: (title, options, language) => selectTerminalOption(title, options, language),
};

/**
 * Risk approval for the terminal: `-y` approves write and execute requests but never dangerous ones, a scope the user
 * chose to remember is honoured until the process exits, and everything else is one prompt at a time. Without a
 * terminal to answer on the request is denied (or, in background mode, surfaced as an error). Every decision is
 * written to the local security-audit ledger with its outcome, risk, source and scope; the ledger never changes a decision.
 */
export function createTerminalApprovals(ctx: TerminalApprovalsContext): TerminalApprovals {
  const io = ctx.io ?? realIo;
  const language = (): UiLanguage => ctx.language();
  const config = ctx.config;
  let approvalQueue = Promise.resolve();
  let activeApproval = Promise.resolve();
  const sessionApprovalScopes = new Set<string>();
  const approveRequest = async (request: ApprovalRequest): Promise<boolean> => {
    let release!: () => void;
    const previous = approvalQueue;
    approvalQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let finishActiveApproval!: () => void;
    let approvalDecision: boolean | undefined;
    try {
      if (config.autoApprove && request.risk !== "dangerous") {
        request.decisionSource = "automatic";
        approvalDecision = true;
        return approvalDecision;
      }
      if (request.sessionScope && sessionApprovalScopes.has(request.sessionScope)) {
        request.decisionSource = "remembered";
        approvalDecision = true;
        return approvalDecision;
      }
      request.decisionSource = "prompted";
      if (!io.interactive()) {
        // Nothing can answer a prompt here, so deny without tearing down the live task view: the
        // denial and the tool's start line stay visible in the piped output.
        if (config.backgroundMode) throw new BackgroundApprovalRequiredError(request.description);
        approvalDecision = false;
        return approvalDecision;
      }
      activeApproval = new Promise<void>((resolve) => { finishActiveApproval = resolve; });
      ctx.status.stop();
      ctx.beforePrompt();
      if (request.preview) io.log(`${chalk.dim(localize(language(), "拟议修改：", "Proposed change:"))}\n${request.preview}\n`);
      const options = [
        { label: localize(language(), "否，拒绝", "No, deny"), description: localize(language(), "不执行此操作", "Do not run this operation"), value: "deny" as const },
        { label: localize(language(), "是，仅允许一次", "Yes, allow once"), description: request.description, value: "once" as const },
        ...(request.sessionScope ? [{
          label: localize(language(), "是，本次会话始终允许", "Yes, always allow this session"),
          description: localize(language(), "仅记住这一类操作；重新启动 Xiu 后失效", "Remember only this operation family until Xiu exits"),
          value: "session" as const,
        }] : []),
      ];
      const selected = await io.select(localize(language(), `${request.risk.toUpperCase()} 审批：允许 Xiu ${request.description}？`, `${request.risk.toUpperCase()} approval: allow Xiu to ${request.description}?`), options, language());
      if (selected === "session" && request.sessionScope) sessionApprovalScopes.add(request.sessionScope);
      approvalDecision = selected === "once" || selected === "session";
      return approvalDecision;
    } finally {
      await ctx.securityAudit.record({
        category: "approval",
        action: "tool-approval",
        outcome: approvalDecision ? "allowed" : "denied",
        risk: request.risk,
        source: request.decisionSource ?? "prompted",
        scope: request.sessionScope ?? "unscoped",
      });
      finishActiveApproval?.();
      release();
    }
  };
  return { approve: approveRequest, activePrompt: () => activeApproval };
}
