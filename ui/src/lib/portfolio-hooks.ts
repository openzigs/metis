/**
 * Epic #1608 (#1626) — TanStack Query hooks for portfolio assessments.
 *
 * The detail view reads the assessment from `GET /portfolio-assessments/:id`
 * only, never from local state, so reloading the page mid-run picks the same
 * run up where it is. A running assessment is polled until it reaches a
 * terminal state; its `job:{id}` lifecycle events refresh it sooner.
 *
 * #1673 — the reads share `portfolioAssessmentReadRateLimiter` (300 per 15
 * minutes), so the poll must not spend it: it stops on an answer that will not
 * change (403, 404), waits out a 429, slows down while job events are arriving
 * (they drive the refreshes then), and progress events re-read at most once per
 * `PORTFOLIO_PROGRESS_REFRESH_MS`.
 */
"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  CreatePortfolioAssessmentInput,
  JobLifecycleEvent,
  PortfolioAssessmentListItem,
  PortfolioAssessmentView,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { portfolioApi } from "@/lib/portfolio-api";
import { useAppMutation } from "@/lib/use-app-mutation";
import { useJobLifecycle } from "@/hooks/use-job-events";

export const portfolioKeys = {
  all: ["portfolio-assessments"] as const,
  list: () => [...portfolioKeys.all, "list"] as const,
  /** Under `list()`, so invalidating the list refreshes each product's too. */
  productList: (productId: string) => [...portfolioKeys.list(), productId] as const,
  detail: (id: string) => [...portfolioKeys.all, "detail", id] as const,
};

/** How often a running assessment is re-read when no socket event arrives. */
export const PORTFOLIO_POLL_MS = 3_000;
/**
 * #1673 — the fallback poll while job events arrive, and the least wait after a
 * 429. The events drive the refreshes then; the poll only covers a missed one.
 */
export const PORTFOLIO_POLL_BACKOFF_MS = 15_000;
/** A job event this recent means the socket is delivering. */
export const PORTFOLIO_SOCKET_LIVE_MS = 30_000;
/** Progress events re-read the assessment at most this often; transitions always do. */
export const PORTFOLIO_PROGRESS_REFRESH_MS = 10_000;

export function isTerminalStatus(status: PortfolioAssessmentView["status"] | undefined): boolean {
  return status === "completed" || status === "failed";
}

/** A read error no later read will change: the check is gone, or no longer the reader's. */
export function isFinalReadError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/**
 * #1673 — how long until the next poll of an assessment, or false to stop.
 * `lastEventAt` is when its last job event arrived (0 for never).
 */
export function portfolioPollInterval(
  state: { data?: Pick<PortfolioAssessmentView, "status">; error: unknown },
  lastEventAt: number,
  now: number,
): number | false {
  if (isTerminalStatus(state.data?.status) || isFinalReadError(state.error)) return false;
  if (state.error instanceof ApiError && state.error.status === 429) {
    return Math.max(state.error.retryAfterMs ?? 0, PORTFOLIO_POLL_BACKOFF_MS);
  }
  return now - lastEventAt < PORTFOLIO_SOCKET_LIVE_MS
    ? PORTFOLIO_POLL_BACKOFF_MS
    : PORTFOLIO_POLL_MS;
}

/**
 * One assessment, plus the latest lifecycle event of its job (for progress).
 * Polls while it runs; a lifecycle transition re-reads it at once.
 */
export function usePortfolioAssessment(id: string | null | undefined): {
  query: UseQueryResult<PortfolioAssessmentView>;
  job: JobLifecycleEvent | null;
} {
  const queryClient = useQueryClient();
  const lastEventAt = useRef(0);
  const lastRefreshAt = useRef(0);
  const query = useQuery<PortfolioAssessmentView>({
    queryKey: portfolioKeys.detail(id ?? ""),
    queryFn: () => portfolioApi.get(id as string),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (q) => portfolioPollInterval(q.state, lastEventAt.current, Date.now()),
  });

  const job = useJobLifecycle(id);
  useEffect(() => {
    if (!job || !id) return;
    const now = Date.now();
    lastEventAt.current = now;
    if (job.status === "progress" && now - lastRefreshAt.current < PORTFOLIO_PROGRESS_REFRESH_MS) {
      return;
    }
    lastRefreshAt.current = now;
    void queryClient.invalidateQueries({ queryKey: portfolioKeys.detail(id) });
    if (job.status === "completed" || job.status === "failed") {
      void queryClient.invalidateQueries({ queryKey: portfolioKeys.list() });
    }
  }, [job, id, queryClient]);

  return { query, job };
}

/** The newest assessments naming `productId`, or the caller's own. */
export function usePortfolioAssessments(productId?: string) {
  return useQuery<PortfolioAssessmentListItem[]>({
    queryKey: productId ? portfolioKeys.productList(productId) : portfolioKeys.list(),
    queryFn: () => portfolioApi.list(productId),
    retry: false,
  });
}

export function useCreatePortfolioAssessment() {
  return useAppMutation({
    mutationFn: (input: CreatePortfolioAssessmentInput) => portfolioApi.create(input),
    successMessage: "Portfolio check started",
    // The form shows its own error inline, next to the button that failed.
    errorMessage: false,
    invalidateKeys: [portfolioKeys.list()],
  });
}
