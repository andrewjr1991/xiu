/**
 * A timestamp as the user's local `YYYY-MM-DD HH:mm:ss`, for lists and status lines people read:
 * session lists, audit records, backups, the update cache. Machine output (`--json`, logs) keeps
 * ISO strings. Anything unparsable is returned as it came.
 */
export function formatLocalTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
