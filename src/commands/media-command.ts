import chalk from "chalk";
import { localize, type UiLanguage } from "../i18n.js";
import { MediaOperationStore, type MediaOperationRecord } from "../media-operations.js";

export interface MediaCommandContext {
  /** Workspace whose media operation records are listed. */
  cwd: string;
  language: UiLanguage;
  /** Lists the most recent records; defaults to the workspace store and is injectable for tests. */
  listRecords?: (limit: number) => Promise<MediaOperationRecord[]>;
}

/**
 * `/media`, moved out of the interactive loop in cli.ts: the read-only list of media generation and recovery
 * records with the recovery hint. Returns false for anything else. Output is unchanged; nothing is submitted.
 */
export async function handleMediaCommand(task: string, ctx: MediaCommandContext): Promise<boolean> {
  if (task !== "/media") return false;
  const { cwd, language } = ctx;
  const listRecords = ctx.listRecords ?? ((limit: number) => new MediaOperationStore(cwd).list(limit));
  const records = await listRecords(30);
  if (!records.length) {
    console.log(chalk.dim(localize(language, "当前项目还没有媒体生成记录。\n", "This project has no media generation records yet.\n")));
    return true;
  }
  const statusLabel = (record: MediaOperationRecord): string => {
    const labels: Record<MediaOperationRecord["status"], [string, string]> = {
      submitting: ["提交结果未知", "submission unknown"],
      submitted: ["等待生成", "generation pending"],
      asset_ready: ["等待下载", "download pending"],
      completed: ["已完成", "completed"],
      ambiguous: ["结果不明确", "ambiguous"],
      failed: ["已失败", "failed"],
    };
    return localize(language, ...labels[record.status]);
  };
  console.log(chalk.cyan(localize(language, "媒体生成与恢复任务", "Media generation and recovery tasks")));
  for (const record of records) {
    const details = [
      record.kind === "image" ? localize(language, "图片", "image") : record.kind === "video" ? localize(language, "视频", "video") : localize(language, "音频", "audio"),
      statusLabel(record),
      `${record.providerId}/${record.model}`,
      record.taskId ? `task ${record.taskId}` : undefined,
      record.savedPath ? localize(language, `已保存 ${record.savedPath}`, `saved ${record.savedPath}`) : undefined,
    ].filter(Boolean).join(" · ");
    const color = record.status === "completed" ? chalk.green : record.status === "failed" || record.status === "ambiguous" || record.status === "submitting" ? chalk.yellow : chalk.cyan;
    console.log(`${color(`[${record.requestId.slice(0, 8)}]`)} ${details}`);
  }
  console.log(chalk.dim(localize(language,
    "\n需要恢复时，请输入“恢复媒体请求 <ID> 到 <工作区路径>”。恢复只会复用缓存、继续轮询或重新下载，不会创建新的付费请求。\n",
    "\nTo recover one, enter “resume media request <ID> to <workspace path>”. Recovery only reuses cache, continues polling, or retries a download; it never creates a new billable request.\n",
  )));
  return true;
}
