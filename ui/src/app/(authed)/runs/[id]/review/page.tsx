"use client";

/**
 * Epic #192 (A.6) — `/runs/[id]/review` page.
 *
 * Renders the PR-Reviewer agent output: per-AC verdict matrix, inline
 * comment list, sandbox test results, and a link to the GitHub review.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { runsApi, type PrReviewRecord } from "@/lib/runs-api";
import { ReviewPanel } from "@/components/run-review/review-panel";

export default function RunReviewPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const q = useQuery({
    queryKey: ["run-review", id],
    queryFn: () => runsApi.review(id),
    enabled: !!id,
  });

  return (
    <div className="space-y-4 p-6" data-testid="run-review-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">PR Review</h1>
          <Link href={`/runs/${id}`} className="text-xs text-muted-foreground underline">
            ← back to run
          </Link>
        </div>
      </div>
      {q.isLoading && <Card className="p-6 text-sm">Loading review…</Card>}
      {q.isError && (
        <Card className="p-6 text-sm text-red-600" data-testid="run-review-error">
          Failed to load review.
        </Card>
      )}
      {q.data && q.data.review === null && (
        <Card className="p-6 text-sm" data-testid="run-review-empty">
          No PR-reviewer record was attached to this run yet.
        </Card>
      )}
      {q.data?.review && <ReviewPanel review={q.data.review as PrReviewRecord} />}
    </div>
  );
}
