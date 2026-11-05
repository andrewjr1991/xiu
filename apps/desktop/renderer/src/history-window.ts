export const HISTORY_ROUND_BATCH = 50;
export type HistoryWindow = { start: number; end: number; total: number };

export function latestHistoryWindow(total: number): HistoryWindow {
  return { start: Math.max(0, total - HISTORY_ROUND_BATCH), end: total, total };
}

/** Keep already displayed rounds on growth; clamp safely if a snapshot shrinks. */
export function normalizeHistoryWindow(window: HistoryWindow, total: number): HistoryWindow {
  if (!total || !window.total) return latestHistoryWindow(total);
  const end = window.end === window.total ? total : Math.min(window.end, total);
  const width = Math.max(1, window.end - window.start);
  return { start: Math.min(window.start, Math.max(0, end - width)), end, total };
}

export function historyWindowForRound(total: number, round: number): HistoryWindow {
  if (!total) return latestHistoryWindow(0);
  const index = Math.max(0, Math.min(total - 1, Math.trunc(round)));
  const start = Math.min(Math.floor(index / HISTORY_ROUND_BATCH) * HISTORY_ROUND_BATCH, Math.max(0, total - HISTORY_ROUND_BATCH));
  return { start, end: Math.min(total, start + HISTORY_ROUND_BATCH), total };
}

export function expandHistoryWindow(window: HistoryWindow, direction: "earlier" | "later"): HistoryWindow {
  return direction === "earlier"
    ? { ...window, start: Math.max(0, window.start - HISTORY_ROUND_BATCH) }
    : { ...window, end: Math.min(window.total, window.end + HISTORY_ROUND_BATCH) };
}
