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
 */

interface OutcomeAgent {
  agentKey: string;
  summary: string | null;
}

export function AnalysisOutcomeCard({
  status,
  agentResults,
}: {
  status: string;
  agentResults: readonly OutcomeAgent[];
}): React.ReactElement | null {
  if (status !== "completed") return null;
  const summary = agentResults.find((a) => a.agentKey === "synthesis")?.summary?.trim();
  if (!summary) return null;

  return (
    <section
      data-testid="analysis-outcome-card"
      aria-labelledby="analysis-outcome-heading"
      className="rounded border border-emerald-800/40 bg-emerald-950/20 p-4"
    >
      <h4
        id="analysis-outcome-heading"
        className="mb-2 text-sm font-semibold uppercase tracking-wide text-emerald-300"
      >
        Outcome
      </h4>
      <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-zinc-200">
        {summary}
      </p>
    </section>
  );
}
