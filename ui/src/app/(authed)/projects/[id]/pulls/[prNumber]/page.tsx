"use client";

/**
 * Epic #394 P2 review #404 — PR-review detail page.
 *
 * Shows the per-AC verdicts (with reasoning + evidence files) recorded
 * by the most recent automated review of a single PR, plus a Re-run
 * button that re-enqueues the review onto the worker queue. Mounted at
 * `/projects/[id]/pulls/[prNumber]?owner=…&repo=…` so the list page
 * can deep-link straight in.
 *
 * Permission surface:
 *   - Reading the detail requires `pr.review.read`.
 *   - Re-running the review requires `pr.review.manage`.
 *
 * 403 from either endpoint is rendered as a clear "you don't have
 * permission" message — NOT a generic error toast — so the page is
 * usable for read-only roles too (the Re-run button is shown but
 * surfaces a friendly message on click).
 */
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { prReviewsApi, type PrReviewStateView, type PrReviewVerdict } from "@/lib/pr-reviews-api";
import { queryKeys } from "@/lib/query-keys";
import { useJobLifecycle } from "@/hooks/use-job-events";
import { fireTerminalToast } from "@/lib/terminal-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";

function VerdictBadge({ verdict }: { verdict: string | null }): React.ReactElement {
  const tone =
    verdict === "satisfied" || verdict === "approve"
      ? "bg-success-muted text-success"
      : verdict === "not_satisfied" || verdict === "request_changes"
        ? "bg-destructive/10 text-destructive"
        : verdict === "uncertain" || verdict === "comment"
          ? "bg-info-muted text-info"
          : "bg-muted text-foreground";
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>
      {verdict ?? "—"}
    </span>
  );
}

