/**
 * Issue #1603 — the order synthesis numbers an analysis's findings in.
 *
 * Synthesis ranks the flattened findings by the #1109 panel's confidence before
 * it numbers them `[0]…[N]` (#1110), and the model answers with
 * `evidenceFindingIndexes` against those numbers. Anything that later turns an
 * index back into a finding (promotion from the Approvals tab, the append of a
 * reopened requirement, the "no code evidence" mark) must number them the same
 * way, or with the panel flag on it links a requirement to the WRONG finding:
 * `readFlattenedFindings` returns them in database order. Every one of them
 * goes through this function, so the two orderings cannot drift apart.
 *
 * Flag off, no finding carries a panel and this is the identity (the ranking is
 * a stable sort, never a filter).
 */
import { orderByPanelConfidence, type FindingSupportPanel } from "@metis/shared";

export function inSynthesisOrder<T extends { supportPanel?: FindingSupportPanel | null }>(
  findings: readonly T[],
): T[] {
  return orderByPanelConfidence(findings, (f) => f.supportPanel);
}
