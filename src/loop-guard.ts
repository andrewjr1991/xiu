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
  private blocks = 0;
  private usefulCallsSinceBlock = 0;

  reset(): void {
    this.history = [];
    this.blocks = 0;
    this.usefulCallsSinceBlock = 0;
  }

  observe(name: string, input: Record<string, unknown>): LoopObservation {
    const signature = toolCallSignature(name, input);
    this.history.push(signature);
    if (this.history.length > 24) this.history.shift();

    const repeatedCall = this.history.length >= 3
      && this.history.slice(-3).every((item) => item === signature);
    const repeatedCycle = this.hasRepeatedCycle();
    if (!repeatedCall && !repeatedCycle) {
      this.usefulCallsSinceBlock++;
      if (this.usefulCallsSinceBlock >= 4) this.blocks = 0;
      return { blocked: false, abort: false };
    }

    this.blocks++;
    this.usefulCallsSinceBlock = 0;
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
