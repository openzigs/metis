"use client";

/**
 * Issue #1232 — the outcome of a completed analysis run, stated once at the top.
 *
 * The synthesis agent already writes an executive summary that names the
 * outcome and any blocking context gap, and it was plumbed all the way to the
 * client (`AgentResultSummary.summary`) but never rendered. Everything below it
 * on the page — requirements, findings — is detail against this.
 *
 * Renders nothing at all when there is no synthesis summary or the run has not
 * completed: an empty "Outcome" shell reads as "no outcome", which is a
 * different and wrong claim.
 *
 * Issue #994 — the summary is written before the requirements are stored, so its
 * count can disagree with them ("Ten requirements were derived" over 8 rows).
 * The card states the count from the stored rows, and a sentence in the summary
 * that counts the derived requirements is corrected to match.
 *
 * Only when the stored rows ARE the set the summary describes, though: when the
 * approval gate withholds promotion (#1104) or a re-synthesis was refused
 * replacement (#769), the run keeps its summary but stores none (or an older
 * set) of the requirements it names. Reconciling against those rows would turn
 * a correct "Ten requirements were derived" into "0 requirements were derived",
 * the empty-but-successful presentation #1104 removed. `outcomeRequirementCount`
 * makes that call.
 *
 * #2548 — a viewer who cannot see the run as a whole is sent no summary (the
 * narrative rests on everything the run read). The section stays, saying why,
 * so the Summary does not silently lose its Outcome for them.
 */
import { RESTRICTED_OUTCOME_BODY } from "@metis/shared";

