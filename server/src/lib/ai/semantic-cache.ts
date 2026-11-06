/**
 * Epic #647 / Issue #651 — Semantic Response Cache.
 *
 * Caches LLM responses keyed by query embedding similarity. On cache hit
 * (cosine similarity ≥ threshold), returns the stored response without
 * calling the provider. Reduces cost and latency for repeated/similar queries.
 *
 * #1844 — made safe to switch on for a trial, and still OFF by default:
 *   - every entry is scoped to the model, the system-prompt hash, the project,
 *     the project's CONTENT VERSION (`projects/content-version.ts`), the caller
 *     and the conversation so far. An answer computed before a re-ingest is
 *     never served after it;
 *   - an exact match on the normalised question text is tried first, and the
 *     similarity path needs ≥ 0.97 by default (it was 0.92; measured semantic
 *     caches serve a wrong answer for roughly 3–7% of hits at 0.93);
 *   - the caller never stores a turn whose answer used a tool
 *     ({@link shouldStoreTurn}), because such an answer depends on what the
 *     tools retrieved.
 * Why chat answers are not kept in the vector store at all:
 * docs/decisions/0022-no-chat-answers-in-the-vector-store.md.
 *
 * What `systemPromptHash` covers (#1844's open question, traced in
 * `routes/ai.ts`): every system-role message of the turn — the persona and
 * skills, any compaction summary, and the auto-RAG context retrieved for THIS
 * question from the project's documents. So it does vary with the project's
 * document context, but not with its code (chat reads code only through
 * tools) and not with the conversation history (user and assistant turns are
 * not system messages). The content version and the no-tools rule close the
 * first gap, and the conversation hash in the scope closes the second.
 *
 * Config:
 *   SEMANTIC_CACHE_ENABLED   — "1" to enable (default "0")
 *   SEMANTIC_CACHE_THRESHOLD — similarity threshold (default 0.97)
 *   SEMANTIC_CACHE_TTL_MINUTES — TTL in minutes (default 30)
 */
import crypto from "node:crypto";
import { createChildLogger } from "../logger.js";
import {
  getProjectContentVersion,
  type ProjectContentVersion,
} from "../projects/content-version.js";
import { messageText, type ChatMessage } from "./types.js";

const log = createChildLogger("semantic-cache");

export interface CacheHit {
  response: string;
  similarity: number;
  cachedAt: Date;
  /** #1844 — `exact`: the same normalised question; `similar`: an embedding neighbour. */
  match: "exact" | "similar";
}

/** #1844 — everything an answer depends on besides the question itself. */
export interface SemanticCacheScope {
  model: string;
  systemPromptHash: string;
  projectId: string | null;
  /** The project's content version key; a fixed marker for a session with no project. */
  contentVersion: string;
  /** The caller's access scope (their user id). */
  callerScope: string;
  /** Hash of the conversation before this question (its user and assistant turns). */
  conversationHash: string;
}

/** #1844 — the question, as text (for the exact match) and as its embedding. */
export interface SemanticQuery {
  text: string;
  embedding: number[];
}

export interface CacheEntry extends SemanticCacheScope {
  id: string;
  embedding: number[];
  normalizedText: string;
  response: string;
  createdAt: Date;
}

/** #1844 — the content version recorded for a session with no project. */
export const UNSCOPED_CONTENT_VERSION = "unscoped";

/** #1844 — the default similarity threshold: precision over recall. */
export const DEFAULT_SEMANTIC_CACHE_THRESHOLD = 0.97;

