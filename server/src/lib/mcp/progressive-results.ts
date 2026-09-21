/**
 * Epic #515 / Issue #518 — Progressive tool result disclosure with
 * summary + expand pattern.
 *
 * Tool results exceeding a token threshold are automatically summarized.
 * The summary includes result count, key highlights, and instruction to
 * call `get_full_result` to retrieve the full cached result by ID.
 *
 * - Results cached with TTL (5 minutes default) keyed by execution ID
 * - Small results (<threshold) returned verbatim
 * - Configurable via TOOL_RESULT_SUMMARY_THRESHOLD env var
 */
import { randomUUID } from "node:crypto";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("progressive-results");

/** Characters per token approximation. */
const CHARS_PER_TOKEN = 4;

/** Default threshold in tokens above which results are summarized. */
const DEFAULT_THRESHOLD_TOKENS = 500;

/** Default TTL for cached results in milliseconds (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Default max tokens for the summary output. */
const DEFAULT_SUMMARY_MAX_TOKENS = 100;

/** Fields always preserved in JSON result summaries. */
const PRESERVE_FIELDS = ["id", "url", "name", "title", "status", "error", "message", "type"];

export interface ProgressiveResultOptions {
  /** Token threshold for triggering summarization. Default: 500. */
  thresholdTokens?: number;
  /** TTL for cached results in milliseconds. Default: 300000 (5 min). */
  ttlMs?: number;
  /** Maximum summary output in tokens. Default: 100. */
  summaryMaxTokens?: number;
}

export interface CachedResult {
  /** Full result content. */
  content: string;
  /** Tool name that produced this result. */
  toolName: string;
  /** Timestamp when cached. */
  cachedAt: number;
  /** Token count of the full result. */
  tokens: number;
}

export interface ProgressiveResult {
  /** The content to inject into conversation (summary or full result). */
  content: string;
  /** Whether the result was summarized. */
  wasSummarized: boolean;
  /** If summarized, the cache ID to retrieve the full result. */
  cacheId?: string;
  /** Original token count. */
  originalTokens: number;
  /** Output token count. */
  outputTokens: number;
}

/**
 * Estimate token count from text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Get the configured threshold from environment or default.
 */
export function getThresholdFromEnv(): number {
  const raw = process.env.TOOL_RESULT_SUMMARY_THRESHOLD;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_THRESHOLD_TOKENS;
}

/**
 * Manages progressive disclosure of tool results.
 * Caches full results and returns summaries for large outputs.
 */
export class ProgressiveResultManager {
  private readonly threshold: number;
  private readonly ttlMs: number;
  private readonly summaryMaxTokens: number;
  private readonly cache = new Map<string, CachedResult>();

  constructor(options: ProgressiveResultOptions = {}) {
    this.threshold = options.thresholdTokens ?? getThresholdFromEnv();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.summaryMaxTokens = options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
  }

  /**
   * Process a tool result. Returns the result verbatim if small,
   * or a summary with a cache ID if large.
   */
  processResult(toolName: string, content: string): ProgressiveResult {
    const tokens = estimateTokens(content);

    // Below threshold: return verbatim
    if (tokens <= this.threshold) {
      return {
        content,
        wasSummarized: false,
        originalTokens: tokens,
        outputTokens: tokens,
      };
    }

    // Above threshold: summarize and cache
    const cacheId = randomUUID();
    this.cache.set(cacheId, {
      content,
      toolName,
      cachedAt: Date.now(),
      tokens,
    });

    log.info("Progressive result cached", { toolName, cacheId, tokens, threshold: this.threshold });

    const summary = this.buildSummary(toolName, content, tokens, cacheId);
    const outputTokens = estimateTokens(summary);

    return {
      content: summary,
      wasSummarized: true,
      cacheId,
      originalTokens: tokens,
      outputTokens,
    };
  }

  /**
   * Retrieve a full cached result by ID. Returns null if expired or not found.
   */
  getFullResult(cacheId: string): string | null {
    const entry = this.cache.get(cacheId);
    if (!entry) {
      log.warn("Cache miss for progressive result", { cacheId });
      return null;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(cacheId);
      log.info("Cache entry expired", { cacheId, toolName: entry.toolName });
      return null;
    }

    return entry.content;
  }

  /**
   * Clean up expired entries from the cache.
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, entry] of this.cache) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.cache.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.info("Evicted expired progressive result entries", { evicted });
    }
    return evicted;
  }

  /**
   * Get current cache size.
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Clear all cached results.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Build a summary for a large tool result.
   */
  private buildSummary(toolName: string, content: string, tokens: number, cacheId: string): string {
    const highlights = this.extractHighlights(content);
    const maxChars = this.summaryMaxTokens * CHARS_PER_TOKEN;

    const parts: string[] = [`[Tool result from "${toolName}" — ${tokens} tokens, summarized]`];

    if (highlights.resultCount !== undefined) {
      parts.push(`Results: ${highlights.resultCount} items`);
    }

    if (highlights.keyFields.length > 0) {
      const fieldsStr = highlights.keyFields.join(", ");
      // Truncate if needed
      parts.push(`Key data: ${fieldsStr.slice(0, maxChars / 2)}`);
    }

    if (highlights.preview) {
      parts.push(`Preview: ${highlights.preview.slice(0, maxChars / 3)}`);
    }

    parts.push(
      `To see the full result, call: {"tool": "get_full_result", "args": {"id": "${cacheId}"}}`,
    );

    return parts.join("\n");
  }

  /**
   * Extract highlights from content for the summary.
   */
  private extractHighlights(content: string): {
    resultCount?: number;
    keyFields: string[];
    preview?: string;
  } {
    const keyFields: string[] = [];
    let resultCount: number | undefined;
    let preview: string | undefined;

    // Try JSON parsing
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        resultCount = parsed.length;
        // Extract key fields from first item
        if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
          for (const field of PRESERVE_FIELDS) {
            if (field in parsed[0]) {
              keyFields.push(`${field}: ${String(parsed[0][field]).slice(0, 50)}`);
            }
          }
        }
      } else if (typeof parsed === "object" && parsed !== null) {
        for (const field of PRESERVE_FIELDS) {
          if (field in parsed) {
            keyFields.push(
              `${field}: ${String((parsed as Record<string, unknown>)[field]).slice(0, 50)}`,
            );
          }
        }
      }
    } catch {
      // Non-JSON: extract first line as preview
      const firstLine = content.split("\n")[0] ?? "";
      preview = firstLine.slice(0, 100);
    }

    return { resultCount, keyFields, preview };
  }

  /**
   * Build the system prompt instruction explaining progressive disclosure.
   */
  static buildSystemInstruction(): string {
    return [
      "[Progressive Tool Results]",
      "Some tool results may be summarized to save context space.",
      "When you see a summarized result, you can retrieve the full content by calling:",
      '  {"tool": "get_full_result", "args": {"id": "<cache_id>"}}',
      "Only expand results when you need the full detail for your task.",
    ].join("\n");
  }
}
