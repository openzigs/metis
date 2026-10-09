"use client";

/**
 * #28 (epic #26) — the Requirements tab's landing page.
 *
 * Requirements, their findings, clarifying questions and approvals are reviewed
 * per analysis run on the analysis page; this page is the one entry point that
 * says how many are waiting and opens the right run. Baselines and Discussions
 * sit beside it in the Requirements sub-nav.
 *
 * #999 — requirements belong to the run that produced them, so the hub no
 * longer trusts the latest completed run alone: a newer run with nothing in it
 * yet read 0/0/0/0 and hid Request review over an earlier run's approved set.
 * It opens on the newest completed run that HAS requirements, says when it
 * skipped a newer one, and lets the user choose any completed run.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  analysisApi,
  type AnalysisListItem,
  type RequirementReviewStatus,
} from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RequestReviewCard } from "@/components/reviews/request-review-card";
import { useAuth } from "@/lib/auth-context";

const REVIEW_ORDER: ReadonlyArray<[RequirementReviewStatus, string]> = [
  ["draft", "Awaiting review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["deferred", "Deferred"],
];

/** All of a run's requirements, whatever their review status. */
function totalRequirements(run: Pick<AnalysisListItem, "requirementCounts">): number {
  const c = run.requirementCounts;
  return c.draft + c.approved + c.rejected + c.deferred;
}

/**
 * #999 — the run the hub opens on: the newest completed run that has any
 * requirements, else the newest completed run. `analyses` is newest first.
 */
export function defaultHubRunId(analyses: readonly AnalysisListItem[]): string | null {
  const completed = analyses.filter((a) => a.status === "completed");
  return (completed.find((a) => totalRequirements(a) > 0) ?? completed[0])?.id ?? null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function runLabel(run: AnalysisListItem): string {
  return `${new Date(run.startedAt).toLocaleString()} · ${plural(totalRequirements(run), "requirement")} (${run.requirementCounts.approved} approved)`;
}

function runHref(projectId: string, analysisId: string): string {
  return `/projects/${projectId}/analysis?analysisId=${encodeURIComponent(analysisId)}`;
}

export function RequirementsHub({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  // #732 — the server gates review creation on `review.create`.
  const canRequestReview = user?.permissions.includes("review.create") ?? false;
  const list = useQuery({
    queryKey: queryKeys.analyses.forProject(projectId),
    queryFn: () => analysisApi.listForProject(projectId),
    enabled: Boolean(projectId),
  });
  const analyses = list.data?.items ?? [];
  const completed = analyses.filter((a) => a.status === "completed");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const selected =
    completed.find((a) => a.id === chosenId) ??
    completed.find((a) => a.id === defaultHubRunId(analyses));
  const selectedId = selected?.id ?? null;
  // The run's requirement ids are what a review covers.
  const detail = useQuery({
    queryKey: queryKeys.analyses.detail(selectedId ?? ""),
    queryFn: () => analysisApi.get(selectedId as string),
    enabled: Boolean(selectedId),
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

  if (!selected) {
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

  const counts = selected.requirementCounts;
  const isLatest = selected.id === completed[0].id;
  // Newer completed runs the default skipped because they hold no requirements.
  const skippedEmpty = chosenId === null && !isLatest;
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4" data-testid="requirements-latest">
        <h2 className="text-lg font-semibold">
          {isLatest ? "Latest analysis" : "Analysis with requirements"}
        </h2>
        {completed.length > 1 ? (
          <div>
            <Label htmlFor="requirements-run">Analysis run</Label>
            <select
              id="requirements-run"
              data-testid="requirements-run-select"
              value={selected.id}
              onChange={(e) => setChosenId(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {completed.map((a) => (
                <option key={a.id} value={a.id}>
                  {runLabel(a)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {skippedEmpty ? (
          <p className="text-sm text-muted-foreground" data-testid="requirements-skipped-empty">
            The newest completed analysis has no requirements yet, so this shows the most recent one
            that does.
          </p>
        ) : null}
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
        <p className="text-sm text-muted-foreground">
          Findings, clarifying questions and approvals for a run are reviewed on its analysis page.
        </p>
        <Button asChild size="sm">
          <Link href={runHref(projectId, selected.id)} data-testid="requirements-review-latest">
            {counts.draft > 0
              ? `Review ${plural(counts.draft, "requirement")}`
              : isLatest
                ? "Open latest analysis"
                : "Open this analysis"}
          </Link>
        </Button>
        {canRequestReview && user && detail.data && detail.data.requirements.length > 0 ? (
          <RequestReviewCard
            key={selected.id}
            projectId={projectId}
            requirementIds={detail.data.requirements.map((r) => r.id)}
            currentUserId={user.id}
            approvedCount={counts.approved}
          />
        ) : null}
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-lg font-semibold">All analyses</h2>
        <ul className="divide-y" data-testid="requirements-runs">
          {analyses.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {new Date(a.startedAt).toLocaleString()} · {a.status} ·{" "}
                {plural(totalRequirements(a), "requirement")}
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
