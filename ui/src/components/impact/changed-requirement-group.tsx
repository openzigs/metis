/**
 * ChangedRequirementGroup — Epic #159 (#165).
 *
 * Renders one impacted requirement within a project: its severity/score and
 * the affected symbols as two lists (#1036) — the files to edit, kept small, and
 * the wider blast radius to review. The split is `impactSymbolRole` from
 * `@metis/shared`, the same rule the API's `editCandidateFiles` uses.
 *
 * #1762 — when the server recorded how the change was seeded (`seedEvidence`),
 * the files to edit come in the server's edit order, each with why it was
 * chosen ({@link EditCandidateFiles}), and "not found" is said plainly. Without
 * it, the group renders exactly as before.
 *
 * #1965 — a file is (repository, path): a project can connect several
 * repositories and the same path can exist in more than one. Each such file is
 * listed and counted on its own, and when the project has more than one
 * repository every file heading names its repository.
 */
"use client";

import {
  impactFileKey,
  impactRepoCount,
  impactSymbolRole,
  type ApiSurfaceUntouched,
  type ImpactItemView,
  type ImpactSymbolRepoRef,
  type ImpactTableFeedbackVerdict,
  type ProjectObjectUsage,
} from "@metis/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { renderInlineCode } from "@/lib/inline-code-text";
import { AffectedSymbolRow } from "./affected-symbol-row";
import { AffectedTablesSection } from "./affected-tables-section";
import { ColumnProposalsSection } from "./column-proposals-section";
import { EditCandidateFiles, isDoubtful, orderEditFiles } from "./edit-candidate-files";
import { ImpactFileLabel } from "./impact-file-label";
import { useImpactProjectHasManyRepos, useImpactSymbolRepo } from "./impact-symbol-repo-context";

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
  /** #1762 — the item's project, named when METIS could not find the code. */
  projectName?: string | null;
  /**
   * #2115 — set when this project reaches the run's change only through a
   * provider's API and the change touched none of that API: these matches are
   * word overlap, not impact, and the card says so.
   */
  apiSurfaceUntouched?: ApiSurfaceUntouched | null;
}

interface FileGroup {
  /** #1965 — (repository, path), from `impactFileKey`. */
  key: string;
  filePath: string;
  repo: ImpactSymbolRepoRef | null;
  symbols: ImpactItemView["affectedSymbols"];
}

/** Group symbols by file — (repository, path) — preserving first-seen file order. */
function groupByFile(symbols: ImpactItemView["affectedSymbols"]): FileGroup[] {
  const byFile = new Map<string, FileGroup>();
  for (const s of symbols) {
    const key = impactFileKey(s);
    const group = byFile.get(key);
    if (group) group.symbols.push(s);
    else byFile.set(key, { key, filePath: s.filePath, repo: s.repo ?? null, symbols: [s] });
  }
  return [...byFile.values()];
}

