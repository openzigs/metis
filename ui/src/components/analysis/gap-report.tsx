"use client";

/**
 * Issue #742 (Epic #728) — per-requirement gap report panel.
 *
 * One card per synthesized requirement, assembled server-side from persisted
 * analysis data (no LLM call): the CITED current-implementation evidence (reusing
 * the #734 `CodeCitation` locator), the gap analysis (the requirement's linked
 * gap-path findings, surfaced verbatim), and the effort estimate (the existing
 * `storyPoints`; null ⇒ "unestimated"). The #736 coverage badge and #740
 * verification badge are surfaced inline.
 *
 * A requirement whose findings cite no code renders an explicit "nothing found in
 * code" marker rather than a hallucinated summary (no-fabrication rule).
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  analysisApi,
  type AnalysisRetrievalHealth,
  type GapReportFindingRef,
  type GapReportRequirement,
  type SqlLineageCoverage,
} from "@/lib/analysis-api";
import { triggerDownload } from "@/lib/plugins-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CodeCitation } from "@/components/findings/code-citation";
import { CoverageBadge } from "@/components/analysis/CoverageBadge";
import { VerificationBadge } from "@/components/analysis/VerificationBadge";
import { VerdictBadge } from "@/components/analysis/VerdictBadge";
import { GapReportSchemaSection } from "@/components/analysis/gap-report-schema-section";

interface Props {
  projectId: string;
  analysisId: string;
  /** Only fetch once the run has completed (requirements exist). */
  enabled?: boolean;
}

/** Effort estimate badge — the existing story-points scale, honest about nulls. */
function EffortBadge({ storyPoints }: { storyPoints: number | null }): React.ReactElement {
  if (storyPoints == null) {
    return (
      <span
        data-testid="gap-effort-unestimated"
        className="inline-flex items-center rounded-full border border-border/60 bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground"
        title="No story-point estimate is recorded for this requirement."
      >
        Unestimated
      </span>
    );
  }
  return (
    <span
      data-testid="gap-effort-estimate"
      className="inline-flex items-center rounded-full border border-info/50 bg-info-muted px-2 py-0.5 text-[11px] font-semibold text-info"
      title="Effort estimate in story points (existing requirement estimate)."
    >
      {storyPoints} {storyPoints === 1 ? "point" : "points"}
    </span>
  );
}

