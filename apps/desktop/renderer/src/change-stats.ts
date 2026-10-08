import type { TaskChangeEntry } from "../../../../src/task-changes.js";

export function changeStats(change: TaskChangeEntry) {
  if (change.stats) return { ...change.stats, approximate: !change.stats.exact };
  const hunks = [...(change.preview ?? "").matchAll(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)]
    .map(match => ({ deletions: Number(match[1] ?? 1), additions: Number(match[2] ?? 1) }));
  // Older snapshots retained full replacement spans in their hunk header even
  // when the body was cut before additions. These are estimates, not LCS counts.
  if (hunks.length && hunks.every(hunk => Object.values(hunk).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 262_144))) {
    return { additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0), deletions: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0), approximate: true };
  }
  const lines = change.preview?.split(/\r?\n/) ?? [];
  return {
    additions: lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length,
    approximate: true,
  };
}
