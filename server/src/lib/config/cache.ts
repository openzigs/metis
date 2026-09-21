/**
 * Issue #255 — `ConfigCache` is the in-memory store backing every
 * `ConfigService.get()` call for tunable values.
 *
 * Why a dedicated class? The cache is dirt-simple (Map + invalidation), but
 * splitting it out keeps `ConfigService` focused on tier semantics and gives
 * the unit tests a small object to assert against directly.
 *
 * Semantics
 *   - No TTL. Entries are only invalidated via `invalidate(key)` or
 *     `invalidateAll()` after a write or on explicit refresh.
 *   - `set(key, value)` stamps `fetchedAt = Date.now()` so callers can
 *     surface "last updated N seconds ago" if they want to.
 *   - `get(key)` returns the raw entry; `getValue(key)` returns the value or
 *     `undefined` for callers that only need the latest write.
 */
export interface CacheEntry {
  value: string;
  fetchedAt: number;
}

export class ConfigCache {
  private readonly store = new Map<string, CacheEntry>();

  set(key: string, value: string): void {
    this.store.set(key, { value, fetchedAt: Date.now() });
  }

  get(key: string): CacheEntry | undefined {
    return this.store.get(key);
  }

  getValue(key: string): string | undefined {
    return this.store.get(key)?.value;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidateAll(): void {
    this.store.clear();
  }

  /** Snapshot of every key currently cached — for tests and debug endpoints. */
  keys(): string[] {
    return [...this.store.keys()];
  }

  size(): number {
    return this.store.size;
  }
}
