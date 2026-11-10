"use client";

/**
 * Issue #907 — one-line summary of what feeds an analysis run, shown before the
 * user clicks "Run analysis": how many documents are selected and whether
 * free-text new requirements were provided.
 *
 * #1749 — selecting no document sends no `documentIds`, and the run reads every
 * ready document, so an empty selection reads "all N documents", never "0".
 */
interface Props {
  /** Number of documents selected for the run. */
  docCount: number;
  /** Number of ready documents the run reads when none is selected. */
  availableDocCount: number;
  /** Whether non-empty new-requirements text was provided. */
  hasRequirements: boolean;
}

const plural = (n: number): string => `${n} document${n === 1 ? "" : "s"}`;

function documentsLabel(docCount: number, availableDocCount: number): string {
  if (docCount > 0) return plural(docCount);
  if (availableDocCount === 0) return "no documents";
  if (availableDocCount === 1) return "the project's 1 document";
  return `all ${plural(availableDocCount)}`;
}

export function AnalysisRunSummary({
  docCount,
  availableDocCount,
  hasRequirements,
}: Props): React.ReactElement {
  return (
    <p className="text-xs text-muted-foreground" data-testid="analysis-run-summary">
      This run uses {documentsLabel(docCount, availableDocCount)} + requirements provided:{" "}
      {hasRequirements ? "yes" : "no"}.
    </p>
  );
}
