const INTERNAL_PREFIXES = [
  "Compacted session context", "ACTIVE TASK CONTRACT", "User steering received while the task was running",
  "Task-contract completion audit", "Completion gate:", "Plan gate:",
];

export function isUserRequirement(content: string): boolean {
  return Boolean(content.trim()) && !INTERNAL_PREFIXES.some((prefix) => content.trim().startsWith(prefix));
}

/** Recent conversation text only: never permissions, restored verification or execution authority. */
export function retainUserRequirements(recentNewestFirst: string[], previous: unknown, tokens: (text: string) => number): string[] {
  const prior = Array.isArray(previous) ? previous.slice(-6).filter((item): item is string => typeof item === "string").reverse() : [];
  const selected: string[] = [];
  const seen = new Set<string>();
  let totalTokens = 0;
  for (const source of [...recentNewestFirst, ...prior]) {
    const text = source.trim();
    if (!text) continue;
    const marker = "\n...[middle omitted]...\n";
    const bounded = text.length > 24_000 ? `${text.slice(0, 16_000)}${marker}${text.slice(-(8_000 - marker.length))}` : text;
    if (seen.has(bounded)) continue;
    const estimated = tokens(bounded) + 4; // Same per-message allowance as conversation estimation.
    if (selected.length && totalTokens + estimated > 16_000) break;
    seen.add(bounded);
    selected.push(bounded);
    totalTokens += estimated;
    if (totalTokens >= 16_000 || selected.length >= 6) break;
  }
  return selected.reverse();
}

export function formatUserRequirements(requirements: string[]): string {
  return requirements.map((message, index) => `[User requirement ${index + 1}]\n${message}`).join("\n\n") || "None recorded.";
}
