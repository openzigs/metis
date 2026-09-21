/**
 * Per-finding verifier/critic pass (Epic #727 / #740).
 *
 * Between agent completion and synthesis, each finding's CODE-evidence claim is
 * adversarially checked against the evidence the agent was actually given. A
 * finding that asserts `file.ts:10-20` it never retrieved is hallucinating, and
 * letting such a claim flow untouched into synthesis lets an unsupported gap
 * become a first-class requirement with the same weight as a grounded one. This
 * module marks each finding `confirmed | unverified` so synthesis can down-weight
 * (never silently drop) the unsupported ones.
 *
 * DESIGN — deterministic, LLM-free (approach (a) in the #740 brief). Rather than
 * spend a second LLM pass re-reading every finding vs its evidence, the verifier
 * REUSES the signal the #734 grounding gate already produces: `groundCodeCitations`
 * validates every code citation against the retrieved provenance set and reports
 * each drop via `onDrop`. The gate has already done the hard, adversarial work of
 * "is this cited file actually in what the agent saw?" — the verifier simply reads
 * its verdict. This is free (no tokens), deterministic (same evidence ⇒ same
 * label, trivially unit-testable), and cannot fail the run.
 *
 * (An LLM critic — approach (b) — is intentionally NOT added: it would cost tokens
 * on every run for a judgement the deterministic gate already makes. The one place
 * an LLM adds value over grounding is semantic support ["does this file actually
 * back the CLAIM, not just exist?"], which is deferred; the epic's "one verifier
 * round, no debate" scope and the strong preference for the free deterministic
 * baseline both point here.)
 *
 * ISSUE #773 — THE HOLE THIS VERIFIER HAD. Rule (3) below was a blind spot with
 * a very expensive failure mode: a finding that asserts an ABSENCE ("No evidence
 * found for X", "X is not implemented") CITES NOTHING — an absence claim has
 * nothing to cite — so it dropped no citations, retained none, and classified
 * `null`: it sailed straight through this gate unflagged and was rendered
 * downstream as a CONFIRMED GAP. That is how the reported run told a user to
 * build `computeSeverity` and commit-SHA baselining that already existed in the
 * indexed code graph.
 *
 * The hole is closed HERE (rather than by a parallel mechanism) with one new
 * rule: an absence-asserting, citation-free finding whose run could not back an
 * absence claim — retrieval errored / returned nothing / the investigation was
 * cut short by the turn or token budget, i.e. the `absenceIsConfirmable` evidence
 * threshold in `retrieval-health.ts` failed — is `could-not-verify`. It made a
 * claim about what the code does NOT contain, and nothing supports it.
 *
 * Rule (pure, first match wins), per finding, from the #734 gate output:
 *   1. it ASSERTS AN ABSENCE and the run's retrieval cannot back an
 *      absence claim (#773)                                   → `could-not-verify`
 *   2. else retained ≥1 CODE citation (survived provenance)   → `confirmed`
 *   3. else the gate DROPPED ≥1 of its code citations         → `unverified`
 *      (it claimed code evidence; none of it survived grounding)
 *   4. else (no code citation emitted, nothing dropped)       → `null`
 *      (a doc-only / generic finding makes no code claim to verify — the #734
 *      gate never validates document citations, so we do not overstate them as
 *      "confirmed"; and we do not flood the UI by flagging every doc finding.)
 *
 * WHY (1) OUTRANKS (2). An absence-asserting finding CAN carry a surviving code
 * citation: the #729 passive fused-symbol seed grounds citations even on a run
 * where not one search succeeded. Ranked the other way, such a finding was
 * `confirmed` here while `gateFindingVerdict` (correctly) called it
 * `could-not-verify` — so the UI rendered a green "Confirmed" badge beside a
 * violet "Could not verify" badge on the same finding. That is the same
 * "cites code ⇒ the claim is true" conflation this issue exists to remove: a
 * citation proves the agent SAW some code, never that the code it did not see is
 * absent. The two surfaces now agree, by construction.
 */
import { isCodeCitation, type Citation, type FindingVerificationStatus } from "@metis/shared";
import type { DroppedCitation } from "./code-citations.js";

export interface FindingVerificationInput {
  /**
   * The finding's citations AFTER the #734 grounding gate ran — i.e. the code
   * citations that survived provenance validation (plus pass-through doc
   * citations, which are irrelevant to the code-evidence verdict).
   */
  groundedCitations: Citation[];
  /**
   * The citations the #734 gate DROPPED for THIS finding (hallucinated /
   * un-retrievable code locators). A non-empty list means the finding asserted
   * code evidence that is not in the retrieved corpus.
   */
  droppedCitations: DroppedCitation[];
  /**
   * #773 — does this finding ASSERT AN ABSENCE (claim the code does NOT contain
   * something)? Computed by `assertsAbsence` / the model's own `gap-confirmed`
   * verdict. Omitted ⇒ the caller makes no absence judgement and rule (3) is
   * inert, so pre-#773 callers behave exactly as before.
   */
  assertsAbsence?: boolean;
  /**
   * #773 — did the run's retrieval clear the evidence threshold
   * (`absenceIsConfirmable`)? Omitted ⇒ rule (3) is inert.
   */
  absenceConfirmable?: boolean;
}

/**
 * Classify a single finding's verification status from the #734 grounding gate
 * output. Pure — see the module doc for the exact rule. Returns `null` when the
 * finding made no verifiable code-evidence claim.
 */
export function verifyFinding(input: FindingVerificationInput): FindingVerificationStatus | null {
  const grounded = input.groundedCitations ?? [];
  const dropped = input.droppedCitations ?? [];
  // (1) #773 — it claimed an ABSENCE and the run's retrieval cannot support such a
  // claim. This OUTRANKS the citation rules on purpose: a citation (possibly from
  // the #729 passive seed) proves the agent saw SOME code, never that the code it
  // did not see is absent. Ranking it below (2) is what produced a "Confirmed"
  // badge next to a "Could not verify" one on the very same finding.
  if (input.assertsAbsence === true && input.absenceConfirmable === false) {
    return "could-not-verify";
  }
  // (2) A surviving code citation is the strongest signal a POSITIVE claim is grounded.
  if (grounded.some(isCodeCitation)) return "confirmed";
  // (3) It claimed code evidence, but the gate dropped all of it → unsupported.
  if (dropped.length > 0) return "unverified";
  // (4) No code-evidence claim at all → nothing to verify (neutral / null).
  return null;
}
