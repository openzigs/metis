"use client";

/**
 * Epic #394 P2 (#404) — PR-review history page.
 *
 * Lists every `PrReviewState` row scoped to this project. Each row deep-
 * links to the GitHub PR and (when present) the AgentRun replay view so
 * a reviewer can pivot from the dashboard to the live conversation that
 * produced the verdict.
 */
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { prReviewsApi, type PrReviewStateView } from "@/lib/pr-reviews-api";
import { projectsApi } from "@/lib/projects-api";
import { PR_REVIEW_UNPRICED_LIMIT_TEXT, prReviewLimitIsSet } from "@/lib/pr-review-copy";
import { queryKeys } from "@/lib/query-keys";
import { ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function VerdictBadge({ verdict }: { verdict: string | null }): React.ReactElement {
  const tone =
    verdict === "approve"
      ? "bg-success-muted text-success"
      : verdict === "request_changes"
        ? "bg-destructive/10 text-destructive"
        : verdict === "comment"
          ? "bg-info-muted text-info"
          : "bg-muted text-foreground";
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>
      {verdict ?? "—"}
    </span>
  );
}

/**
 * #1470 — why a pull request was not reviewed, in words. Keys are the
 * server's `PrReviewStateSkipReason` values.
 */
const SKIP_REASONS: ReadonlyMap<string, string> = new Map([
  [
    "no_linked_issue",
    "The pull request does not link an issue. Add “Closes #<number>” to its description.",
  ],
  ["no_published_issue", "The linked issue was not published from this project."],
  ["no_acceptance_criteria", "The linked issue has no acceptance criteria to check."],
  ["budget_exceeded", "This month’s spending limit for automatic reviews was reached."],
  [
    "budget_unpriced",
    "This project’s AI model has no price, so its monthly limit cannot be enforced. Give the model a price in the MODEL_PRICES setting, or remove the limit.",
  ],
  ["diff_too_large", "The changes are larger than this project’s review size limit."],
  ["diff_unavailable", "The changes could not be read from GitHub."],
  ["auto_review_disabled", "Automatic PR review was switched off for this project."],
  [
    "review_not_configured",
    "This project has no AI model or GitHub token the review can use. Check the project’s AI model and its repository connection’s token.",
  ],
]);

function skipReasonText(reason: string | null): string {
  return (reason && SKIP_REASONS.get(reason)) || "No reason was recorded.";
}

