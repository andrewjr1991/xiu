export interface RequestCacheStats {
  hits: number;
  misses: number;
  joins: number;
  entries: number;
}
interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

/**
 * Bounded in-memory cache for explicitly side-effect-free Provider metadata.
 * Agent completions and media generation must never use this coordinator.
 */
export class SafeRequestCache {
  private readonly completed = new Map<string, CachedValue<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private joins = 0;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maximumEntries = 100,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("Cache TTL must be non-negative");
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) throw new Error("Cache entry limit must be positive");
  }

  async run<T>(key: string, operation: () => Promise<T>, cacheCompleted = true): Promise<T> {
    if (!key) throw new Error("Cache key is required");
    const cached = this.completed.get(key) as CachedValue<T> | undefined;
    if (cached && cached.expiresAt > this.now()) {
      this.hits++;
      this.completed.delete(key);
      this.completed.set(key, cached);
      return cached.value;
    }
    if (cached) this.completed.delete(key);
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing) {
      this.joins++;
      return existing;
    }
    this.misses++;
    const pending = operation();
    this.pending.set(key, pending);
    try {
      const value = await pending;
      if (cacheCompleted && this.ttlMs > 0) {
        this.completed.set(key, { expiresAt: this.now() + this.ttlMs, value });
        while (this.completed.size > this.maximumEntries) this.completed.delete(this.completed.keys().next().value!);
      }
      return value;
    } finally {
      this.pending.delete(key);
    }
  }

  clear(): void {
    this.completed.clear();
  }

  stats(): RequestCacheStats {
    return { hits: this.hits, misses: this.misses, joins: this.joins, entries: this.completed.size };
  }
}
