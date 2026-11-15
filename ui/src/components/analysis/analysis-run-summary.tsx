"use client";

/**
 * Issue #907 — one-line summary of what feeds an analysis run, shown before the
 * user clicks "Run analysis": how many documents are selected and whether
 * free-text new requirements were provided.
 *
 * #1749 — selecting no document sends no `documentIds`, and the run reads every
 * ready document, so an empty selection reads "all N documents", never "0".
 * #2185 — that count leaves out the connectors' code rows: see
 * `defaultRunDocumentCount` (`lib/project-pipeline.ts`).
 * #2555 — and it says how many of them are still awaiting review
 * (`runAwaitingReviewCount`): "uses all 3 documents" counted one an analyst
 * could not tell was unapproved.
 */

interface Props {
  /** Number of documents selected for the run. */
  docCount: number;
  /** Number of documents the run reads when none is selected (`defaultRunDocumentCount`). */
  availableDocCount: number;
  /**
   * True when the loaded document list is only its first page, so
   * `availableDocCount` undercounts: the number is dropped rather than shown wrong.
   */
  listIsPartial?: boolean;
  /** Whether non-empty new-requirements text was provided. */
  hasRequirements: boolean;
  /** #2555 — how many of the run's documents are awaiting review (`runAwaitingReviewCount`). */
  awaitingReviewCount?: number;
}

const plural = (n: number): string => `${n} document${n === 1 ? "" : "s"}`;

function documentsLabel(
  docCount: number,
  availableDocCount: number,
  listIsPartial: boolean,
): string {
  if (docCount > 0) return plural(docCount);
  // The loaded page may hold only connector rows (a repository adds one per
  // file), so a partial list cannot say "no documents" or give a count.
  if (listIsPartial)
    return "all the project's ready documents, not its repository or database rows";
  if (availableDocCount === 0) return "no documents";
  if (availableDocCount === 1) return "the project's 1 document";
  return `all ${plural(availableDocCount)}`;
}

export function AnalysisRunSummary({
  docCount,
  availableDocCount,
  listIsPartial = false,
  hasRequirements,
  awaitingReviewCount = 0,
}: Props): React.ReactElement {
  const awaiting = awaitingReviewCount > 0 ? ` (${awaitingReviewCount} awaiting review)` : "";
  return (
    <p className="text-xs text-muted-foreground" data-testid="analysis-run-summary">
      This run uses {documentsLabel(docCount, availableDocCount, listIsPartial)}
      {awaiting} + requirements provided: {hasRequirements ? "yes" : "no"}.
    </p>
  );
}
