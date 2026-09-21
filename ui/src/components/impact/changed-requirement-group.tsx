/**
 * ChangedRequirementGroup — Epic #159 (#165).
 *
 * Renders one impacted requirement within a project: its severity/score and
 * the affected symbols split into direct hits vs the transitive blast radius.
 */
"use client";

import type { ImpactItemView, ImpactTableFeedbackVerdict, ProjectObjectUsage } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { renderInlineCode } from "@/lib/inline-code-text";
import { AffectedSymbolRow } from "./affected-symbol-row";
import { AffectedTablesSection } from "./affected-tables-section";

const SEVERITY_VARIANT: Record<
  ImpactItemView["severity"],
  "destructive" | "default" | "secondary" | "outline"
> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
};

export interface ChangedRequirementGroupProps {
  item: ImpactItemView;
  /**
   * Epic #295 Phase 4 (#310) — map of canonical object name -> the OTHER
   * projects in the workspace that use it. Forwarded to
   * {@link AffectedTablesSection} so each affected table shows a "used by N
   * projects" badge. Omitted in single-project views.
   */
  crossProjectUsage?: Record<string, ProjectObjectUsage[]>;
  /** Issue #966 — the signed-in caller's user id, to identify "my" mark. */
  currentUserId?: string | null;
  /**
   * Issue #966 — mark (or re-mark) an affected table relevant/not-relevant on
   * THIS item. The thumbs affordance renders only when this is provided, so
   * every existing caller that omits it renders unchanged.
   */
  onMarkFeedback?: (
    itemId: string,
    input: { tableName: string; verdict: ImpactTableFeedbackVerdict },
  ) => void;
  /** Issue #966 — remove a feedback mark on THIS item. */
  onDeleteFeedback?: (itemId: string, feedbackId: string) => void;
}

/** Group blast-radius symbols by file, preserving first-seen file order. */
function groupByFile(
  symbols: ImpactItemView["affectedSymbols"],
): Array<{ filePath: string; symbols: ImpactItemView["affectedSymbols"] }> {
  const order: string[] = [];
  const byFile = new Map<string, ImpactItemView["affectedSymbols"]>();
  for (const s of symbols) {
    const bucket = byFile.get(s.filePath);
    if (bucket) bucket.push(s);
    else {
      byFile.set(s.filePath, [s]);
      order.push(s.filePath);
    }
  }
  return order.map((filePath) => ({ filePath, symbols: byFile.get(filePath)! }));
}

