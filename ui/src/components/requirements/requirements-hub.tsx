"use client";

/**
 * #28 (epic #26) — the Requirements tab's landing page.
 *
 * Requirements, their findings, clarifying questions and approvals are reviewed
 * per analysis run on the analysis page; this page is the one entry point that
 * says how many are waiting and opens the right run. Baselines and Discussions
 * sit beside it in the Requirements sub-nav.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { analysisApi, type RequirementReviewStatus } from "@/lib/analysis-api";
import { latestCompletedAnalysisId } from "@/lib/project-pipeline";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const REVIEW_ORDER: ReadonlyArray<[RequirementReviewStatus, string]> = [
  ["draft", "Awaiting review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["deferred", "Deferred"],
];

/** How many requirements sit in each review status. */
export function countByReviewStatus(
  requirements: ReadonlyArray<{ reviewStatus: RequirementReviewStatus }>,
): Record<RequirementReviewStatus, number> {
  const counts: Record<RequirementReviewStatus, number> = {
    draft: 0,
    approved: 0,
    rejected: 0,
    deferred: 0,
  };
  for (const r of requirements) counts[r.reviewStatus] = (counts[r.reviewStatus] ?? 0) + 1;
  return counts;
}

function runHref(projectId: string, analysisId: string): string {
  return `/projects/${projectId}/analysis?analysisId=${encodeURIComponent(analysisId)}`;
}

export function RequirementsHub({ projectId }: { projectId: string }) {
  const list = useQuery({
    queryKey: queryKeys.analyses.forProject(projectId),
    queryFn: () => analysisApi.listForProject(projectId),
    enabled: Boolean(projectId),
  });
  const analyses = list.data?.items ?? [];
  const latestId = latestCompletedAnalysisId({ analyses });
  const latest = useQuery({
    queryKey: queryKeys.analyses.detail(latestId ?? ""),
    queryFn: () => analysisApi.get(latestId as string),
    enabled: Boolean(latestId),
  });

  if (list.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading requirements…
      </p>
    );
  }
  if (list.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load this project&apos;s analyses.
      </p>
    );
  }

  if (!latestId) {
    return (
      <Card className="space-y-3 p-4" data-testid="requirements-empty">
        <h2 className="text-lg font-semibold">No requirements yet</h2>
        <p className="text-sm text-muted-foreground">
          Requirements come out of a Requirements Analysis run over this project&apos;s sources.
        </p>
        <Button asChild size="sm">
          <Link href={`/projects/${projectId}/analysis`}>Run analysis</Link>
        </Button>
      </Card>
    );
  }

  const counts = latest.data ? countByReviewStatus(latest.data.requirements) : null;
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4" data-testid="requirements-latest">
        <h2 className="text-lg font-semibold">Latest analysis</h2>
        {counts ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {REVIEW_ORDER.map(([status, label]) => (
              <div key={status} className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold" data-testid={`requirements-count-${status}`}>
                  {counts[status]}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Counting requirements…
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Findings, clarifying questions and approvals for a run are reviewed on its analysis page.
        </p>
        <Button asChild size="sm">
          <Link href={runHref(projectId, latestId)} data-testid="requirements-review-latest">
            {counts && counts.draft > 0
              ? `Review ${counts.draft} requirement${counts.draft === 1 ? "" : "s"}`
              : "Open latest analysis"}
          </Link>
        </Button>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-lg font-semibold">All analyses</h2>
        <ul className="divide-y" data-testid="requirements-runs">
          {analyses.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {new Date(a.startedAt).toLocaleString()} · {a.status}
              </span>
              <Link href={runHref(projectId, a.id)} className="underline">
                Open
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
