function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function toolCallSignature(name: string, input: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(stableValue(input))}`;
}

export interface LoopObservation {
  blocked: boolean;
  abort: boolean;
  reason?: string;
}

export class ToolLoopGuard {
  private history: string[] = [];
  private counts = new Map<string, number>();
  private blocks = 0;

  observe(name: string, input: Record<string, unknown>): LoopObservation {
    const signature = toolCallSignature(name, input);
    const count = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, count);
    this.history.push(signature);
    if (this.history.length > 24) this.history.shift();

    const repeatedCall = count >= 3;
    const repeatedCycle = this.hasRepeatedCycle();
    if (!repeatedCall && !repeatedCycle) return { blocked: false, abort: false };

    this.blocks++;
    const pattern = repeatedCycle ? "the same tool-call cycle" : "the same tool call";
    return {
      blocked: true,
      abort: this.blocks >= 3,
      reason: `Loop guard blocked ${pattern}. Summarize what is already known and choose a materially different approach.`,
    };
  }

  private hasRepeatedCycle(): boolean {
    for (let size = 1; size <= 4; size++) {
      const needed = size * 3;
      if (this.history.length < needed) continue;
      const tail = this.history.slice(-needed);
      const pattern = tail.slice(0, size);
      if (tail.every((item, index) => item === pattern[index % size])) return true;
    }
    return false;
  }
}
