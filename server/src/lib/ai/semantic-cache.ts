/**
 * Epic #647 / Issue #651 — Semantic Response Cache.
 *
 * Caches LLM responses keyed by query embedding similarity. On cache hit
 * (cosine similarity ≥ threshold), returns the stored response without
 * calling the provider. Reduces cost and latency for repeated/similar queries.
 *
 * Config:
 *   SEMANTIC_CACHE_ENABLED   — "1" to enable (default "0")
 *   SEMANTIC_CACHE_THRESHOLD — similarity threshold (default 0.92)
 *   SEMANTIC_CACHE_TTL_MINUTES — TTL in minutes (default 30)
 */
import crypto from "node:crypto";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("semantic-cache");

export interface CacheHit {
  response: string;
  similarity: number;
  cachedAt: Date;
}

export interface CacheEntry {
  id: string;
  embedding: number[];
  model: string;
  systemPromptHash: string;
  projectId: string | null;
  response: string;
  createdAt: Date;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<{ vectors: number[][]; dimension: number; model: string }>;
}

export interface SemanticCacheConfig {
  enabled: boolean;
  threshold: number;
  ttlMinutes: number;
  maxEntries: number;
}

export function loadCacheConfig(): SemanticCacheConfig {
  return {
    enabled: process.env.SEMANTIC_CACHE_ENABLED === "1",
    threshold: parseFloat(process.env.SEMANTIC_CACHE_THRESHOLD || "0.92") || 0.92,
    ttlMinutes: parseInt(process.env.SEMANTIC_CACHE_TTL_MINUTES || "30", 10) || 30,
    maxEntries: parseInt(process.env.SEMANTIC_CACHE_MAX_ENTRIES || "1000", 10) || 1000,
  };
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Semantic Response Cache — stores and retrieves LLM responses based on
 * embedding similarity of the input query.
 */
export class SemanticResponseCache {
  private readonly entries: CacheEntry[] = [];
  private readonly config: SemanticCacheConfig;

  constructor(config?: Partial<SemanticCacheConfig>) {
    const defaults = loadCacheConfig();
    this.config = { ...defaults, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Look up a cached response by embedding similarity.
   * Returns the best match above threshold, or null.
   */
  async lookup(
    embedding: number[],
    modelId: string,
    systemPromptHash: string,
    projectId?: string,
  ): Promise<CacheHit | null> {
    if (!this.config.enabled) return null;

    const now = Date.now();
    const ttlMs = this.config.ttlMinutes * 60 * 1000;
    let bestHit: CacheHit | null = null;
    let bestSimilarity = 0;

    for (const entry of this.entries) {
      // Filter by model + systemPromptHash + projectId
      if (entry.model !== modelId) continue;
      if (entry.systemPromptHash !== systemPromptHash) continue;
      if ((entry.projectId ?? undefined) !== (projectId ?? undefined)) continue;

      // Check TTL
      if (now - entry.createdAt.getTime() > ttlMs) continue;

      const similarity = cosineSimilarity(embedding, entry.embedding);
      if (similarity >= this.config.threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestHit = {
          response: entry.response,
          similarity,
          cachedAt: entry.createdAt,
        };
      }
    }

    if (bestHit) {
      log.info("Cache hit", {
        model: modelId,
        similarity: bestSimilarity.toFixed(4),
        projectId,
      });
    }

    return bestHit;
  }

  /**
   * Store a response in the cache.
   */
  async store(
    embedding: number[],
    modelId: string,
    systemPromptHash: string,
    response: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.config.enabled) return;

    // Evict expired entries
    this.evictExpired();

    // Enforce maxEntries cap — evict oldest entries first
    while (this.entries.length >= this.config.maxEntries) {
      this.entries.shift();
    }

    const entry: CacheEntry = {
      id: crypto.randomUUID(),
      embedding,
      model: modelId,
      systemPromptHash,
      projectId: projectId ?? null,
      response,
      createdAt: new Date(),
    };

    this.entries.push(entry);
    log.debug("Stored cache entry", { id: entry.id, model: modelId, projectId });
  }

  /**
   * Remove expired entries.
   */
  private evictExpired(): void {
    const now = Date.now();
    const ttlMs = this.config.ttlMinutes * 60 * 1000;
    let i = 0;
    while (i < this.entries.length) {
      if (now - this.entries[i].createdAt.getTime() > ttlMs) {
        this.entries.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  /**
   * Clear the entire cache (for testing).
   */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Number of entries currently in the cache.
   */
  get size(): number {
    return this.entries.length;
  }
}

/** Determines if a response should NOT be cached. */
export function shouldSkipCache(response: string): boolean {
  // Never cache responses containing tool call results
  if (response.includes('"tool"') && response.includes('"args"')) return true;
  // Never cache safety redactions
  if (response.includes("[REDACTED]") || response.includes("[SAFETY_REDACTED]")) return true;
  return false;
}

// Singleton
let singleton: SemanticResponseCache | null = null;

export function getSemanticCache(): SemanticResponseCache {
  if (!singleton) singleton = new SemanticResponseCache();
  return singleton;
}

export function __resetSemanticCacheSingleton(): void {
  singleton = null;
}
