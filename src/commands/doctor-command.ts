import { type DoctorReport, doctorHasHardFailure, formatDoctorReport } from "../doctor.js";
import { localize, type UiLanguage } from "../i18n.js";

/**
 * `xiu doctor [json]`: the one-shot diagnostics report for terminals, scripts and issue reports.
 * Read-only. `json` prints the same already-redacted report as one JSON document (both languages,
 * every section and item) so CI can read `status` and the item levels without parsing text. Any
 * other word is a usage error: before, `xiu doctor <typo>` was sent to the model as a task.
 */

export interface DoctorCliOptions {
  language: UiLanguage;
  collect: () => Promise<DoctorReport>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function doctorUsage(language: UiLanguage): string {
  return localize(language,
    "用法：xiu doctor [json]，输出只读诊断报告；json 输出同一份报告的 JSON 文档（含中英文），存在错误时两种形式都返回 1。",
    "Usage: xiu doctor [json] prints the read-only diagnostics report; json prints the same report as one JSON document (both languages); both exit 1 when the report has a failure.");
}

/** The JSON document `xiu doctor json` prints: the redacted report as collected, stable key order, two-space indent. */
export function serializeDoctorReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

/** Returns the process exit code: 0 when the report has no failure, 1 on a failure or a usage error. */
export async function runDoctorCommand(args: readonly string[], options: DoctorCliOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  let json = false;
  for (const argument of args) {
    if (argument.toLowerCase() === "json" && !json) json = true;
    else { stderr(doctorUsage(options.language)); return 1; }
  }
  const report = await options.collect();
  stdout(json ? serializeDoctorReport(report) : `${formatDoctorReport(report, options.language)}\n`);
  return doctorHasHardFailure(report) ? 1 : 0;
}
