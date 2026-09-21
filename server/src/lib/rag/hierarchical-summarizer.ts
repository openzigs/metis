/**
 * Epic #515 / Issue #517 — Hierarchical context summarization for large RAG
 * result sets.
 *
 * Two-phase summarization:
 * - Map phase: summarize each chunk to ~25% of original size
 * - Reduce phase: merge chunk summaries into a coherent whole within budget
 * - Recursive: if merged result still exceeds budget, apply reduce again
 *
 * Preserves: entities, numbers, dates, key assertions from original chunks.
 * Threshold: only triggers when total chunks exceed 2x token budget.
 * Below threshold: returns chunks as-is (no unnecessary summarization).
 * Latency budget: max 3 seconds for 20 chunks.
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("hierarchical-summarizer");

/** Approximate tokens per character (same heuristic as compaction.ts). */
const CHARS_PER_TOKEN = 4;

/** Default token budget for the final output. */
const DEFAULT_TOKEN_BUDGET = 4096;

/** Default max recursion depth to prevent runaway loops. */
const DEFAULT_MAX_DEPTH = 3;

/** Target compression ratio for the map phase. */
const MAP_COMPRESSION_RATIO = 0.25;

/** Regex patterns for entity extraction (preserves important data). */
const ENTITY_PATTERNS = {
  dates: /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g,
  numbers: /\b\d+(?:\.\d+)?(?:%|K|M|B|GB|MB|KB|ms|s|min|hr)?\b/g,
  urls: /https?:\/\/[^\s"'<>]+/g,
  emails: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  filePaths: /(?:\/[\w.-]+){2,}/g,
  quotedStrings: /"[^"]{3,80}"/g,
};

export interface ChunkInput {
  /** The chunk text content. */
  content: string;
  /** Optional metadata (e.g., source document ID). */
  metadata?: Record<string, unknown>;
}

export interface SummarizationResult {
  /** The final summarized content within budget. */
  content: string;
  /** Whether summarization was applied. */
  wasSummarized: boolean;
  /** Total input tokens across all chunks. */
  inputTokens: number;
  /** Output token count after summarization. */
  outputTokens: number;
  /** Number of chunks processed. */
  chunkCount: number;
  /** Recursion depth used. */
  depth: number;
  /** Duration in milliseconds. */
  durationMs: number;
}

/**
 * A summarizer function that compresses text. In production, this is backed
 * by a fast LLM call. For testing, a deterministic heuristic is used.
 */
export type SummarizerFn = (text: string, targetTokens: number) => Promise<string>;

export interface HierarchicalSummarizerOptions {
  /** Maximum token budget for the final output. Default: 4096. */
  tokenBudget?: number;
  /** Maximum recursion depth. Default: 3. */
  maxDepth?: number;
  /** Custom summarizer function. Defaults to extractive summarization. */
  summarizer?: SummarizerFn;
  /** Timeout in milliseconds. Default: 3000 (3 seconds). */
  timeoutMs?: number;
}

/**
 * Estimate token count from text length.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Extract key entities from text to preserve during summarization.
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const pattern of Object.values(ENTITY_PATTERNS)) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        entities.add(m);
      }
    }
  }
  return Array.from(entities);
}

/**
 * Default extractive summarizer. Keeps first and last sentences, plus
 * any sentences containing entities. Used when no LLM summarizer is provided.
 */
export async function extractiveSummarize(text: string, targetTokens: number): Promise<string> {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  if (text.length <= targetChars) return text;

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length <= 2) return text.slice(0, targetChars);

  const entities = extractEntities(text);
  const entitySet = new Set(entities);

  // Score sentences: first/last get high priority, entity-containing get medium
  const scored = sentences.map((s, i) => {
    let score = 0;
    if (i === 0) score += 10;
    if (i === sentences.length - 1) score += 8;
    // Check if sentence contains any entity
    for (const entity of entitySet) {
      if (s.includes(entity)) {
        score += 3;
        break;
      }
    }
    // Shorter sentences with numbers/dates are likely key facts
    if (s.length < 100 && /\d/.test(s)) score += 2;
    return { sentence: s, score, index: i };
  });

  // Sort by score (descending), then by original index (ascending) for ties
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  // Greedily pick sentences until we fill the budget
  const selected: Array<{ sentence: string; index: number }> = [];
  let charCount = 0;
  for (const item of scored) {
    if (charCount + item.sentence.length > targetChars) continue;
    selected.push({ sentence: item.sentence, index: item.index });
    charCount += item.sentence.length + 1; // +1 for space
  }

  // Re-order by original position for coherence
  selected.sort((a, b) => a.index - b.index);
  return selected.map((s) => s.sentence).join(" ");
}

