/**
 * Issue #1155 — a per-finding marker for citations the shared schema's
 * preprocess salvage dropped (#1143).
 *
 * The salvage runs inside `agentOutputSchema` / `agentFindingPayloadSchema`, so
 * a malformed citation is gone before the #734 grounding gate sees the finding.
 * `verifyFinding` then saw "no citation, nothing dropped" and returned `null`
 * ("nothing to verify") for a finding that DID cite evidence and lost it. The
 * run-level count (`droppedCitations` on the capability) showed the loss; the
 * finding's own badge hid it.
 *
 * The count is read from the raw finding before the parse erases it, and
 * written onto the parsed finding as `citationsLostToSalvage`. That key is not
 * in the schema, so zod strips any value a model writes there: only the server
 * can set it. It is an ordinary enumerable property so it survives the spreads
 * the orchestrator applies between the parse and the verifier.
 */
import { salvageCitationList } from "@metis/shared";

interface CitationLossMarker {
  citationsLostToSalvage?: number;
}

/** The citations the schema's salvage drops from ONE raw, model-authored finding. Total. */
export function citationsDroppedFrom(rawFinding: unknown): number {
  if (rawFinding === null || typeof rawFinding !== "object" || Array.isArray(rawFinding)) return 0;
  return salvageCitationList((rawFinding as Record<string, unknown>).citations).dropped;
}

/** Mark one parsed finding with the citations its raw counterpart lost. */
export function markCitationLoss<T extends object>(finding: T, dropped: number): T {
  if (dropped > 0) (finding as CitationLossMarker).citationsLostToSalvage = dropped;
  return finding;
}

/**
 * Mark each parsed finding with what its raw counterpart in `rawOutput.findings`
 * lost. Index-aligned: `agentOutputSchema` parses `findings` element by element
 * and never filters, so `parsed[i]` is `raw.findings[i]`.
 */
export function markCitationLosses(findings: readonly object[], rawOutput: unknown): void {
  if (rawOutput === null || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return;
  const raw = (rawOutput as Record<string, unknown>).findings;
  if (!Array.isArray(raw)) return;
  findings.forEach((f, i) => markCitationLoss(f, citationsDroppedFrom(raw[i])));
}

/** How many of this finding's citations the schema's salvage dropped (0 when unmarked). */
export function citationsLostToSalvage(finding: object): number {
  const n = (finding as CitationLossMarker).citationsLostToSalvage;
  return typeof n === "number" && n > 0 ? n : 0;
}

/** The citations lost across `findings`. */
export function totalCitationsLost(findings: readonly object[]): number {
  return findings.reduce((sum: number, f) => sum + citationsLostToSalvage(f), 0);
}
