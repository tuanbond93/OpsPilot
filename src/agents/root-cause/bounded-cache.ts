export const ROOT_CAUSE_CACHE_MAX_ENTRIES = 128;

/**
 * BoundedCache implements a simple LRU cache with a fixed maximum number of entries.
 * It provides basic Map-like methods (has, get, set, clear) and diagnostics.
 * Private data such as cache keys or payloads are never logged.
 */
export class BoundedCache<K, V> {
  private cache = new Map<K, V>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(private maxEntries: number = ROOT_CAUSE_CACHE_MAX_ENTRIES) {}

  /**
   * Checks if the cache contains the given key.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Retrieves the value for a key, refreshing its recentness.
   * If the key is not present, returns undefined.
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      this.missCount++;
      return undefined;
    }
    const value = this.cache.get(key) as V;
    this.cache.delete(key);
    this.cache.set(key, value);
    this.hitCount++;
    return value;
  }

  /**
   * Inserts a value into the cache. If the cache exceeds the max size, the
   * least recently used entry (the first inserted) is evicted.
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    // Evict if we exceeded the max entries
    if (this.cache.size > this.maxEntries) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) { this.cache.delete(lruKey); this.evictionCount++; }
    }
  }

  /**
   * Clears all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  /**
   * Returns diagnostics about the cache state. No private data is included.
   */
  diagnostics(): { size: number; hitCount: number; missCount: number; evictionCount: number } {
    return {
      size: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
    };
  }
}
