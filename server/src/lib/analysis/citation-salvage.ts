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
 *   - `codeCitationsLostToSalvage` — only the malformed ones that claimed to be
 *     CODE citations: an object carrying a code-citation field (`filePath`,
 *     `startLine`, `endLine`, `symbolId`) and no `documentId`. This is the one
 *     verification reads: the #734 rule it extends is about code evidence, so a
 *     lost document citation, a valid citation merely past the cap, or a lost
 *     value that does not say what it was (a bare string such as "spec.md" or
 *     "src/a.ts:12", an object with no citation field) must not demote a
 *     finding to `unverified`. Those still count on the run.
 *
 * Both keys are absent from the schema, so zod strips any value a model writes
 * there: only the server can set them. They are ordinary enumerable properties
 * so they survive the spreads the orchestrator applies before the verifier,
 * which then removes them ({@link withoutCitationLossMarker}) so they are not
 * stored in the agent result's output JSON.
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

// Deliberately the schema's own field names only: aliases such as `file`, `path`
// or `line` are never repaired into a code citation (findings-repair.ts has no
// alias), so their loss counts on the run but does not demote the finding.
const CODE_CITATION_FIELDS = ["filePath", "startLine", "endLine", "symbolId"] as const;

/** A raw citation that says it is a code citation, and not a document one. */
function isCodeClaim(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  if ("documentId" in raw) return false;
  return CODE_CITATION_FIELDS.some((k) => k in raw);
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
    if (isCodeClaim(c) && salvageCitationList([c]).dropped > 0) codeDropped += 1;
  }
  return { dropped, codeDropped };
}

/**
 * The finding without its loss markers: verification has read them, and they
 * are not part of the agent output that is stored.
 */
export function withoutCitationLossMarker<T extends object>(finding: T): T {
  const {
    citationsLostToSalvage: _all,
    codeCitationsLostToSalvage: _code,
    ...rest
  } = finding as T & CitationLossMarker;
  return rest as T;
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
