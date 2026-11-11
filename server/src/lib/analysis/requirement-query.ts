/**
 * Issue #2233 — a requirement's text as a search or embedding query, bounded.
 *
 * An imported item reaches the code agent with its whole body and acceptance
 * criteria (`codeAgentRequirementSet`), and neither is shortened: the model's
 * prompt must read all of it. The same text must not become a search query
 * unbounded. The embeddings sidecar refuses an input over 32,768 characters
 * with a non-retryable 400, which failed per-requirement retrieval and with it
 * the requirement-grounded code agent; the in-process embedder cuts at 2,048
 * tokens without saying so.
 *
 * 4,000 characters is the portfolio gap engine's query bound
 * (`MAX_QUERY_CHARS`, `lib/portfolio/gap-engine.ts`): about 1,000 tokens, under
 * both embedders' limits, and far more than a query needs to rank chunks. The
 * title leads the text, so it is always inside the bound.
 */
export const MAX_REQUIREMENT_QUERY_CHARS = 4_000;

/**
 * The text a search or score reads for a requirement: unchanged when within
 * {@link MAX_REQUIREMENT_QUERY_CHARS}, else its first that many characters.
 * Only the QUERY is bounded; prompts keep the full text.
 */
export function requirementQueryText(text: string): string {
  return text.length <= MAX_REQUIREMENT_QUERY_CHARS
    ? text
    : text.slice(0, MAX_REQUIREMENT_QUERY_CHARS);
}
