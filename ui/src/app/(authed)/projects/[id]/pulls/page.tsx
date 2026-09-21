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
import { queryKeys } from "@/lib/query-keys";
import { Card } from "@/components/ui/card";

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
      ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200"
      : verdict === "request_changes"
        ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
        : verdict === "comment"
          ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
          : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>
      {verdict ?? "—"}
    </span>
  );
}

function PrReviewRow({ row }: { row: PrReviewStateView }): React.ReactElement {
  return (
    <tr className="border-b border-zinc-200 dark:border-zinc-800">
      <td className="px-3 py-2 text-sm font-medium">
        <a
          className="text-blue-600 hover:underline dark:text-blue-400"
          href={row.prUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {row.repoOwner}/{row.repoName}#{row.prNumber}
        </a>
      </td>
      <td className="px-3 py-2 text-sm">
        <VerdictBadge verdict={row.lastVerdict} />
      </td>
      <td className="px-3 py-2 text-sm tabular-nums">
        {row.acVerdicts.length === 0
          ? "—"
          : `${formatPercent(row.acPassRate)} (${row.acVerdicts.filter((v) => v.verdict === "satisfied").length}/${row.acVerdicts.length})`}
      </td>
      <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
        {row.lastReviewedSha ? row.lastReviewedSha.slice(0, 7) : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
        {formatTimestamp(row.updatedAt)}
      </td>
      <td className="px-3 py-2 text-sm">
        {row.lastRunId ? (
          <Link
            className="text-blue-600 hover:underline dark:text-blue-400"
            href={`/runs/${row.lastRunId}`}
          >
            View run →
          </Link>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
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

  if (!id) {
    return <p className="p-4 text-sm text-zinc-500">Loading project…</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold">PR reviews</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          History of automated PR reviews triggered by the GitHub webhook.
        </p>
      </header>

      <Card className="overflow-hidden">
        {reviewsQuery.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Loading reviews…</p>
        ) : reviewsQuery.isError ? (
          <p className="p-6 text-sm text-red-600">Failed to load reviews. Try again later.</p>
        ) : (reviewsQuery.data?.items.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            No PR reviews recorded yet. They will appear here once the GitHub webhook fires for a
            connected repository.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">PR</th>
                  <th className="px-3 py-2 font-medium">Verdict</th>
                  <th className="px-3 py-2 font-medium">AC pass-rate</th>
                  <th className="px-3 py-2 font-medium">SHA</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium">Run</th>
                </tr>
              </thead>
              <tbody>
                {reviewsQuery.data?.items.map((row) => (
                  <PrReviewRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {reviewsQuery.data && (
        <p className="text-xs text-zinc-500">
          Showing {reviewsQuery.data.items.length} of {reviewsQuery.data.total} reviews.
        </p>
      )}
    </div>
  );
}
