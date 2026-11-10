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
  /**
   * True when the loaded document list is only its first page, so
   * `availableDocCount` undercounts: the number is dropped rather than shown wrong.
   */
  listIsPartial?: boolean;
  /** Whether non-empty new-requirements text was provided. */
  hasRequirements: boolean;
}

const plural = (n: number): string => `${n} document${n === 1 ? "" : "s"}`;

function documentsLabel(
  docCount: number,
  availableDocCount: number,
  listIsPartial: boolean,
): string {
  if (docCount > 0) return plural(docCount);
  if (listIsPartial) return "all the project's documents";
  if (availableDocCount === 0) return "no documents";
  if (availableDocCount === 1) return "the project's 1 document";
  return `all ${plural(availableDocCount)}`;
}

export function AnalysisRunSummary({
  docCount,
  availableDocCount,
  listIsPartial = false,
  hasRequirements,
}: Props): React.ReactElement {
  return (
    <p className="text-xs text-muted-foreground" data-testid="analysis-run-summary">
      This run uses {documentsLabel(docCount, availableDocCount, listIsPartial)} + requirements
      provided: {hasRequirements ? "yes" : "no"}.
    </p>
  );
}
