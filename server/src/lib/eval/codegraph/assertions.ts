/**
 * Epic #712 / Issue #717 — pure assertion helpers for the code-graph citation
 * eval + unit tests.
 *
 * These are side-effect-free string/record checks so both the CI unit test and
 * the offline eval CLI can share exactly one definition of "did the answer cite
 * the right source" and "did it avoid a reconstruction disclaimer".
 */

/** The minimal `CodeSymbol` shape a locator is derived from. */
export interface LocatableSymbol {
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Derive the canonical `filePath:startLine-endLine` locator from a `CodeSymbol`
 * record. This is the SINGLE source of truth for the expected citation string —
 * tests derive the expectation from real parsed symbol data via this helper
 * rather than hardcoding a literal (so a citation regression cannot pass).
 */
export function expectedLocator(symbol: LocatableSymbol): string {
  return `${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`;
}

/** Whether the answer cites the exact derived locator inline. */
export function citesLocator(answer: string, locator: string): boolean {
  return answer.includes(locator);
}

/**
 * Return the first forbidden disclaimer substring present in the answer
 * (case-insensitive), or `null` when the answer is clean. A non-null result is
 * a failure — the epic forbids "reconstructed from the knowledge base"-style
 * hedges when a real code locator was available.
 */
export function findForbiddenDisclaimer(answer: string, forbidden: string[]): string | null {
  const haystack = answer.toLowerCase();
  for (const phrase of forbidden) {
    if (haystack.includes(phrase.toLowerCase())) return phrase;
  }
  return null;
}

/** Extract the FIRST `path:startLine-endLine` locator from arbitrary text. */
export function extractFirstLocator(text: string): string | null {
  const m = /([\w./-]+:\d+-\d+)/.exec(text);
  return m ? m[1] : null;
}
