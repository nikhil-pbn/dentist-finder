/**
 * Minimal in-process TTL cache.
 *
 * Deliberately not Redis and not the Next.js data cache: version 1 only needs
 * to stop a single server instance from re-asking the public OSM endpoints the
 * same question within a few minutes. Entries expire by time and the map is
 * bounded by insertion order, so memory cannot grow without limit.
 *
 * Limitation (see README): the cache lives in one process, so it is not shared
 * across serverless instances or across deployments.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    // Re-inserting moves the key to the end, keeping eviction order meaningful.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
