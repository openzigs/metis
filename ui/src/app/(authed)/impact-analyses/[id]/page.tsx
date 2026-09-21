/**
 * Epic #159 (#165) — Impact analysis results view.
 *
 * Polls a single analysis until it reaches a terminal state, then renders the
 * per-project code-impact breakdown.
 */
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ImpactItemView } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { projectsApi } from "@/lib/projects-api";
import { impactAnalysisApi } from "@/lib/impact-analysis-api";
import { triggerDownload } from "@/lib/plugins-api";
import {
  useDeleteTableFeedback,
  useImpactAnalysis,
  useImpactDrift,
  useMarkTableFeedback,
  useRerunImpactAnalysis,
} from "@/lib/impact-analysis-hooks";
import { useAuth } from "@/lib/auth-context";
import { renderInlineCode } from "@/lib/inline-code-text";
import { ProjectImpactSectionWithUsage } from "@/components/impact/project-impact-section";
import { SharedTableImpactSection } from "@/components/impact/shared-table-impact-section";
import { RequirementImpactMatrix } from "@/components/impact/requirement-impact-matrix";
import { ImpactDriftSection } from "@/components/impact/impact-drift-section";

const STATUS_VARIANT: Record<string, "destructive" | "default" | "secondary" | "outline"> = {
  completed: "default",
  running: "secondary",
  pending: "secondary",
  failed: "destructive",
};

export default function ImpactAnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { data, isLoading, isError } = useImpactAnalysis(id);

  const projectsQuery = useQuery({
    queryKey: ["impact", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    retry: false,
  });
  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQuery.data?.items ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsQuery.data]);

  const grouped = useMemo(() => {
    const byProject = new Map<string, ImpactItemView[]>();
    for (const pid of data?.projectIds ?? []) byProject.set(pid, []);
    for (const item of data?.items ?? []) {
      const list = byProject.get(item.projectId) ?? [];
      list.push(item);
      byProject.set(item.projectId, list);
    }
    return byProject;
  }, [data]);

  if (isLoading) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="impact-detail-loading">
        Loading impact analysis…
      </p>
    );
  }

  if (isError || !data) {
    return (
      <Card
        className="m-2 border-destructive p-4 text-sm text-destructive"
        data-testid="impact-detail-error"
      >
        Could not load this impact analysis.
      </Card>
    );
  }

  const isRunning = data.status === "pending" || data.status === "running";
  const canExport = data.status === "completed" && data.items.length > 0;

  return (
    <ImpactAnalysisDetailView
      data={data}
      isRunning={isRunning}
      canExport={canExport}
      grouped={grouped}
      projectName={(pid) => projectName.get(pid) ?? pid}
    />
  );
}

