/**
 * Issue #1155 — a per-finding marker for citations the shared schema's
 * preprocess salvage dropped (#1143).
 *
 * The salvage runs inside `agentOutputSchema` / `agentFindingPayloadSchema`, so
 * a malformed citation is gone before the #734 grounding gate sees the finding.
 * `verifyFinding` then saw "no citation, nothing dropped" and returned `null`
 * ("nothing to verify") for a finding that DID cite code and lost it. The
 * run-level count (`droppedCitations` on the capability) showed the loss; the
 * finding's own badge hid it.
 *
 * Two counts are read from the raw finding before the parse erases them:
 *
 *   - `citationsLostToSalvage` — every citation dropped, as the run-level count
 *     reports it (malformed ones and any past the per-finding cap);
 *   - `codeCitationsLostToSalvage` — only the malformed ones that were not
 *     document citations, i.e. a lost CODE claim. This is the one verification
 *     reads: the #734 rule it extends is about code evidence, so a lost document
 *     citation, or a valid citation merely past the cap, must not demote a
 *     finding to `unverified`.
 *
 * Both keys are absent from the schema, so zod strips any value a model writes
 * there: only the server can set them. They are ordinary enumerable properties
 * so they survive the spreads the orchestrator applies before the verifier.
 */
import { salvageCitationList } from "@metis/shared";

interface CitationLossMarker {
  citationsLostToSalvage?: number;
  codeCitationsLostToSalvage?: number;
}

/** What the schema's salvage drops from one raw finding. */
export interface CitationLoss {
  /** Every citation dropped (malformed, or past the cap). */
  dropped: number;
  /** Malformed citations that did not claim to be document citations. */
  codeDropped: number;
}

const NO_LOSS: CitationLoss = { dropped: 0, codeDropped: 0 };

function isDocumentClaim(raw: unknown): boolean {
  return raw !== null && typeof raw === "object" && "documentId" in raw;
}

/** What the schema's salvage drops from ONE raw, model-authored finding. Total. */
export function citationLossFrom(rawFinding: unknown): CitationLoss {
  if (rawFinding === null || typeof rawFinding !== "object" || Array.isArray(rawFinding)) {
    return NO_LOSS;
  }
  const citations = (rawFinding as Record<string, unknown>).citations;
  const { dropped } = salvageCitationList(citations);
  if (dropped === 0) return NO_LOSS;
  // The same list normalisation the salvage applies: null is empty, a lone
  // value is a list of one.
  const list = Array.isArray(citations) ? citations : citations == null ? [] : [citations];
  let codeDropped = 0;
  for (const c of list) {
    if (isDocumentClaim(c)) continue;
    if (salvageCitationList([c]).dropped > 0) codeDropped += 1;
  }
  return { dropped, codeDropped };
}

/** Mark one parsed finding with what its raw counterpart lost. */
export function markCitationLoss<T extends object>(finding: T, loss: CitationLoss): T {
  const marker = finding as CitationLossMarker;
  if (loss.dropped > 0) marker.citationsLostToSalvage = loss.dropped;
  if (loss.codeDropped > 0) marker.codeCitationsLostToSalvage = loss.codeDropped;
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
  findings.forEach((f, i) => markCitationLoss(f, citationLossFrom(raw[i])));
}

function readCount(n: unknown): number {
  return typeof n === "number" && n > 0 ? n : 0;
}

/** Every citation the schema's salvage dropped from this finding (0 when unmarked). */
export function citationsLostToSalvage(finding: object): number {
  return readCount((finding as CitationLossMarker).citationsLostToSalvage);
}

/** The lost citations that claimed code evidence (0 when unmarked). */
export function codeCitationsLostToSalvage(finding: object): number {
  return readCount((finding as CitationLossMarker).codeCitationsLostToSalvage);
}

/** The citations lost across `findings`, as the run-level count reports them. */
export function totalCitationsLost(findings: readonly object[]): number {
  return findings.reduce((sum: number, f) => sum + citationsLostToSalvage(f), 0);
}