export function ChangedRequirementGroup({
  item,
  crossProjectUsage,
  currentUserId,
  onMarkFeedback,
  onDeleteFeedback,
}: ChangedRequirementGroupProps) {
  // Strongest hits first so the card is scannable top-down.
  const direct = item.affectedSymbols
    .filter((s) => s.relation === "direct")
    .sort((a, b) => b.confidence - a.confidence);
  const radius = item.affectedSymbols.filter((s) => s.relation !== "direct");

  const directFileCount = new Set(direct.map((s) => s.filePath)).size;
  const radiusFileGroups = groupByFile(radius);

  // #962 — the impacted test files, grouped out of the prod blast radius, and the
  // untested write-path callouts. Both are deterministic QA-handoff signals.
  const testGroups = groupByFile(item.affectedTests);
  const testFileCount = testGroups.length;
  const writePathGaps = item.writePathGaps;
  // #1023 — the tangential header counts TABLES (what the section renders
  // below), not the table+column rows in the bucket, so the number agrees with
  // the per-table disclosures. A table with 16 column rows is ONE pruned table.
  const secondaryTableCount = new Set(item.affectedTablesSecondary.map((t) => t.tableName)).size;

  return (
    <Card className="space-y-3 p-4" data-testid="changed-requirement-group">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">
            {item.requirementTitle ?? "Requirement change"}
          </h3>
          <p className="text-xs text-muted-foreground" data-testid="impact-headline">
            <span className="font-medium text-foreground">
              {direct.length} directly affected across {directFileCount} files
            </span>{" "}
            · {radius.length} callers
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[item.severity]} data-testid="requirement-severity">
            {item.severity}
          </Badge>
          <span className="text-xs text-muted-foreground" data-testid="requirement-impact-score">
            impact {Math.round(item.impactScore * 100)}%
          </span>
        </div>
      </div>

      {/* #961/#994 — weak requirement→code match banner. Shown when the requirement's
          wording seeded poorly (deterministic `matchQuality`), so a thin/uncertain
          result reads as "re-word the requirement" rather than a confident answer.
          The copy is conditioned on `matchQualityReason` (#994) so it states the TRUE
          cause instead of always claiming "didn't name an entity" — that wording is
          only accurate for the zero-seed case, not the scattered-seeds case.
          Distinct from the #936 relevance tiers (per-table) and #957 risk badges. */}
      {item.matchQuality === "weak" ? (
        <p
          className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
          data-testid="weak-match-banner"
          role="status"
        >
          {item.matchQualityReason === "scattered"
            ? "Low-confidence match — the requirement matched code across several unrelated areas; results may be incomplete."
            : "Low-confidence match — the requirement didn't clearly name an entity/screen; results may be incomplete. Consider naming the feature, table, or module."}
        </p>
      ) : null}

      {/* #932 — BA-readable per-item narrative from the deterministic facts.
          Rendered above the raw symbol/table detail so a business analyst gets a
          plain-English read first. Absent when the summarizer did not run.
          #985 (#3) — the summarizer emits `` `backtick` `` markdown for
          identifiers; tokenize it into inline <code> instead of showing raw
          backticks. Untrusted LLM text — never parsed as HTML. */}
      {item.summary ? (
        <p
          className="rounded border border-border/60 bg-muted/40 px-3 py-2 text-sm text-foreground"
          data-testid="impact-item-summary"
        >
          {renderInlineCode(item.summary)}
        </p>
      ) : null}

      {/* #962 — untested write-path callout. Each impacted table whose write path
          (the symbols that write/persist-to it) is reached by NO test is flagged
          so QA verifies the mutation before shipping. Absent when every written
          table is covered (or has no write path). */}
      {writePathGaps.length > 0 ? (
        <div
          className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200"
          data-testid="write-path-gap-callout"
          role="status"
        >
          <p className="font-medium">
            {writePathGaps.length === 1
              ? "1 impacted table has an untested write path"
              : `${writePathGaps.length} impacted tables have untested write paths`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {/* #1012 — gaps are per WRITING SYMBOL. When a table has other writers
                that ARE tested, say so explicitly: "1 of 2 write paths untested"
                reads very differently to QA than "no test covers this table". */}
            {writePathGaps.map((gap) => (
              <li key={gap.tableName} data-testid="write-path-gap-row">
                {gap.coveredWritingSymbols.length > 0 ? (
                  <>
                    {gap.writingSymbols.length} of{" "}
                    {gap.writingSymbols.length + gap.coveredWritingSymbols.length}{" "}
                    <span className="font-mono">{gap.tableName}</span> write paths are untested
                  </>
                ) : (
                  <>
                    No test covers the <span className="font-mono">{gap.tableName}</span> write path
                  </>
                )}
                {gap.writingSymbols.length > 0 ? (
                  <span className="text-xs opacity-80">
                    {" "}
                    (<span className="font-mono">{gap.writingSymbols.join(", ")}</span>)
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {direct.length > 0 ? (
        <div data-testid="direct-impacts">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Directly affected</p>
          <ul className="space-y-1">
            {direct.map((s) => (
              <AffectedSymbolRow key={s.id} symbol={s} />
            ))}
          </ul>
        </div>
      ) : null}

      {radius.length > 0 ? (
        <details
          className="rounded border border-border/60 px-3 py-2"
          data-testid="blast-radius-impacts"
        >
          <summary
            className="cursor-pointer text-xs font-medium text-muted-foreground"
            data-testid="blast-radius-toggle"
          >
            Blast radius — {radius.length} symbols across {radiusFileGroups.length} files
            (callers/importers)
          </summary>
          <div className="mt-2 space-y-3">
            {radiusFileGroups.map((group) => (
              <div key={group.filePath} data-testid="blast-radius-file-group">
                <p className="mb-1 truncate font-mono text-xs text-muted-foreground">
                  {group.filePath} · {group.symbols.length}
                </p>
                <ul className="space-y-1">
                  {group.symbols.map((s) => (
                    <AffectedSymbolRow key={s.id} symbol={s} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {/* #962 — the project's own tests that cover (call/import) the impacted code,
          grouped out of the prod blast radius with a count. Collapsed so they
          don't crowd the prod symbols a BA scans first. */}
      {item.affectedTests.length > 0 ? (
        <details className="rounded border border-border/60 px-3 py-2" data-testid="affected-tests">
          <summary
            className="cursor-pointer text-xs font-medium text-muted-foreground"
            data-testid="affected-tests-toggle"
          >
            Tests ({item.affectedTests.length}) — covering the impacted code across {testFileCount}{" "}
            {testFileCount === 1 ? "file" : "files"}
          </summary>
          <div className="mt-2 space-y-3">
            {testGroups.map((group) => (
              <div key={group.filePath} data-testid="affected-tests-file-group">
                <p className="mb-1 truncate font-mono text-xs text-muted-foreground">
                  {group.filePath} · {group.symbols.length}
                </p>
                <ul className="space-y-1">
                  {group.symbols.map((s) => (
                    <AffectedSymbolRow key={s.id} symbol={s} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <AffectedTablesSection
        tables={item.affectedTables}
        crossProjectUsage={crossProjectUsage}
        feedback={item.feedback}
        currentUserId={currentUserId}
        onMarkFeedback={onMarkFeedback ? (input) => onMarkFeedback(item.id, input) : undefined}
        onDeleteFeedback={
          onDeleteFeedback ? (feedbackId) => onDeleteFeedback(item.id, feedbackId) : undefined
        }
      />

      {/* #936 — low-confidence secondary bucket: tables the relevance filter
          judged tangential (`unlikely`) and pruned from the primary list for
          precision. Kept visible (recall safety) but collapsed + de-emphasized
          so they don't crowd the likely impacts. */}
      {item.affectedTablesSecondary.length > 0 ? (
        <details
          className="rounded border border-border/60 px-3 py-2"
          data-testid="schema-impact-secondary"
        >
          <summary
            className="cursor-pointer text-xs font-medium text-muted-foreground"
            data-testid="schema-impact-secondary-toggle"
          >
            {`Possibly-tangential tables — ${secondaryTableCount} ${secondaryTableCount === 1 ? "table" : "tables"} pruned as low-relevance (review only)`}
          </summary>
          <div className="mt-2 opacity-70">
            <AffectedTablesSection
              tables={item.affectedTablesSecondary}
              crossProjectUsage={crossProjectUsage}
              feedback={item.feedback}
              currentUserId={currentUserId}
              onMarkFeedback={
                onMarkFeedback ? (input) => onMarkFeedback(item.id, input) : undefined
              }
              onDeleteFeedback={
                onDeleteFeedback ? (feedbackId) => onDeleteFeedback(item.id, feedbackId) : undefined
              }
            />
          </div>
        </details>
      ) : null}
    </Card>
  );
}
