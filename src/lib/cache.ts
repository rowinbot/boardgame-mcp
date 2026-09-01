export interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export interface CacheLookup<T> {
  value: T;
  /** True when the entry was served past its TTL because the upstream failed. */
  stale: boolean;
  ageSeconds: number;
}

/**
 * A TTL cache that keeps expired entries around instead of evicting them.
 *
 * The point is the failure path. When recommend.games 503s — which it does
 * readily — an answer from forty minutes ago plus an honest note about its age
 * is far more useful to a calling model than an error. Entries are only dropped
 * when the cache is full, so "expired" and "gone" stay separate ideas.
 */
export class StaleWhileErrorCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A fresh entry, or undefined. Never returns stale data. */
  getFresh(key: string): CacheLookup<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.storedAt;
    if (ageMs > this.ttlMs) return undefined;
    return { value: entry.value, stale: false, ageSeconds: Math.round(ageMs / 1000) };
  }

  /** Any entry, fresh or not. Only for use on an upstream failure path. */
  getStale(key: string): CacheLookup<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.storedAt;
    return { value: entry.value, stale: ageMs > this.ttlMs, ageSeconds: Math.round(ageMs / 1000) };
  }

  set(key: string, value: T): void {
    // Map preserves insertion order, so the first key is the oldest write.
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, storedAt: this.now() });
  }

  get size(): number {
    return this.entries.size;
  }
}
