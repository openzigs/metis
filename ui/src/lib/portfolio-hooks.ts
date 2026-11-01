/**
 * Epic #1608 (#1626) — TanStack Query hooks for portfolio assessments.
 *
 * The detail view reads the assessment from `GET /portfolio-assessments/:id`
 * only, never from local state, so reloading the page mid-run picks the same
 * run up where it is. A running assessment is polled until it reaches a
 * terminal state; its `job:{id}` lifecycle events refresh it sooner.
 */
"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  CreatePortfolioAssessmentInput,
  JobLifecycleEvent,
  PortfolioAssessmentListItem,
  PortfolioAssessmentView,
} from "@metis/shared";
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

export function isTerminalStatus(status: PortfolioAssessmentView["status"] | undefined): boolean {
  return status === "completed" || status === "failed";
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
  const query = useQuery<PortfolioAssessmentView>({
    queryKey: portfolioKeys.detail(id ?? ""),
    queryFn: () => portfolioApi.get(id as string),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (q) => (isTerminalStatus(q.state.data?.status) ? false : PORTFOLIO_POLL_MS),
  });

  const job = useJobLifecycle(id);
  useEffect(() => {
    if (!job || !id) return;
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
