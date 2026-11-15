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
 *
 * #2548 — and when it reads every document, it says how many restricted from
 * the user it leaves out: a run reads with its starter's access (#2506).
 */

interface Props {
  /** Number of documents selected for the run. */
  docCount: number;
  /** Number of documents the run reads when none is selected (`defaultRunDocumentCount`). */
  availableDocCount: number;
  /** #2548 — ready documents restricted from the user (`restrictedRunDocumentCount`). */
  restrictedDocCount?: number;
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
  // The loaded page may hold only connector rows (a repository adds one per
  // file), so a partial list cannot say "no documents" or give a count.
  if (listIsPartial)
    return "all the project's ready documents, not its repository or database rows";
  if (availableDocCount === 0) return "no documents";
  if (availableDocCount === 1) return "the project's 1 document";
  return `all ${plural(availableDocCount)}`;
}

/** #2548 — the restricted documents a run with none ticked does not read, or null. */
export function restrictedLeftOutLabel(
  docCount: number,
  restrictedDocCount: number,
  listIsPartial: boolean,
): string | null {
  if (docCount > 0 || restrictedDocCount === 0) return null;
  const n = listIsPartial ? `At least ${plural(restrictedDocCount)}` : plural(restrictedDocCount);
  return `${n} you don't have access to ${restrictedDocCount === 1 ? "is" : "are"} left out.`;
}

export function AnalysisRunSummary({
  docCount,
  availableDocCount,
  restrictedDocCount = 0,
  listIsPartial = false,
  hasRequirements,
}: Props): React.ReactElement {
  const leftOut = restrictedLeftOutLabel(docCount, restrictedDocCount, listIsPartial);
  return (
    <p className="text-xs text-muted-foreground" data-testid="analysis-run-summary">
      This run uses {documentsLabel(docCount, availableDocCount, listIsPartial)} + requirements
      provided: {hasRequirements ? "yes" : "no"}.
      {leftOut ? <span data-testid="analysis-run-summary-restricted"> {leftOut}</span> : null}
    </p>
  );
}
