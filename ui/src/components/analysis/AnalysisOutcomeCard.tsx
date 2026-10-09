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
 */

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
 * `<N> [up to two words] requirement(s) was/were/have been <derived|…>`, where
 * N is digits or a number word up to twenty. Only this claim is rewritten; any
 * other number in the summary is the agent's own and left alone.
 */
const COUNT_CLAIM_RE = new RegExp(
  `\\b(\\d+|${NUMBER_WORDS.join("|")})(\\s+(?:[\\w-]+\\s+){0,2}?)requirements?(\\s+)(?:was|were|have been|has been)(\\s+(?:derived|identified|synthesi[sz]ed|generated|extracted|produced|created|recorded))\\b`,
  "gi",
);

function claimedCount(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS.indexOf(token.toLowerCase());
}

/** Correct a summary's derived-requirement count to the number of stored rows. */
export function reconcileRequirementCount(summary: string, stored: number): string {
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

export function AnalysisOutcomeCard({
  status,
  agentResults,
  requirementCount,
}: {
  status: string;
  agentResults: readonly OutcomeAgent[];
  /** Issue #994 — the requirement rows stored for this run. */
  requirementCount?: number;
}): React.ReactElement | null {
  if (status !== "completed") return null;
  const raw = agentResults.find((a) => a.agentKey === "synthesis")?.summary?.trim();
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
    </section>
  );
}
