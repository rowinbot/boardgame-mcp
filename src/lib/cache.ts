import { LRUCache } from 'lru-cache';

export interface CacheLookup<T> {
  value: T;
  /** True when the entry was served past its TTL because the upstream failed. */
  stale: boolean;
  ageSeconds: number;
}

interface Stored<T> {
  value: T;
  storedAt: number;
}

/**
 * A TTL cache that keeps expired entries around instead of evicting them.
 *
 * The point is the failure path. When recommend.games 503s, which it does
 * readily, an answer from forty minutes ago plus an honest note about its age is
 * far more useful to a calling model than an error. Entries are only dropped
 * when the cache is full, so "expired" and "gone" stay separate ideas.
 *
 * Backed by lru-cache. Two of its options carry the whole behaviour:
 *   allowStale          lets an expired entry be read back at all
 *   noDeleteOnStaleGet  keeps it after that read, so a run of upstream failures
 *                       is served from one entry rather than draining it
 *
 * Age is tracked in the stored value rather than read from getRemainingTTL,
 * which reports 0 once an entry expires and so cannot say how stale it is.
 */
export class StaleWhileErrorCache<T> {
  private readonly lru: LRUCache<string, Stored<T>>;

  constructor(
    private readonly ttlMs: number,
    maxEntries = 500,
    private readonly now: () => number = () => Date.now(),
  ) {
    // lru-cache owns eviction; TTL stays here on purpose.
    //
    // Its ttl option reads the real clock and offers no way to inject one, so
    // under a faked clock an entry that should be forty minutes stale still
    // looks fresh. Freshness is a decision this cache has to make deterministically
    // in tests, so it is computed from storedAt against the injected now().
    // lru-cache keeps what it is genuinely better at: bounded size and LRU order.
    this.lru = new LRUCache<string, Stored<T>>({ max: maxEntries });
  }

  /** A fresh entry, or undefined. Never returns stale data. */
  getFresh(key: string): CacheLookup<T> | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.ttlMs) return undefined;
    return this.lookup(entry, false);
  }

  /** Any entry, fresh or not. Only for use on an upstream failure path. */
  getStale(key: string): CacheLookup<T> | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.storedAt;
    return this.lookup(entry, ageMs > this.ttlMs);
  }

  set(key: string, value: T): void {
    this.lru.set(key, { value, storedAt: this.now() });
  }

  get size(): number {
    return this.lru.size;
  }

  private lookup(entry: Stored<T>, stale: boolean): CacheLookup<T> {
    return {
      value: entry.value,
      stale,
      ageSeconds: Math.round((this.now() - entry.storedAt) / 1000),
    };
  }
}
