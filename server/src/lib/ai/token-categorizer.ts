/**
 * Epic #511 / Issue #512 — Categorized token telemetry instrumentation.
 *
 * Tags prompt sections with categories so token usage can be broken down by
 * purpose (system prompt, tool manifests, RAG context, etc.). Category
 * breakdowns are stored in the AITokenUsage table as a JSON column for
 * dashboard visualization.
 */

/**
 * Every prompt section is tagged with one of these categories.
 */
export enum TokenCategory {
  SYSTEM_PROMPT = "system_prompt",
  TOOL_MANIFESTS = "tool_manifests",
  TOOL_RESULTS = "tool_results",
  RAG_CONTEXT = "rag_context",
  USER_MESSAGE = "user_message",
  HISTORY = "history",
  CODE_CONTEXT = "code_context",
}

export interface PromptSection {
  category: TokenCategory;
  content: string;
}

export interface CategoryBreakdown {
  [category: string]: number;
}

/**
 * Estimate token count from text.
 *
 * Uses a character-based heuristic (1 token ≈ 4 chars for English text).
 * This is a fallback; production deployments may swap in tiktoken for
 * model-specific accuracy.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Average English token is ~4 characters. This matches OpenAI's rule of thumb.
  return Math.ceil(text.length / 4);
}

/**
 * Computes a per-category token breakdown from tagged prompt sections.
 */
export function computeCategoryBreakdown(sections: PromptSection[]): CategoryBreakdown {
  const breakdown: CategoryBreakdown = {};
  for (const section of sections) {
    const tokens = estimateTokens(section.content);
    breakdown[section.category] = (breakdown[section.category] ?? 0) + tokens;
  }
  return breakdown;
}

/**
 * Returns the total token estimate across all sections.
 */
export function totalFromBreakdown(breakdown: CategoryBreakdown): number {
  let total = 0;
  for (const count of Object.values(breakdown)) {
    total += count;
  }
  return total;
}

/**
 * TokenCategorizer — stateless utility that tags and counts prompt sections.
 *
 * Integrates with the existing TokenTracker by producing a `CategoryBreakdown`
 * that can be attached to each token-usage event without altering the tracker API.
 */
export class TokenCategorizer {
  private sections: PromptSection[] = [];

  /** Add a tagged section to the current prompt build-up. */
  addSection(category: TokenCategory, content: string): void {
    this.sections.push({ category, content });
  }

  /** Compute the breakdown and reset internal state. */
  finalize(): CategoryBreakdown {
    const breakdown = computeCategoryBreakdown(this.sections);
    this.sections = [];
    return breakdown;
  }

  /** Peek at the current breakdown without resetting. */
  peek(): CategoryBreakdown {
    return computeCategoryBreakdown(this.sections);
  }

  /** Number of sections currently buffered. */
  get sectionCount(): number {
    return this.sections.length;
  }

  /** Clear all buffered sections without computing. */
  reset(): void {
    this.sections = [];
  }
}