function AcVerdictRow({ verdict }: { verdict: PrReviewVerdict }): React.ReactElement {
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-muted-foreground">{verdict.acId}</span>
        <VerdictBadge verdict={verdict.verdict} />
      </div>
      <p className="text-sm text-foreground">{verdict.reasoning}</p>
      {verdict.evidenceFiles.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Evidence</p>
          <ul className="space-y-0.5">
            {verdict.evidenceFiles.map((f) => (
              <li key={f} className="font-mono text-xs text-foreground">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * Epic #406 (#421) — LIVE re-review progress.
 *
 * Replaces the old "Refresh in a moment to see the new verdict" copy. Driven
 * by the `job:lifecycle` bus (kind `pr-review`) keyed by the `jobId` the
 * re-review POST returned. Renders a spinner while running, a progress bar at
 * the reported percent, and a terminal "complete" line on success. The failure
 * case is surfaced as a toast by the page, not here.
 */
export function ReReviewProgress({
  status,
  progress,
  message,
}: {
  status: "started" | "progress" | "completed";
  progress: number;
  message?: string;
}): React.ReactElement {
  const running = status !== "completed";
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-end gap-1"
      data-testid="re-review-progress"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {running ? (
          <span
            aria-hidden="true"
            data-testid="re-review-spinner"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-transparent"
          />
        ) : (
          <span aria-hidden="true" className="text-success">
            ✓
          </span>
        )}
        <span>
          {running
            ? (message ?? "Re-running review…")
            : (message ?? "Review complete — verdict updated.")}
        </span>
      </div>
      <div
        className="h-1 w-40 overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div
          className={`h-full rounded transition-all ${running ? "bg-info" : "bg-success"}`}
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      </div>
    </div>
  );
}

function PermissionDeniedSurface({ message }: { message: string }): React.ReactElement {
  return (
    <Card className="p-6">
      <h2 className="text-base font-medium text-foreground">Permission required</h2>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Ask a project administrator to grant the <code>pr.review.manage</code> permission to re-run
        reviews, or <code>pr.review.read</code> to view review history.
      </p>
    </Card>
  );
}

export default function ProjectPullDetailPage(): React.ReactElement {
  const params = useParams<{ id: string; prNumber: string }>();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const projectId = params?.id ?? "";
  const prNumber = Number(params?.prNumber ?? "0");
  const owner = search?.get("owner") ?? "";
  const repo = search?.get("repo") ?? "";

  // `denied`/`err` are surfaced inline (read-only roles + enqueue failures).
  // The old `ok` path ("Refresh in a moment…") is GONE — success now drives a
  // LIVE progress UI off the job bus instead (Epic #406 / #421).
  const [reRunMessage, setReRunMessage] = useState<{
    kind: "denied" | "err";
    text: string;
  } | null>(null);
  // The jobId returned by the re-review POST. While set, we subscribe to its
  // `job:lifecycle` stream and render live progress.
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: queryKeys.projects.prReviewDetail(projectId, prNumber, { owner, name: repo }),
    queryFn: () => prReviewsApi.detail(projectId, prNumber, { owner, name: repo }),
    enabled: Boolean(projectId && prNumber > 0 && owner && repo),
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Subscribe to the re-review job's lifecycle (kind `pr-review`). Returns the
  // latest event for `activeJobId`, or null when no job is in flight.
  const jobEvent = useJobLifecycle(activeJobId);

  // React to terminal transitions: on completion auto-refresh the verdict (no
  // manual reload), on failure surface a terminal error toast with the generic
  // server-supplied message (never a raw error). The error toast is now routed
  // through the module-level dedup (#425) so this surface and the global
  // header-mounted layer collapse to exactly ONE toast per re-review job. Either
  // way, stop watching.
  useEffect(() => {
    if (!jobEvent || jobEvent.jobId !== activeJobId) return;
    if (jobEvent.status === "completed") {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.prReviewDetail(projectId, prNumber, { owner, name: repo }),
      });
      setActiveJobId(null);
    } else if (jobEvent.status === "failed") {
      fireTerminalToast(jobEvent);
      setActiveJobId(null);
    }
  }, [jobEvent, activeJobId, queryClient, projectId, prNumber, owner, repo]);

  const reRun = useMutation({
    mutationFn: () => prReviewsApi.reReview(projectId, prNumber, { owner, name: repo }),
    onSuccess: (data) => {
      // Subscribe to live progress for THIS job — no "refresh in a moment" copy.
      setReRunMessage(null);
      setActiveJobId(data.jobId);
    },
    onError: (err) => {
      setActiveJobId(null);
      if (err instanceof ApiError && err.status === 403) {
        setReRunMessage({
          kind: "denied",
          text: "You don't have permission to re-run PR reviews. The pr.review.manage permission is required.",
        });
        return;
      }
      setReRunMessage({
        kind: "err",
        text: `Re-review failed: ${(err as Error).message ?? "unknown error"}.`,
      });
    },
  });

  if (!projectId || !prNumber || !owner || !repo) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Missing required URL parameters (projectId, prNumber, owner, repo).
      </p>
    );
  }

  if (detailQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading review…</p>;
  }

  // 403 surface — the user can SEE the page exists but is told why they can't read it.
  if (detailQuery.isError) {
    if (detailQuery.error instanceof ApiError && detailQuery.error.status === 403) {
      return (
        <div className="space-y-4 p-4">
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/pulls`}
            className="text-sm text-info hover:underline"
          >
            ← Back to PR reviews
          </Link>
          <PermissionDeniedSurface message="You don't have permission to view this PR review. The pr.review.read permission is required." />
        </div>
      );
    }
    if (detailQuery.error instanceof ApiError && detailQuery.error.status === 404) {
      return (
        <div className="space-y-4 p-4">
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/pulls`}
            className="text-sm text-info hover:underline"
          >
            ← Back to PR reviews
          </Link>
          <Card className="p-6 text-sm text-muted-foreground">
            No automated review has been recorded for this PR yet.
          </Card>
        </div>
      );
    }
    return (
      <p className="p-4 text-sm text-destructive">
        Failed to load review: {(detailQuery.error as Error).message ?? "unknown error"}.
      </p>
    );
  }

  const review = detailQuery.data as PrReviewStateView;

  return (
    <div className="space-y-4 p-4">
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/pulls`}
        className="text-sm text-info hover:underline"
      >
        ← Back to PR reviews
      </Link>

      <PageHeader
        title={`${review.repoOwner}/${review.repoName}#${review.prNumber}`}
        description={
          <>
            Last reviewed{" "}
            {review.lastReviewedSha ? (
              <code className="font-mono">{review.lastReviewedSha.slice(0, 7)}</code>
            ) : (
              "—"
            )}{" "}
            • Verdict: <VerdictBadge verdict={review.lastVerdict} />
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-2">
            <Button
              type="button"
              onClick={() => {
                setReRunMessage(null);
                reRun.mutate();
              }}
              disabled={reRun.isPending || activeJobId !== null}
              data-testid="re-run-button"
            >
              {reRun.isPending || activeJobId !== null ? "Re-running…" : "Re-run review"}
            </Button>
            {/* LIVE progress while a re-review job is in flight (#421). */}
            {activeJobId !== null && (
              <ReReviewProgress
                status={
                  jobEvent?.status === "completed"
                    ? "completed"
                    : jobEvent?.status === "progress"
                      ? "progress"
                      : "started"
                }
                progress={jobEvent?.progress ?? 0}
                message={jobEvent?.message}
              />
            )}
            {reRunMessage && (
              <p
                role="status"
                className={
                  reRunMessage.kind === "denied"
                    ? "text-xs text-warning"
                    : "text-xs text-destructive"
                }
              >
                {reRunMessage.text}
              </p>
            )}
          </div>
        }
      >
        <a
          href={review.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-sm text-info hover:underline"
        >
          View on GitHub ↗
        </a>
        {review.lastRunId && (
          <Link
            href={`/runs/${review.lastRunId}`}
            className="ml-3 mt-1 inline-block text-sm text-info hover:underline"
          >
            View AgentRun replay →
          </Link>
        )}
      </PageHeader>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-medium text-foreground">
          Acceptance criteria ({review.acVerdicts.length} total,{" "}
          {(review.acPassRate * 100).toFixed(0)}% satisfied)
        </h2>
        {review.acVerdicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No acceptance criteria were captured for this review.
          </p>
        ) : (
          <ul className="space-y-2">
            {review.acVerdicts.map((v) => (
              <AcVerdictRow key={v.acId} verdict={v} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