export function ChangedRequirementGroup({
  item,
  crossProjectUsage,
  currentUserId,
  onMarkFeedback,
  onDeleteFeedback,
  projectName,
  apiSurfaceUntouched,
}: ChangedRequirementGroupProps) {
  // #992 — the item's project repo (from the page's provider) for symbol links.
  const repo = useImpactSymbolRepo(item.projectId);
  // #1965 — name each file's repository when the project has more than one (or,
  // without the page's provider, when this item's code comes from more than one).
  const projectHasManyRepos = useImpactProjectHasManyRepos(item.projectId);
  const showRepo =
    projectHasManyRepos || impactRepoCount([...item.affectedSymbols, ...item.affectedTests]) > 1;
  const repoOf = (group: { repo: ImpactSymbolRepoRef | null }) => (showRepo ? group.repo : null);
  // #1036 — two lists. Strongest edit candidates first so the card is scannable
  // top-down; each file once, with the symbols that put it there.
  const editCandidates = item.affectedSymbols
    .filter((s) => impactSymbolRole(s) === "edit-candidate")
    .sort((a, b) => b.confidence - a.confidence);
  const radius = item.affectedSymbols.filter((s) => impactSymbolRole(s) === "blast-radius");

  const editFileGroups = groupByFile(editCandidates);
  const radiusFileGroups = groupByFile(radius);
  // #1762 — with seed evidence: the server's edit order, each file's sources and
  // verdict; a doubtful file is listed but not counted as a file to edit.
  const editRows = item.seedEvidence ? orderEditFiles(editFileGroups, item.seedEvidence) : null;
  const editFiles = new Set(
    editRows
      ? editRows.filter((r) => !isDoubtful(r)).map((r) => r.key)
      : editFileGroups.map((g) => g.key),
  );
  const editFileCount = editFiles.size;
  // "More to review": the blast-radius files and (#1820) the doubtful files, each
  // once. A file to edit is not "more to review".
  const reviewFiles = new Set([
    ...radiusFileGroups.map((g) => g.key),
    ...(editRows ?? []).filter(isDoubtful).map((r) => r.key),
  ]);
  const reviewOnlyFileCount = [...reviewFiles].filter((f) => !editFiles.has(f)).length;
  // #1965 — the blast radius lists every reviewed file, files to edit included;
  // its heading says how many of them are also files to edit, so its count and
  // the headline's "more to review" read as one story.
  const radiusAlsoEditCount = radiusFileGroups.filter((g) => editFiles.has(g.key)).length;

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
              {editFileCount} {editFileCount === 1 ? "file" : "files"} to edit
            </span>{" "}
            · {reviewOnlyFileCount} more to review
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
          className="rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
          data-testid="weak-match-banner"
          role="status"
        >
          {item.matchQualityReason === "scattered"
            ? "Low-confidence match — the requirement matched code across several unrelated areas; results may be incomplete."
            : "Low-confidence match — the requirement didn't clearly name an entity/screen; results may be incomplete. Consider naming the feature, table, or module."}
        </p>
      ) : null}

      {/* #2115 — the project is an API consumer of a provider whose change in
          this run touched none of its API surface. */}
      {apiSurfaceUntouched ? (
        <p
          className="rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
          data-testid="api-surface-untouched-banner"
          role="status"
        >
          Low-confidence match — this project uses {apiSurfaceUntouched.providerProjectName} through
          its API, and this change touches none of that API. These matches likely share words with
          the change, not its effect.
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
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
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

      {editRows ? (
        <EditCandidateFiles
          rows={editRows}
          repo={repo}
          projectLabel={projectName ?? "this project"}
          staleSetAside={item.seedEvidence?.agentCitations?.demotedStaleCitations ?? 0}
          showRepo={showRepo}
        />
      ) : editCandidates.length > 0 ? (
        <div data-testid="edit-candidates">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Files to edit — the code this change most likely has to touch
          </p>
          <div className="space-y-3">
            {editFileGroups.map((group) => (
              <div key={group.key} data-testid="edit-candidate-file-group">
                <ImpactFileLabel
                  className="mb-1 truncate font-mono text-xs text-foreground"
                  filePath={group.filePath}
                  repo={repoOf(group)}
                />
                <ul className="space-y-1">
                  {group.symbols.map((s) => (
                    <AffectedSymbolRow key={s.id} symbol={s} repo={repo} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
            {/* #1892 — the toggle names the blast radius's own size and no "to
                review" count: the headline's "more to review" also counts doubtful
                files to edit, so a second "to review" number here disagreed. */}
            Blast radius — {radius.length} {radius.length === 1 ? "symbol" : "symbols"} in{" "}
            {radiusFileGroups.length} {radiusFileGroups.length === 1 ? "file" : "files"}
            {radiusAlsoEditCount > 0
              ? `, ${radiusAlsoEditCount} of them also ${radiusAlsoEditCount === 1 ? "a file" : "files"} to edit`
              : ""}{" "}
            (callers, data writers, related code)
          </summary>
          <div className="mt-2 space-y-3">
            {radiusFileGroups.map((group) => (
              <div key={group.key} data-testid="blast-radius-file-group">
                <ImpactFileLabel
                  className="mb-1 truncate font-mono text-xs text-muted-foreground"
                  filePath={group.filePath}
                  repo={repoOf(group)}
                >
                  {` · ${group.symbols.length}`}
                </ImpactFileLabel>
                <ul className="space-y-1">
                  {group.symbols.map((s) => (
                    <AffectedSymbolRow key={s.id} symbol={s} repo={repo} />
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
              <div key={group.key} data-testid="affected-tests-file-group">
                <ImpactFileLabel
                  className="mb-1 truncate font-mono text-xs text-muted-foreground"
                  filePath={group.filePath}
                  repo={repoOf(group)}
                >
                  {` · ${group.symbols.length}`}
                </ImpactFileLabel>
                <ul className="space-y-1">
                  {group.symbols.map((s) => (
                    <AffectedSymbolRow key={s.id} symbol={s} repo={repo} />
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

      {/* #1051 — the proposed columns that are NOT in the tables above (#791): an
          optional settings column, and columns an existing write path already
          covers. Directly under the proposed changes, so what was ruled out is
          read next to what was kept. Each renders nothing when empty. */}
      <ColumnProposalsSection
        variant="optional"
        proposals={item.optionalColumnProposals}
        repo={repo}
      />
      <ColumnProposalsSection
        variant="rejected"
        proposals={item.droppedColumnProposals}
        repo={repo}
      />
      {/* #791 — a proposed column the gate did not rule on is kept, and named
          here with the reason so it does not read as vetted. */}
      <ColumnProposalsSection
        variant="unchecked"
        proposals={item.uncheckedColumnProposals ?? []}
        repo={repo}
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