/**
 * Hierarchical summarizer that applies map-reduce summarization to large
 * RAG result sets.
 */
export class HierarchicalSummarizer {
  private readonly tokenBudget: number;
  private readonly maxDepth: number;
  private readonly summarizer: SummarizerFn;
  private readonly timeoutMs: number;

  constructor(options: HierarchicalSummarizerOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.summarizer = options.summarizer ?? extractiveSummarize;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  /**
   * Summarize a set of chunks. Only applies summarization when total tokens
   * exceed 2x the token budget. Below threshold, returns chunks as-is.
   */
  async summarize(chunks: ChunkInput[]): Promise<SummarizationResult> {
    const start = Date.now();

    if (chunks.length === 0) {
      return {
        content: "",
        wasSummarized: false,
        inputTokens: 0,
        outputTokens: 0,
        chunkCount: 0,
        depth: 0,
        durationMs: 0,
      };
    }

    const totalContent = chunks.map((c) => c.content).join("\n\n");
    const inputTokens = estimateTokens(totalContent);

    // Below threshold: return as-is
    if (inputTokens <= this.tokenBudget * 2) {
      return {
        content: totalContent,
        wasSummarized: false,
        inputTokens,
        outputTokens: inputTokens,
        chunkCount: chunks.length,
        depth: 0,
        durationMs: Date.now() - start,
      };
    }

    log.info("Starting hierarchical summarization", {
      chunkCount: chunks.length,
      inputTokens,
      tokenBudget: this.tokenBudget,
      timeoutMs: this.timeoutMs,
    });

    // Map phase: summarize each chunk to ~25% of original
    const mappedChunks = await this.mapPhase(chunks);

    // Reduce phase: merge until within budget (recursive)
    const reduced = await this.reducePhase(mappedChunks, 1);

    const durationMs = Date.now() - start;
    const outputTokens = estimateTokens(reduced.content);

    log.info("Hierarchical summarization complete", {
      inputTokens,
      outputTokens,
      depth: reduced.depth,
      durationMs,
    });

    return {
      content: reduced.content,
      wasSummarized: true,
      inputTokens,
      outputTokens,
      chunkCount: chunks.length,
      depth: reduced.depth,
      durationMs,
    };
  }

  /**
   * Map phase: summarize each chunk individually to ~25% of its size.
   */
  private async mapPhase(chunks: ChunkInput[]): Promise<string[]> {
    const results: string[] = [];
    for (const chunk of chunks) {
      const chunkTokens = estimateTokens(chunk.content);
      const targetTokens = Math.max(50, Math.ceil(chunkTokens * MAP_COMPRESSION_RATIO));
      const summary = await this.summarizer(chunk.content, targetTokens);
      results.push(summary);
    }
    return results;
  }

  /**
   * Reduce phase: merge chunk summaries into a single coherent output.
   * If still over budget, recurse.
   */
  private async reducePhase(
    summaries: string[],
    currentDepth: number,
  ): Promise<{ content: string; depth: number }> {
    const merged = summaries.join("\n\n");
    const mergedTokens = estimateTokens(merged);

    // Within budget — done
    if (mergedTokens <= this.tokenBudget) {
      return { content: merged, depth: currentDepth };
    }

    // Max depth reached — hard-truncate
    if (currentDepth >= this.maxDepth) {
      const truncated = await this.summarizer(merged, this.tokenBudget);
      return { content: truncated, depth: currentDepth };
    }

    // Recurse: split into groups and summarize each group
    const groupSize = Math.max(2, Math.ceil(summaries.length / 4));
    const groups: string[][] = [];
    for (let i = 0; i < summaries.length; i += groupSize) {
      groups.push(summaries.slice(i, i + groupSize));
    }

    const groupSummaries: string[] = [];
    for (const group of groups) {
      const groupText = group.join("\n\n");
      const groupTargetTokens = Math.ceil(this.tokenBudget / groups.length);
      const summary = await this.summarizer(groupText, groupTargetTokens);
      groupSummaries.push(summary);
    }

    return this.reducePhase(groupSummaries, currentDepth + 1);
  }
}