function StatusCell({ row }: { row: PrReviewStateView }): React.ReactElement {
  // A row written before #1470 has no status; a verdict means it was reviewed.
  const status = row.lastStatus ?? (row.lastVerdict ? "reviewed" : null);
  if (status === "reviewed") return <span>Reviewed</span>;
  if (status === "failed") {
    return <span className="text-destructive">Review failed. Open the run for details.</span>;
  }
  if (status === "skipped") {
    return (
      <span>
        <span className="font-medium">Not reviewed.</span>{" "}
        <span className="text-muted-foreground">{skipReasonText(row.lastSkipReason)}</span>
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function PrReviewRow({
  row,
  projectId,
}: {
  row: PrReviewStateView;
  projectId: string;
}): React.ReactElement {
  const detailHref = `/projects/${encodeURIComponent(projectId)}/pulls/${row.prNumber}?${new URLSearchParams({ owner: row.repoOwner, repo: row.repoName }).toString()}`;
  return (
    <tr className="border-b border-border">
      <td className="px-3 py-2 text-sm font-medium">
        <a
          className="text-info hover:underline"
          href={row.prUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {row.repoOwner}/{row.repoName}#{row.prNumber}
        </a>
      </td>
      <td className="px-3 py-2 text-sm" data-testid="pr-review-status">
        <StatusCell row={row} />
      </td>
      <td className="px-3 py-2 text-sm">
        <VerdictBadge verdict={row.lastVerdict} />
      </td>
      <td className="px-3 py-2 text-sm">
        {row.lastReviewUrl?.startsWith("https://") ? (
          <a
            className="text-info hover:underline"
            href={row.lastReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Review on GitHub
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-sm tabular-nums">
        {row.acVerdicts.length === 0
          ? "—"
          : `${formatPercent(row.acPassRate)} (${row.acVerdicts.filter((v) => v.verdict === "satisfied").length}/${row.acVerdicts.length})`}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {row.lastReviewedSha ? row.lastReviewedSha.slice(0, 7) : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{formatTimestamp(row.updatedAt)}</td>
      <td className="px-3 py-2 text-sm">
        {row.lastRunId ? (
          <Link className="text-info hover:underline" href={`/runs/${row.lastRunId}`}>
            View run →
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-sm">
        <Link className="text-info hover:underline" href={detailHref}>
          Details →
        </Link>
      </td>
    </tr>
  );
}

export default function ProjectPullsPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const reviewsQuery = useQuery({
    queryKey: queryKeys.projects.prReviews(id, { limit: 50 }),
    queryFn: () => prReviewsApi.list(id, { limit: 50 }),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  });
  // #1169 — a delivery for a project with automatic review off is stored and
  // answered 200 but never reviewed; say so instead of promising a review.
  const projectQuery = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });
  const reviewOff = projectQuery.data ? !projectQuery.data.autoReviewPrs : false;
  // #1169 — past the monthly limit, the worker skips each review before any
  // model call (`checkBudget`); say so here, where the missing reviews show.
  const budgetQuery = useQuery({
    queryKey: queryKeys.projects.prReviewBudget(id),
    queryFn: () => projectsApi.getPrReviewBudget(id),
    enabled: Boolean(id) && projectQuery.data?.autoReviewPrs === true,
  });
  const limitReached = !reviewOff && budgetQuery.data ? !budgetQuery.data.allowed : false;
  // #1471 — with a limit set, an unpriced model is never reviewed (`budget_unpriced`).
  const unpricedLimit =
    !reviewOff && budgetQuery.data
      ? prReviewLimitIsSet(budgetQuery.data.capCents) && budgetQuery.data.modelPriced === false
      : false;

  if (!id) {
    return <p className="p-4 text-sm text-muted-foreground">Loading project…</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="PR reviews"
        description="History of automated PR reviews triggered by the GitHub webhook."
      />

      {reviewOff ? (
        <p
          className="rounded-md border border-border bg-muted p-3 text-sm"
          data-testid="auto-review-off"
        >
          Automatic PR review is off for this project, so pull requests are not reviewed. Turn it on
          in{" "}
          <Link className="text-info hover:underline" href={`/projects/${id}/settings`}>
            Project settings
          </Link>
          .
        </p>
      ) : null}

      {limitReached && budgetQuery.data ? (
        <p
          className="rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning"
          data-testid="auto-review-limit-reached"
        >
          This month&apos;s limit for automatic PR reviews is reached, so new pull requests are not
          being reviewed until {new Date(budgetQuery.data.resetAt).toLocaleDateString()}. Raise the
          limit in{" "}
          <Link className="underline" href={`/projects/${id}/settings`}>
            Project settings
          </Link>{" "}
          to resume sooner.
        </p>
      ) : null}

      {unpricedLimit ? (
        <p
          className="rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning"
          data-testid="auto-review-unpriced"
        >
          {PR_REVIEW_UNPRICED_LIMIT_TEXT}{" "}
          <Link className="underline" href={`/projects/${id}/settings`}>
            Project settings
          </Link>
        </p>
      ) : null}

      <Card className="overflow-hidden">
        {reviewsQuery.isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading reviews…</p>
        ) : reviewsQuery.isError ? (
          reviewsQuery.error instanceof ApiError && reviewsQuery.error.status === 403 ? (
            <p className="p-6 text-sm text-muted-foreground" data-testid="pr-reviews-forbidden">
              You don&apos;t have permission to see PR reviews. Ask an administrator for access.
            </p>
          ) : (
            <p className="p-6 text-sm text-destructive">Failed to load reviews. Try again later.</p>
          )
        ) : (reviewsQuery.data?.items.length ?? 0) === 0 ? (
          reviewOff ? (
            <p className="p-6 text-sm text-muted-foreground">No PR reviews recorded yet.</p>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              No PR reviews recorded yet. They will appear here once the GitHub webhook fires for a
              connected repository.
            </p>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">PR</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Verdict</th>
                  <th className="px-3 py-2 font-medium">Review</th>
                  <th className="px-3 py-2 font-medium">AC pass-rate</th>
                  <th className="px-3 py-2 font-medium">SHA</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reviewsQuery.data?.items.map((row) => (
                  <PrReviewRow key={row.id} row={row} projectId={id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {reviewsQuery.data && (
        <p className="text-xs text-muted-foreground">
          Showing {reviewsQuery.data.items.length} of {reviewsQuery.data.total} reviews.
        </p>
      )}
    </div>
  );
}