// #963 — export + Jira-publish actions are their own component so the mutation
// hooks live outside the early-return guards above (rules-of-hooks).
function ImpactAnalysisDetailView({
  data,
  isRunning,
  canExport,
  grouped,
  projectName,
}: {
  data: NonNullable<ReturnType<typeof useImpactAnalysis>["data"]>;
  isRunning: boolean;
  canExport: boolean;
  grouped: Map<string, ImpactItemView[]>;
  projectName: (projectId: string) => string;
}) {
  const exportMutation = useMutation({
    mutationFn: () => impactAnalysisApi.exportReport(data.id),
    onSuccess: ({ blob, filename }) => triggerDownload(blob, filename),
  });
  const publishMutation = useMutation({
    mutationFn: () => impactAnalysisApi.publishToJira(data.id),
  });

  // Issue #966 — table relevance feedback (capture-only; no engine/filter effect).
  const { user } = useAuth();
  const markFeedback = useMarkTableFeedback(data.id);
  const deleteFeedback = useDeleteTableFeedback(data.id);

  // Issue #965 — re-run against the current graph + the drift diff vs the original.
  const rerun = useRerunImpactAnalysis();
  const driftQuery = useImpactDrift(
    data.id,
    data.status === "completed" && Boolean(data.rerunOfId),
  );

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="impact-detail-root">
      <header className="space-y-1">
        <Link
          href="/impact-analyses"
          className="text-xs text-muted-foreground hover:underline"
          data-testid="impact-detail-back"
        >
          ← Back to impact analyses
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Impact analysis</h1>
          <Badge
            variant={STATUS_VARIANT[data.status] ?? "outline"}
            data-testid="impact-detail-status"
          >
            {data.status}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {data.projectIds.length} project(s) · {data.totalImpactedSymbols} impacted symbol(s)
        </p>

        {/* #963 — export + publish actions. Enabled once the run has completed
            with at least one impact item; publishing to Jira is idempotent. */}
        <div className="flex flex-wrap items-center gap-2 pt-1" data-testid="impact-detail-actions">
          <Button
            variant="outline"
            size="sm"
            data-testid="impact-export-md"
            disabled={!canExport || exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
          >
            {exportMutation.isPending ? "Exporting…" : "Export markdown"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="impact-publish-jira"
            disabled={!canExport || publishMutation.isPending}
            onClick={() => publishMutation.mutate()}
          >
            {publishMutation.isPending ? "Publishing…" : "Publish to Jira"}
          </Button>
          {publishMutation.isSuccess ? (
            <a
              href={publishMutation.data.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline"
              data-testid="impact-publish-jira-link"
            >
              Published {publishMutation.data.issueKey} →
            </a>
          ) : null}
          {/* #965 — re-run against the CURRENT code graph; a new run is created and
              linked back to this one so its drift diff shows what changed. */}
          <Button
            variant="outline"
            size="sm"
            data-testid="impact-rerun"
            disabled={!canExport || rerun.isPending}
            onClick={() => rerun.mutate({ id: data.id })}
          >
            {rerun.isPending ? "Re-running…" : "Re-run"}
          </Button>
          {rerun.isSuccess ? (
            <Link
              href={`/impact-analyses/${rerun.data.id}`}
              className="text-xs text-primary hover:underline"
              data-testid="impact-rerun-link"
            >
              View re-run →
            </Link>
          ) : null}
        </div>
        {/* #965 — lineage crumb: this run re-executes an earlier one. */}
        {data.rerunOfId ? (
          <p className="text-xs text-muted-foreground" data-testid="impact-detail-rerun-of">
            Re-run of{" "}
            <Link
              href={`/impact-analyses/${data.rerunOfId}`}
              className="text-primary hover:underline"
            >
              the original analysis
            </Link>
            .
          </p>
        ) : null}
        {exportMutation.isError ? (
          <p className="text-xs text-destructive" data-testid="impact-export-error">
            {(exportMutation.error as Error).message}
          </p>
        ) : null}
        {publishMutation.isError ? (
          <p className="text-xs text-destructive" data-testid="impact-publish-error">
            {(publishMutation.error as Error).message}
          </p>
        ) : null}
      </header>

      {/* #1004 — THE REQUIREMENT this run analysed, verbatim. The results page
          previously never stated it: the requirement text appeared nowhere on
          screen (nor in the export), so a reader could not tell which
          requirement produced the report. Rendered as plain text with preserved
          line breaks — never parsed as markdown/HTML (untrusted user input;
          React escapes it). Absent for runs started from a document rather than
          pasted text, where `sourceText` is null. */}
      {data.sourceText && data.sourceText.trim().length > 0 ? (
        <Card className="p-4" data-testid="impact-detail-requirement-card">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Requirement analysed</p>
          <p
            className="whitespace-pre-wrap text-sm text-foreground"
            data-testid="impact-detail-requirement-text"
          >
            {data.sourceText}
          </p>
        </Card>
      ) : null}

      {/* #932 — run-level BA-readable overview, rendered as a summary block ABOVE
          the raw per-project impact tables. Falls back to the deterministic
          one-line overview when the LLM summarizer did not run.
          #985 (#3) — tokenize `` `backtick` `` spans into inline <code> instead
          of showing raw backticks. Untrusted LLM text — never parsed as HTML. */}
      {data.summary ? (
        <Card className="p-4" data-testid="impact-detail-summary-card">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Summary</p>
          <p className="text-sm text-foreground" data-testid="impact-detail-summary">
            {renderInlineCode(data.summary)}
          </p>
        </Card>
      ) : null}

      {/* #965 — drift diff vs the original run (only rendered for re-runs). */}
      <ImpactDriftSection report={driftQuery.data} />

      {data.status === "failed" ? (
        <Card
          className="border-destructive p-4 text-sm text-destructive"
          data-testid="impact-detail-failed"
        >
          {data.errorMessage ?? "The impact analysis failed."}
        </Card>
      ) : isRunning ? (
        <p className="text-sm text-muted-foreground" data-testid="impact-detail-running">
          Analysis in progress — this page updates automatically.
        </p>
      ) : data.items.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground" data-testid="impact-detail-empty">
          No code impact detected for the supplied requirement change.
        </Card>
      ) : (
        <div className="space-y-8" data-testid="impact-detail-projects">
          {/* #964 — ranked requirement×project impact matrix. Rows are the
              requirements extracted from the source document, ranked by aggregate
              impact; each cell drills down to the existing per-item detail. A
              single-project run degrades to a ranked list. */}
          <RequirementImpactMatrix
            items={data.items}
            projects={data.projectIds.map((pid) => ({ id: pid, name: projectName(pid) }))}
          />
          {/* #956 — run-level shared-table rollup (multi-project runs only). */}
          <SharedTableImpactSection
            sharedTableImpacts={data.sharedTableImpacts ?? []}
            projectName={(pid) => projectName(pid)}
          />
          {[...grouped.entries()].map(([projectId, items]) => (
            <ProjectImpactSectionWithUsage
              key={projectId}
              projectId={projectId}
              projectName={projectName(projectId)}
              items={items}
              currentUserId={user?.id ?? null}
              onMarkFeedback={(itemId, input) => markFeedback.mutate({ itemId, ...input })}
              onDeleteFeedback={(itemId, feedbackId) =>
                deleteFeedback.mutate({ itemId, feedbackId })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
