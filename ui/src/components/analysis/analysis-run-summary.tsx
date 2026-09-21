"use client";

/**
 * Issue #907 — one-line summary of what feeds an analysis run, shown before the
 * user clicks "Run analysis": how many documents are selected and whether
 * free-text new requirements were provided.
 */
interface Props {
  /** Number of documents selected for the run. */
  docCount: number;
  /** Whether non-empty new-requirements text was provided. */
  hasRequirements: boolean;
}

export function AnalysisRunSummary({ docCount, hasRequirements }: Props): React.ReactElement {
  const docLabel = `${docCount} document${docCount === 1 ? "" : "s"}`;
  return (
    <p className="text-xs text-zinc-400" data-testid="analysis-run-summary">
      This run uses {docLabel} + requirements provided: {hasRequirements ? "yes" : "no"}.
    </p>
  );
}
