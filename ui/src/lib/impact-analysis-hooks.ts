/**
 * TanStack Query hooks + query keys for impact analyses — Epic #159 (#166).
 *
 * Consolidated here so the list (#166), create (#164) and detail (#165) views
 * share cache keys and invalidation. A running analysis is polled until it
 * reaches a terminal state.
 */
"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateImpactAnalysisInput,
  ImpactAnalysisDetail,
  ImpactAnalysisSummary,
  ImpactDriftReport,
  ImpactTableFeedbackInput,
  ImpactTableFeedbackView,
} from "@metis/shared";
import { impactAnalysisApi, type ImpactRerunResponse } from "@/lib/impact-analysis-api";
import { fetchCrossProjectImpact } from "@/lib/cross-project-api";
import { useAppMutation } from "@/lib/use-app-mutation";
import { useJobLifecycle } from "@/hooks/use-job-events";

export const impactAnalysisKeys = {
  all: ["impact-analyses"] as const,
  list: () => [...impactAnalysisKeys.all, "list"] as const,
  /** #61 — under `list()`, so invalidating the list refreshes every project's too. */
  projectList: (projectId: string) => [...impactAnalysisKeys.list(), projectId] as const,
  detail: (id: string) => [...impactAnalysisKeys.all, "detail", id] as const,
  drift: (id: string) => [...impactAnalysisKeys.all, "drift", id] as const,
  usageClassification: (projectId: string) =>
    [...impactAnalysisKeys.all, "usage-classification", projectId] as const,
  crossProjectImpact: (projectId: string) =>
    [...impactAnalysisKeys.all, "cross-project-impact", projectId] as const,
};

/**
 * Epic #292 (#298) — fetch the persisted used/unreferenced/uncertain schema
 * usage classification for one project. `enabled` lets callers defer the fetch
 * until a project is selected.
 */
export function useProjectUsageClassification(projectId: string | null | undefined) {
  return useQuery({
    queryKey: impactAnalysisKeys.usageClassification(projectId ?? ""),
    queryFn: () => impactAnalysisApi.usageClassification(projectId as string),
    enabled: Boolean(projectId),
    retry: false,
  });
}

/**
 * Epic #295 Phase 4 (#309/#310) — fetch the aggregated cross-project impact for
 * one source project: the OTHER projects in the same workspace that also use the
 * project's affected canonical objects. Read-only; `retry: false` so the
 * read-only view degrades to its empty/error state rather than spinning. The
 * result carries `workspaceId` itself, so callers need only the projectId.
 */
export function useCrossProjectImpact(projectId: string | null | undefined) {
  return useQuery({
    queryKey: impactAnalysisKeys.crossProjectImpact(projectId ?? ""),
    queryFn: () => fetchCrossProjectImpact(projectId as string),
    enabled: Boolean(projectId),
    retry: false,
  });
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/**
 * List every impact analysis visible to the caller — or, with `projectId`
 * (#61), only the runs that include that project.
 */
export function useImpactAnalyses(projectId?: string) {
  return useQuery<ImpactAnalysisSummary[]>({
    queryKey: projectId ? impactAnalysisKeys.projectList(projectId) : impactAnalysisKeys.list(),
    queryFn: () => impactAnalysisApi.list(projectId),
    retry: false,
  });
}

/**
 * Fetch one analysis. #240 — driven by push: the unified job-lifecycle socket
 * events invalidate this query on each transition. Polling (every 2s) is KEPT
 * as a degraded fallback for when the socket is disconnected.
 */
export function useImpactAnalysis(id: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery<ImpactAnalysisDetail>({
    queryKey: impactAnalysisKeys.detail(id ?? ""),
    queryFn: () => impactAnalysisApi.get(id as string),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : 2000;
    },
  });

  // #240 — impact analysis is cross-project so the server emits on `job:{id}`.
  const job = useJobLifecycle(id);
  useEffect(() => {
    if (!job || !id) return;
    void queryClient.invalidateQueries({ queryKey: impactAnalysisKeys.detail(id) });
    if (job.status === "completed" || job.status === "failed") {
      void queryClient.invalidateQueries({ queryKey: impactAnalysisKeys.list() });
    }
  }, [job, id, queryClient]);

  return query;
}

/** Trigger a new multi-project impact analysis and refresh the list. */
export function useCreateImpactAnalysis() {
  // #241 — surface success/error toasts; #242 — invalidate the list on success.
  return useAppMutation({
    mutationFn: (input: CreateImpactAnalysisInput) => impactAnalysisApi.create(input),
    successMessage: "Impact analysis started",
    invalidateKeys: [impactAnalysisKeys.list()],
  });
}

/**
 * Issue #966 — mark (or re-mark) an affected-table row relevant/not-relevant.
 * No success toast (a thumbs click is its own feedback); refetches the
 * analysis detail so the mark + "who marked it" render immediately. v1 is
 * CAPTURE-ONLY — this never touches the engine/filter, only the read view.
 */
export function useMarkTableFeedback(analysisId: string | null | undefined) {
  return useAppMutation<ImpactTableFeedbackView, { itemId: string } & ImpactTableFeedbackInput>({
    mutationFn: ({ itemId, ...input }) =>
      impactAnalysisApi.markTableFeedback(analysisId as string, itemId, input),
    successMessage: false,
    invalidateKeys: analysisId ? [impactAnalysisKeys.detail(analysisId)] : [],
  });
}

/** Issue #966 — remove a feedback mark (toggle off). */
export function useDeleteTableFeedback(analysisId: string | null | undefined) {
  return useAppMutation<void, { itemId: string; feedbackId: string }>({
    mutationFn: ({ itemId, feedbackId }) =>
      impactAnalysisApi.deleteTableFeedback(analysisId as string, itemId, feedbackId),
    successMessage: false,
    invalidateKeys: analysisId ? [impactAnalysisKeys.detail(analysisId)] : [],
  });
}

/**
 * Issue #965 — re-run a completed analysis against the current code graph. On
 * success the list refreshes (the new re-run row appears) so the caller can
 * navigate to it and watch it complete.
 */
export function useRerunImpactAnalysis() {
  return useAppMutation<ImpactRerunResponse, { id: string }>({
    mutationFn: ({ id }) => impactAnalysisApi.rerun(id),
    successMessage: "Re-run started",
    invalidateKeys: [impactAnalysisKeys.list()],
  });
}

/**
 * Issue #965 — the drift report for a run vs the original it re-executes. Only
 * enabled once the run has completed AND is itself a re-run (`rerunOfId` set);
 * an original run has no drift to show. `retry: false` so the read-only view
 * degrades to empty rather than spinning.
 */
export function useImpactDrift(id: string | null | undefined, enabled: boolean) {
  return useQuery<ImpactDriftReport>({
    queryKey: impactAnalysisKeys.drift(id ?? ""),
    queryFn: () => impactAnalysisApi.drift(id as string),
    enabled: Boolean(id) && enabled,
    retry: false,
  });
}
