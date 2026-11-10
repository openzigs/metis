/**
 * #1825 — the identity of one requirement-to-code link: its file and code
 * symbol. The code agent's citation writer (`seed-code-links-from-findings.ts`)
 * dedupes against its own `analysis-grounding` rows only, so a file the semantic
 * mapper linked first holds two rows, one per source. The readers that list a
 * requirement's links by this key — its traceability chain
 * (`traceability-spine.ts`), the issue draft's Related code
 * (`draft-code-links.ts`) and the similar-requirements panel
 * (`similar-requirements.ts`, #1891) — show each (filePath, codeSymbolId) once.
 * The analysis traceability matrix (`analysis/traceability-service.ts`) is not
 * one of them: it merges its locations on (path, range) instead.
 */

import { codeLinkKey } from "@metis/shared";

/**
 * The key a requirement's code links are deduped on (a file-level link has no
 * symbol). #1969 — `@metis/shared`'s, which the borrow's duplicate rule reads too.
 */
export { codeLinkKey };

/**
 * #1891 — the freshness tiers a link is ranked in, as `citationOrder` (#1832)
 * leads citations: known current, rewritten to its new place, never checked,
 * then found out of date (#1831). A row read without the column ranks as
 * never checked.
 */
const LINK_FRESHNESS_TIER: Readonly<Record<string, number>> = {
  fresh: 0,
  moved: 1,
  unverified: 2,
  stale: 3,
};
const linkTier = (row: { freshness?: string | null }): number =>
  LINK_FRESHNESS_TIER[row.freshness ?? ""] ?? LINK_FRESHNESS_TIER.unverified!;

/**
 * #1891 — the rank that decides which row of a repeated link is kept: the
 * freshness tier, then the surer first. A semantic row is always `unverified`
 * and an agent citation can be `stale`, so ranking on confidence alone let an
 * out-of-date citation hide the current link to the same code.
 * `Array.prototype.sort` is stable (ES2019), so rows equal on both keep the
 * caller's order — which must therefore be deterministic (end the query's
 * `orderBy` on the id).
 */
export function codeLinkOrder<T extends { confidence: number; freshness?: string | null }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => linkTier(a) - linkTier(b) || b.confidence - a.confidence);
}

/**
 * Each (filePath, codeSymbolId) once, keeping the first row: the caller's
 * order decides which row speaks for the link (readers sort the surer first).
 */
export function uniqueCodeLinks<T extends { filePath: string; codeSymbolId: string | null }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = codeLinkKey(row.filePath, row.codeSymbolId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * #1891 — each (filePath, codeSymbolId) once, the row kept chosen by
 * {@link codeLinkOrder}; the kept rows stay in the caller's order, so a list
 * read surer-first is still listed surer-first.
 */
export function uniqueCurrentCodeLinks<
  T extends {
    filePath: string;
    codeSymbolId: string | null;
    confidence: number;
    freshness?: string | null;
  },
>(rows: readonly T[]): T[] {
  const kept = new Set(uniqueCodeLinks(codeLinkOrder(rows)));
  return rows.filter((row) => kept.has(row));
}