/** #1844 — the question as the exact match compares it: NFKC, lower case, whitespace collapsed. */
export function normalizeQuery(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
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
    threshold:
      parseFloat(
        process.env.SEMANTIC_CACHE_THRESHOLD || String(DEFAULT_SEMANTIC_CACHE_THRESHOLD),
      ) || DEFAULT_SEMANTIC_CACHE_THRESHOLD,
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
   * Look up a cached response for `query` within `scope`: an exact match on the
   * normalised question first, then the most similar embedding at or above the
   * threshold. Returns null on a miss.
   */
  async lookup(query: SemanticQuery, scope: SemanticCacheScope): Promise<CacheHit | null> {
    if (!this.config.enabled) return null;

    const now = Date.now();
    const ttlMs = this.config.ttlMinutes * 60 * 1000;
    const normalized = normalizeQuery(query.text);
    const live = this.entries.filter(
      (e) => sameScope(e, scope) && now - e.createdAt.getTime() <= ttlMs,
    );

    // Newest first, so a re-stored answer wins over an older one.
    const exact = [...live].reverse().find((e) => e.normalizedText === normalized);
    if (exact) {
      log.info("Cache hit", { model: scope.model, match: "exact", projectId: scope.projectId });
      return { response: exact.response, similarity: 1, cachedAt: exact.createdAt, match: "exact" };
    }

    let bestHit: CacheHit | null = null;
    let bestSimilarity = 0;
    for (const entry of live) {
      const similarity = cosineSimilarity(query.embedding, entry.embedding);
      if (similarity >= this.config.threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestHit = {
          response: entry.response,
          similarity,
          cachedAt: entry.createdAt,
          match: "similar",
        };
      }
    }

    if (bestHit) {
      log.info("Cache hit", {
        model: scope.model,
        match: "similar",
        similarity: bestSimilarity.toFixed(4),
        projectId: scope.projectId,
      });
    }

    return bestHit;
  }

  /**
   * Store a response in the cache under `scope`.
   */
  async store(query: SemanticQuery, scope: SemanticCacheScope, response: string): Promise<void> {
    if (!this.config.enabled) return;

    // Evict expired entries
    this.evictExpired();

    // Enforce maxEntries cap — evict oldest entries first
    while (this.entries.length >= this.config.maxEntries) {
      this.entries.shift();
    }

    const entry: CacheEntry = {
      id: crypto.randomUUID(),
      embedding: query.embedding,
      normalizedText: normalizeQuery(query.text),
      model: scope.model,
      systemPromptHash: scope.systemPromptHash,
      projectId: scope.projectId,
      contentVersion: scope.contentVersion,
      callerScope: scope.callerScope,
      conversationHash: scope.conversationHash,
      response,
      createdAt: new Date(),
    };

    this.entries.push(entry);
    log.debug("Stored cache entry", {
      id: entry.id,
      model: scope.model,
      projectId: scope.projectId,
    });
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

/** #1844 — an entry answers a lookup only within the very same scope. */
function sameScope(e: SemanticCacheScope, s: SemanticCacheScope): boolean {
  return (
    e.model === s.model &&
    e.systemPromptHash === s.systemPromptHash &&
    e.projectId === s.projectId &&
    e.contentVersion === s.contentVersion &&
    e.callerScope === s.callerScope &&
    e.conversationHash === s.conversationHash
  );
}

/**
 * #1844 — whether a finished turn may be stored: never one that called any
 * tool (its answer depends on what the tools retrieved), and never a response
 * {@link shouldSkipCache} rejects.
 */
export function shouldStoreTurn(turn: { response: string; toolCallCount: number }): boolean {
  return turn.toolCallCount === 0 && !shouldSkipCache(turn.response);
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/**
 * #1844 — the scope a chat turn's answer is cached under, or `null` when it
 * must not be cached at all (the project's content version is incomplete).
 * `messages` is the turn's prompt, ending with the question.
 */
export async function buildSemanticCacheScope(input: {
  model: string;
  messages: readonly ChatMessage[];
  projectId: string | null;
  userId: string;
  version?: (projectId: string) => Promise<ProjectContentVersion>;
}): Promise<SemanticCacheScope | null> {
  let contentVersion = UNSCOPED_CONTENT_VERSION;
  if (input.projectId) {
    const version = await (input.version ?? getProjectContentVersion)(input.projectId);
    if (!version.complete) return null;
    contentVersion = version.key;
  }
  const system = input.messages.filter((m) => m.role === "system");
  // The conversation before the question: every non-system turn but the last.
  const turns = input.messages.filter((m) => m.role !== "system").slice(0, -1);
  return {
    model: input.model,
    systemPromptHash: sha256(system.map((m) => messageText(m)).join("\n")),
    projectId: input.projectId,
    contentVersion,
    callerScope: input.userId,
    conversationHash: sha256(JSON.stringify(turns.map((m) => [m.role, messageText(m)]))),
  };
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
