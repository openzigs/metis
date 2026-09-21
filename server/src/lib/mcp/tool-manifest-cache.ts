/**
 * Epic #502 / Issue #506 — Tool manifest caching and deduplication.
 *
 * Caches the formatted tool manifest to avoid re-generating it on every
 * agent loop iteration. Cache key = hash of sorted tool IDs + manifest mode.
 *
 * - TTL: 5 minutes (configurable)
 * - Invalidated when tools added/removed or schema updated
 * - Metrics: cache hit rate logged
 */
import crypto from "node:crypto";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("tool-manifest-cache");

/** Default TTL in milliseconds (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ToolManifestCacheOptions {
  /** Cache TTL in milliseconds. Default: 300000 (5 min). */
  ttlMs?: number;
}

interface CacheEntry {
  content: string;
  createdAt: number;
  toolCount: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  invalidations: number;
  hitRate: number;
}

export class ToolManifestCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(opts: ToolManifestCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Get cached manifest or return null if not cached/expired.
   */
  get(toolIds: string[], mode: string): string | null {
    const key = this.computeKey(toolIds, mode);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.content;
  }

  /**
   * Store a manifest in the cache.
   */
  set(toolIds: string[], mode: string, content: string): void {
    const key = this.computeKey(toolIds, mode);
    this.cache.set(key, {
      content,
      createdAt: Date.now(),
      toolCount: toolIds.length,
    });
  }

  /**
   * Invalidate all cached entries.
   */
  invalidate(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.invalidations += size;
    if (size > 0) {
      log.info("Tool manifest cache invalidated", { entriesCleared: size });
    }
  }

  /**
   * Invalidate entries that include specific tool IDs.
   */
  invalidateForTools(_toolIds: string[]): void {
    // Simple approach: invalidate everything since the key includes all tool IDs
    // A more efficient implementation would maintain a reverse index
    this.invalidate();
  }

  /**
   * Get cache metrics.
   */
  getMetrics(): CacheMetrics {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset metrics (useful for testing).
   */
  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
  }

  /**
   * Get current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Compute cache key from sorted tool IDs and manifest mode.
   */
  private computeKey(toolIds: string[], mode: string): string {
    const sorted = [...toolIds].sort();
    const payload = `${mode}:${sorted.join(",")}`;
    return crypto.createHash("sha256").update(payload).digest("hex");
  }
}