interface OutcomeAgent {
  agentKey: string;
  summary: string | null;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/**
 * `<N> [new] requirement(s) was/were/have been <derived|…>`, where
 * N is digits or a number word up to twenty. Only this claim is rewritten; any
 * other number in the summary is the agent's own and left alone. A qualifier
 * other than "new" ("3 security requirements") marks a subset, not the total,
 * so it never matches; and a summary with more than one claim is ambiguous, so
 * it is left as written (the stored-count line below it states the truth).
 */
const COUNT_CLAIM_RE = new RegExp(
  `\\b(\\d+|${NUMBER_WORDS.join("|")})(\\s+(?:new\\s+)?)requirements?(\\s+)(?:was|were|have been|has been)(\\s+(?:derived|identified|synthesi[sz]ed|generated|extracted|produced|created|recorded))\\b`,
  "gi",
);

function claimedCount(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS.indexOf(token.toLowerCase());
}

/** Correct a summary's derived-requirement count to the number of stored rows. */
export function reconcileRequirementCount(summary: string, stored: number): string {
  if ((summary.match(COUNT_CLAIM_RE) ?? []).length !== 1) return summary;
  return summary.replace(
    COUNT_CLAIM_RE,
    (match, n: string, between: string, gap: string, verb: string) => {
      if (claimedCount(n) === stored) return match;
      const noun = stored === 1 ? "requirement" : "requirements";
      const aux = stored === 1 ? "was" : "were";
      return `${stored}${between}${noun}${gap}${aux}${verb}`;
    },
  );
}

/**
 * The stored-row count the outcome may be reconciled against, or `undefined`
 * when the stored rows are not the set this run's summary describes: promotion
 * is gated, replacement was withheld, or nothing was stored.
 */
export function outcomeRequirementCount(
  metadata: Record<string, unknown> | null | undefined,
  stored: number,
): number | undefined {
  // Read inline rather than via `readEnhancementMetadata`: page tests mock
  // `@/lib/analysis-api` wholesale, and this is two keys.
  const meta = (metadata ?? {}) as {
    promotionBlocked?: { blocked?: unknown } | null;
    requirementReplacementWithheld?: unknown;
  };
  if (meta.promotionBlocked?.blocked === true) return undefined;
  if (meta.requirementReplacementWithheld) return undefined;
  if (stored === 0) return undefined;
  return stored;
}

/**
 * Issue #2596 — while the approval gate holds the run's requirements, how many
 * the Checkpoints tab lists, reconciled with the count the summary gives. In
 * the 2026-11-16 walkthrough the summary said "Eight requirements" and the
 * checkpoints listed 18: the 8 plus 10 NFRs the analysis found, and nothing on
 * the page said so. `undefined` when the gate is not holding requirements.
 */
export function describeListedForApproval(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  // Inline, as `outcomeRequirementCount`: page tests mock `@/lib/analysis-api`.
  const blocked = (
    (metadata ?? {}) as {
      promotionBlocked?: {
        blocked?: unknown;
        awaitingRequirementCount?: unknown;
        reviewedRequirementCount?: unknown;
        synthesisRequirementCount?: unknown;
        setDifference?: { elicitedNfrs?: unknown } | null;
      } | null;
    }
  ).promotionBlocked;
  if (blocked?.blocked !== true) return undefined;
  const listed = blocked.reviewedRequirementCount ?? blocked.awaitingRequirementCount;
  if (typeof listed !== "number" || listed <= 0) return undefined;
  const nfrs = blocked.setDifference?.elicitedNfrs;
  const written = blocked.synthesisRequirementCount;
  if (
    typeof nfrs === "number" &&
    nfrs > 0 &&
    typeof written === "number" &&
    listed - nfrs === written
  ) {
    return (
      `${listed} requirement(s) are listed for approval on the Checkpoints tab: the ${written} ` +
      `the analysis wrote up and ${nfrs} non-functional requirement(s) it found.`
    );
  }
  return `${listed} requirement(s) are listed for approval on the Checkpoints tab; none is saved until it is approved.`;
}

export function AnalysisOutcomeCard({
  status,
  agentResults,
  requirementCount,
  listedForApproval,
  narrativeHidden = false,
}: {
  status: string;
  agentResults: readonly OutcomeAgent[];
  /** #2596 — {@link describeListedForApproval}, while the gate holds the requirements. */
  listedForApproval?: string;
  /** #2548 — the server hid the run's narrative from this viewer (`restrictedView.narrative`). */
  narrativeHidden?: boolean;
  /**
   * Issue #994 — the requirement rows stored for this run, from
   * `outcomeRequirementCount`; omit when they are not the summary's set.
   */
  requirementCount?: number;
}): React.ReactElement | null {
  if (status !== "completed") return null;
  const synthesis = agentResults.find((a) => a.agentKey === "synthesis");
  if (narrativeHidden && synthesis) {
    return (
      <section
        data-testid="analysis-outcome-restricted"
        aria-labelledby="analysis-outcome-heading"
        className="rounded border border-dashed border-border bg-muted/20 p-4"
      >
        <h4
          id="analysis-outcome-heading"
          className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Outcome
        </h4>
        <p className="text-sm text-muted-foreground">{RESTRICTED_OUTCOME_BODY}</p>
      </section>
    );
  }
  const raw = synthesis?.summary?.trim();
  if (!raw) return null;
  const summary =
    requirementCount === undefined ? raw : reconcileRequirementCount(raw, requirementCount);

  return (
    <section
      data-testid="analysis-outcome-card"
      aria-labelledby="analysis-outcome-heading"
      className="rounded border border-success/40 bg-success-muted p-4"
    >
      <h4
        id="analysis-outcome-heading"
        className="mb-2 text-sm font-semibold uppercase tracking-wide text-success"
      >
        Outcome
      </h4>
      <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-foreground">
        {summary}
      </p>
      {requirementCount !== undefined ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="analysis-outcome-count">
          {requirementCount} requirement{requirementCount === 1 ? "" : "s"} stored for this run.
        </p>
      ) : null}
      {listedForApproval ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="analysis-outcome-listed">
          {listedForApproval}
        </p>
      ) : null}
    </section>
  );
}