/** One finding, rendered verbatim with its code citations. */
function FindingItem({ f }: { f: GapReportFindingRef }): React.ReactElement {
  return (
    <li
      data-testid={`gap-finding-${f.id}`}
      className="rounded border border-border/70 bg-muted/40 p-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">{f.title}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {f.severity}
        </span>
        <VerdictBadge verdict={f.verdict} />
        <VerificationBadge status={f.verificationStatus} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{f.body}</p>
      {f.citations.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {f.citations.map((c) => (
            <CodeCitation key={`${c.filePath}:${c.startLine}-${c.endLine}`} citation={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function GapReportCard({
  req,
  projectId,
}: {
  req: GapReportRequirement;
  projectId: string;
}): React.ReactElement {
  const { citations, hasEvidence, citedFindingCount } = req.currentImplementation;
  return (
    <Card
      data-testid={`gap-report-card-${req.requirementId}`}
      data-verdict={req.verdict ?? "none"}
      className="space-y-3 border-border bg-muted/30 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h5 className="text-sm font-semibold text-foreground">{req.title}</h5>
          <p className="mt-0.5 text-xs text-muted-foreground">{req.body}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {/* Issue #773 — the verdict LEADS: it is the field a BA acts on. */}
          <VerdictBadge verdict={req.verdict} />
          <EffortBadge storyPoints={req.storyPoints} />
          <CoverageBadge coverage={req.coverage} />
          <VerificationBadge status={req.verificationStatus} />
        </div>
      </div>

      {/* Current implementation — cited, code-grounded evidence of what exists. */}
      <section data-testid="gap-current-impl" className="space-y-1">
        <h6 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Current implementation
        </h6>
        {hasEvidence ? (
          <>
            <p className="text-xs text-muted-foreground">
              Grounded in {citedFindingCount} cited{" "}
              {citedFindingCount === 1 ? "finding" : "findings"}:
            </p>
            <ul className="space-y-1">
              {citations.map((c) => (
                <CodeCitation key={`${c.filePath}:${c.startLine}-${c.endLine}`} citation={c} />
              ))}
            </ul>
          </>
        ) : (
          <p data-testid="gap-no-evidence" className="text-xs text-warning">
            Nothing found in code for this requirement. Review it manually — no source evidence was
            linked.
          </p>
        )}
      </section>

      {/* Gap — the requirement's linked gap-path findings, surfaced verbatim.
          Issue #773: ONLY findings whose verdict cleared the evidence threshold
          appear here. A finding we could not verify is rendered below, under its
          own heading, so "we could not check" never reads as "you must build it". */}
      <section data-testid="gap-description" className="space-y-1.5">
        <h6 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Gap
        </h6>
        {req.gapFindings.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No gap findings were linked to this requirement.
          </p>
        ) : (
          <ul className="space-y-2">
            {req.gapFindings.map((f) => (
              <FindingItem key={f.id} f={f} />
            ))}
          </ul>
        )}
      </section>

      {/* Issue #773 — the could-not-verify block. Visually AND semantically
          distinct from the gap section above: different heading, different hue,
          and copy that states plainly this is not a confirmed gap. */}
      {req.unverifiedFindings.length > 0 ? (
        <section
          data-testid="gap-could-not-verify"
          className="space-y-1.5 rounded border border-dashed border-muted-foreground/60 bg-muted p-2"
        >
          <h6 className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
            Could not verify — not a confirmed gap
          </h6>
          <p className="text-xs text-foreground">
            Code search did not return usable evidence for the claims below, so the analysis could
            not tell whether this requirement is already implemented. Do not plan work from these
            without re-running the analysis or checking the code yourself.
          </p>
          <ul className="space-y-2">
            {req.unverifiedFindings.map((f) => (
              <FindingItem key={f.id} f={f} />
            ))}
          </ul>
        </section>
      ) : null}

      {/* Issue #827 — the DATABASE twin of the gap findings: affected tables /
          columns with suggested DDL (review-only), live-schema reconciliation,
          risk, and cross-project consumers. Renders nothing when the requirement
          has no schema impact. */}
      <GapReportSchemaSection projectId={projectId} changes={req.databaseChanges} />
    </Card>
  );
}

/**
 * Issue #773 — SEARCHED-SCOPE PROVENANCE. An absence claim only means something
 * relative to what was actually searched, so a `gap-confirmed` verdict is
 * auditable here: these are the queries the code agent really ran and whether they
 * hit. When retrieval was degraded this panel leads with the warning instead.
 */
function RetrievalPanel({ retrieval }: { retrieval: AnalysisRetrievalHealth }): React.ReactElement {
  // #19 — a run can be degraded because most requirements went unverified while
  // its searches worked; the headline must not then blame code search.
  const mostlyUnverified =
    !retrieval.starved && (retrieval.unverifiedRequirements ?? 0) * 2 > retrieval.requirementCount;
  const degradedHeadline = mostlyUnverified
    ? "Most requirements could not be verified against the code — “not found” results are unreliable"
    : "Code search returned little usable evidence — “not found” results are unreliable";
  return (
    <details
      data-testid="gap-searched-scope"
      data-degraded={retrieval.degraded ? "true" : "false"}
      className={`rounded border p-2 text-xs ${
        retrieval.degraded
          ? "border-dashed border-muted-foreground/60 bg-muted text-foreground"
          : "border-border bg-muted/30 text-muted-foreground"
      }`}
    >
      <summary className="cursor-pointer font-semibold">
        {retrieval.degraded ? degradedHeadline : "Searched scope"}{" "}
        <span className="font-normal">
          ({retrieval.successfulSearches} of {retrieval.totalCalls} retrieval calls returned results
          {/* #1236 — budget cut-off is `exhausted`, not `starved`. */}
          {retrieval.exhausted ? "; the investigation was cut short by its budget" : ""}
          {/* #19 — a run can clear the search threshold and still check almost nothing. */}
          {retrieval.starved ? "; far fewer code searches than requirements" : ""}
          {retrieval.unverifiedRequirements
            ? `; ${retrieval.unverifiedRequirements} of ${retrieval.requirementCount} requirements could not be verified`
            : ""}
          )
        </span>
      </summary>
      {retrieval.searchedScope.length === 0 ? (
        <p className="mt-2">No code searches were recorded for this run.</p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {retrieval.searchedScope.map((s, i) => (
            <li key={`${s.tool}-${i}`} data-testid="searched-scope-entry" className="font-mono">
              {/* #773 — an ERRORED call (the tool failed) and an empty one (the tool
                  worked; the code is not there) mean opposite things: the first says
                  nothing about the codebase, the second is the evidence a gap is made
                  of. The panel must not render them both as a flat "miss". */}
              <span
                className={
                  s.errored ? "text-warning" : s.hit ? "text-success" : "text-muted-foreground"
                }
              >
                {s.errored ? "error" : s.hit ? "hit" : "no results"}
              </span>{" "}
              {s.tool}
              {s.query ? `("${s.query}")` : "()"}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * Issue #895 (Epic #882 Phase 3) — SQL-lineage unresolved/dynamic coverage.
 *
 * Surfaces the ACTIONABLE inverse of the resolved percentage — "N% of table
 * edges are dynamically resolved / need manual confirmation" — with a
 * per-source breakdown and a drillable list of the unresolved edges (each a
 * copyable `filePath` locator + the reason it could not be resolved:
 * dynamic runtime-built SQL vs a coarse Tier-1 catalog dependency). There is
 * no in-app file viewer, so the locator is inert text, matching `CodeCitation`.
 * Renders nothing when coverage is absent (pre-#895 reports or projects with
 * no schema lineage edges).
 */
function SqlLineageCoveragePanel({
  coverage,
}: {
  coverage: SqlLineageCoverage;
}): React.ReactElement | null {
  if (coverage.totalEdges === 0) return null;
  const resolvedPct = coverage.coveragePercent ?? 0;
  const unresolvedPct = Math.round((100 - resolvedPct) * 10) / 10;
  const anyUnresolved = coverage.unresolvedEdges > 0;

  const reasonLabel = (reason: "dynamic" | "coarse-catalog"): string =>
    reason === "dynamic"
      ? "dynamic (runtime-built SQL)"
      : "coarse Tier-1 catalog (object-level, direction unknown)";

  return (
    <details
      data-testid="sql-lineage-coverage"
      data-unresolved={anyUnresolved ? "true" : "false"}
      className={`rounded border p-2 text-xs ${
        anyUnresolved
          ? "border-warning/40 bg-warning-muted text-warning"
          : "border-border bg-muted/30 text-muted-foreground"
      }`}
    >
      <summary className="cursor-pointer font-semibold">
        SQL-lineage coverage{" "}
        <span className="font-normal" data-testid="sql-lineage-coverage-headline">
          ({unresolvedPct}% of table edges are dynamically resolved / need manual confirmation —{" "}
          {coverage.unresolvedEdges} of {coverage.totalEdges} edges; {resolvedPct}% resolved)
        </span>
      </summary>
      {!anyUnresolved ? (
        <p className="mt-2">
          Every schema edge for this project was resolved precisely — nothing needs manual
          confirmation.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <ul className="space-y-0.5" data-testid="sql-lineage-coverage-by-source">
            {Object.entries(coverage.bySource)
              .filter(([, v]) => v.unresolved > 0)
              .map(([source, v]) => (
                <li key={source} className="font-mono">
                  <span className="text-warning">{source}</span>: {v.unresolved} of {v.total}{" "}
                  unresolved
                </li>
              ))}
          </ul>
          {coverage.unresolvedRefs.length > 0 ? (
            <ul className="space-y-0.5">
              {coverage.unresolvedRefs.map((ref) => (
                <li key={ref.edgeId} data-testid="sql-lineage-unresolved-ref" className="font-mono">
                  <span className="text-warning">{reasonLabel(ref.reason)}</span> {ref.filePath}
                  {ref.toQualifiedName ? ` → ${ref.toQualifiedName}` : ""}
                  {ref.placeholder ? ` (${ref.placeholder})` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {coverage.unresolvedEdges > coverage.unresolvedRefs.length ? (
            <p className="text-muted-foreground">
              …and {coverage.unresolvedEdges - coverage.unresolvedRefs.length} more unresolved
              edge(s) not listed.
            </p>
          ) : null}
        </div>
      )}
    </details>
  );
}

export function GapReport({
  projectId,
  analysisId,
  enabled = true,
}: Props): React.ReactElement | null {
  const query = useQuery({
    queryKey: ["gap-report", projectId, analysisId],
    queryFn: () => analysisApi.getGapReport(projectId, analysisId),
    enabled,
  });

  const exportMutation = useMutation({
    mutationFn: () => analysisApi.exportAnalysisReport(projectId, analysisId),
    onSuccess: ({ blob, filename }) => triggerDownload(blob, filename),
  });

  if (!enabled) return null;

  const requirements = query.data?.requirements ?? [];
  const retrieval = query.data?.retrieval ?? null;
  const sqlLineageCoverage = query.data?.sqlLineageCoverage ?? null;

  return (
    <section data-testid="gap-report" className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Gap report
          </h4>
          <p className="text-xs text-muted-foreground">
            Per requirement: current implementation (with code citations), the gap, and the effort
            estimate. Assembled from the analysis — no claim without a citation or an explicit
            no-evidence marker.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="analysis-report-export-md"
          className="shrink-0"
          disabled={requirements.length === 0 || exportMutation.isPending}
          onClick={() => exportMutation.mutate()}
        >
          Export report (Markdown)
        </Button>
      </div>

      {exportMutation.isError ? (
        <p className="text-xs text-destructive" role="alert">
          Export failed. Please try again.
        </p>
      ) : null}

      {retrieval ? <RetrievalPanel retrieval={retrieval} /> : null}

      {sqlLineageCoverage ? <SqlLineageCoveragePanel coverage={sqlLineageCoverage} /> : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading gap report…</p>
      ) : query.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Could not load the gap report.
        </p>
      ) : requirements.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No requirements to report on yet. Complete an analysis to populate the gap report.
        </p>
      ) : (
        <div className="space-y-2">
          {requirements.map((req) => (
            <GapReportCard key={req.requirementId} req={req} projectId={projectId} />
          ))}
        </div>
      )}
    </section>
  );
}
