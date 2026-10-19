import { localize, type UiLanguage } from "../i18n.js";
import { type SecurityAuditCategory, SecurityAuditLog, type SecurityAuditRecord } from "../security-audit.js";
import { isWorkspaceTrusted } from "../trust.js";

/**
 * `xiu audit [approvals|credentials] [json] [<limit>]`: the non-interactive `/audit`, for scripts
 * and CI that want to see which approvals a run made and which were denied. Read-only; shows the
 * records of this workspace from the user's local ledger (`~/.xiu/security-audit.jsonl`), newest
 * last, as the same fixed fields the ledger holds: no command text, prompt, path or credential.
 */

export interface AuditCliOptions {
  cwd: string;
  language: UiLanguage;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  audit?: Pick<SecurityAuditLog, "read" | "status">;
  isTrusted?: (cwd: string) => Promise<boolean>;
}

const CATEGORIES: Record<string, SecurityAuditCategory> = { approvals: "approval", approval: "approval", credentials: "credential", credential: "credential" };
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** The record's fixed fields after the timestamp, as `/audit` and `xiu audit` print them. */
export function auditRecordDetails(record: SecurityAuditRecord): string {
  return [record.category, record.action, record.outcome, record.risk, record.source, record.scope, record.subject].filter(Boolean).join(" · ");
}

function auditUsage(language: UiLanguage): string {
  return localize(language,
    `用法：xiu audit [approvals|credentials] [json] [条数 1–${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}]，只读列出当前工作区的本机安全审计记录；json 输出一份 JSON 文档。`,
    `Usage: xiu audit [approvals|credentials] [json] [limit 1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}] lists this workspace's local security-audit records read-only; json prints one JSON document.`);
}

/** Returns the process exit code: 0 listed (even when empty), 1 usage error, untrusted workspace or unreadable ledger. */
export async function runAuditCommand(args: readonly string[], options: AuditCliOptions): Promise<number> {
  const { cwd, language } = options;
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  let category: SecurityAuditCategory | undefined;
  let json = false;
  let limit: number | undefined;
  for (const argument of args) {
    const word = argument.toLowerCase();
    if (CATEGORIES[word] && category === undefined) category = CATEGORIES[word];
    else if (word === "json" && !json) json = true;
    else if (/^\d{1,3}$/.test(word) && limit === undefined && Number(word) >= 1 && Number(word) <= MAX_LIMIT) limit = Number(word);
    else { stderr(auditUsage(language)); return 1; }
  }
  const trusted = await (options.isTrusted ?? isWorkspaceTrusted)(cwd);
  if (!trusted) {
    stderr(localize(language,
      "工作区尚未信任，不能读取它的审计记录。请先交互运行一次 xiu 并确认信任，或在你掌控的检出目录上显式加 --trust-workspace。",
      "This workspace is not trusted yet, so its audit records are not read. Run xiu interactively once and confirm trust, or pass --trust-workspace explicitly on a checkout you control."));
    return 1;
  }
  const audit = options.audit ?? new SecurityAuditLog(undefined, cwd);
  try {
    const result = await audit.read({ ...(category ? { category } : {}), limit: limit ?? DEFAULT_LIMIT, workspaceOnly: true });
    if (json) {
      stdout(JSON.stringify({ workspace: cwd, ...(category ? { category } : {}), limit: limit ?? DEFAULT_LIMIT, records: result.records, truncated: result.truncated, invalidLines: result.invalidLines }, null, 2));
      return 0;
    }
    const lines = [localize(language,
      "本工作区的本机安全审计（不包含命令正文、Prompt、文件内容或凭证）",
      "Local security audit of this workspace (excludes command text, prompts, file contents, and credentials)")];
    if (!result.records.length) lines.push(localize(language, "暂无匹配记录。", "No matching records."));
    else for (const record of result.records) lines.push(`${record.timestamp} · ${auditRecordDetails(record)}`);
    if (result.truncated) lines.push(localize(language, `仅显示最近 ${limit ?? DEFAULT_LIMIT} 条匹配记录。`, `Showing only the ${limit ?? DEFAULT_LIMIT} most recent matching records.`));
    if (result.invalidLines) lines.push(localize(language, `忽略了 ${result.invalidLines} 条损坏记录。`, `Ignored ${result.invalidLines} invalid record(s).`));
    stdout(lines.join("\n"));
    return 0;
  } catch (error) {
    stderr(`${localize(language, "读取安全审计失败", "Could not read security audit")}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
